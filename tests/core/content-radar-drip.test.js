import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRadar } from '../../src/core/engine.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { TelegramOutput } from '../../src/outputs/telegram.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import { jsonResponse, noDelay, sequenceFetch } from '../outputs/test-helpers.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1_000;
// A scan claim lasts at least one attempt lease; this lands just past it for the single-source engines below.
const SCAN_CLAIM_EXPIRY_MS = new ContentRadar().options.attemptTimeoutMs + 1_000;

const article = {
  id: 'drip-1',
  title: 'Drip survives failure',
  url: 'https://example.com/drip',
  content: 'Details',
  source: 'Example',
};

function story(id, title) {
  return { id, title, url: `https://example.com/${id}`, content: '', source: 'Example' };
}

function mutableClock(start = '2026-07-20T08:00:00.000Z') {
  let current = new Date(start);
  return {
    clock: () => new Date(current),
    advance(ms) { current = new Date(current.getTime() + ms); },
    set(value) { current = new Date(value); },
  };
}

function radar({ store, source, output = new RecordingOutput(), ai = new RecordingAI('hook'), options = {} }) {
  return new ContentRadar()
    .addSource(source)
    .useAI(ai)
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, ...options });
}

const manualFailure = {
  success: false,
  meta: { deliveryState: 'definitive_failure', retryDisposition: 'manual', sanitizedError: 'rejected' },
};

const automaticFailure = {
  success: false,
  meta: {
    deliveryState: 'definitive_failure',
    retryDisposition: 'automatic',
    retryAfterMs: 0,
    sanitizedError: 'temporary rejection',
  },
};

test('drip keeps a failed item durably blocked instead of shifting it away', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const engine = radar({
    store,
    source: new RecordingSource([article]),
    output: new RecordingOutput({ results: [manualFailure] }),
  });

  const result = await engine.runDrip({ batchSize: 1, requestId: 'drip-run-1' });
  assert.equal(result.status, 'failed');
  const queue = await engine.getQueue({ publishingDay: result.publishingDay });
  assert.equal(queue.remaining, 1);
  assert.equal(queue.blocked, 1);
  assert.equal(queue.articles[0].state, 'blocked');
});

test('a blocked drip item does not starve a later runnable item once the next scan is due', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const output = new RecordingOutput({ results: [manualFailure] });
  const engine = radar({
    store,
    source: new RecordingSource([article, story('drip-later', 'Later item')]),
    output,
    options: { clock: time.clock },
  });

  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'blocked-first' })).status, 'failed');
  const early = await engine.runDrip({ batchSize: 1, requestId: 'rerun-before-interval' });
  assert.equal(early.status, 'skipped');
  assert.equal(early.reason, 'refill_not_due');

  time.advance(SCAN_INTERVAL_MS);
  const later = await engine.runDrip({ batchSize: 1, requestId: 'later-runnable' });
  assert.equal(later.status, 'success');
  assert.equal(later.articles[0].article, 'Later item');
  assert.equal(output.calls.length, 2);
  const queue = await engine.getQueue({ publishingDay: later.publishingDay });
  assert.equal(queue.remaining, 1);
  assert.equal(queue.blocked, 1);
});

test('drip preview is mode-aware and does not create a day batch', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const engine = radar({ store, source: new RecordingSource([article]), output });
  const result = await engine.runDrip({ dryRun: true, batchSize: 1, requestId: 'drip-preview' });
  assert.equal(result.status, 'dry_run');
  assert.equal(output.calls.length, 0);
  assert.equal((await store.list('day_batches')).length, 0);
  assert.equal((await store.list('deliveries')).length, 0);
});

test('drip scans again on a later run and posts newly published content', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  assert.equal((await engine.runDrip({ batchSize: 1 })).status, 'success');
  source.articles = [article, story('k8s-140', 'Kubernetes 1.40 ships sidecar containers')];
  time.advance(SCAN_INTERVAL_MS);
  const next = await engine.runDrip({ batchSize: 1 });

  assert.equal(next.status, 'success');
  assert.equal(next.articles[0].article, 'Kubernetes 1.40 ships sidecar containers');
  assert.equal(source.calls, 2);
  assert.equal(output.calls.length, 2);
});

test('drip does not rescan before the scan interval elapses', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article]);
  const engine = radar({ store, source, options: { clock: time.clock } });

  await engine.runDrip({ batchSize: 1 });
  source.articles.push(story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'));
  time.advance(SCAN_INTERVAL_MS - 1);
  const rerun = await engine.runDrip({ batchSize: 1 });

  assert.equal(rerun.status, 'skipped');
  assert.equal(rerun.reason, 'refill_not_due');
  assert.equal(source.calls, 1);
});

test('a healthy scan without new content never exhausts the publishing day', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  await engine.runDrip({ batchSize: 1 });
  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  time.advance(SCAN_INTERVAL_MS);
  const empty = await engine.runDrip({ batchSize: 1 });
  assert.equal(empty.status, 'skipped');
  assert.equal(empty.reason, 'no_articles');
  assert.equal((await store.list('day_batches'))[0].exhausted, false);

  source.articles = [story('rust-190', 'Rust 1.90 stabilizes async closures')];
  source.diagnostic = { status: 'success', articleCount: 1 };
  time.advance(SCAN_INTERVAL_MS);
  const later = await engine.runDrip({ batchSize: 1 });
  assert.equal(later.status, 'success');
  assert.equal(output.calls.length, 2);
});

test('each scan enqueues only the open batch slots', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([
    story('pg-18', 'PostgreSQL 18 adds asynchronous I/O'),
    story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'),
    story('rust-190', 'Rust 1.90 stabilizes async closures'),
  ]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  const first = await engine.runDrip({ batchSize: 1 });
  assert.equal(first.articles[0].article, 'PostgreSQL 18 adds asynchronous I/O');
  assert.equal((await store.list('batch_items')).length, 1);
  assert.equal((await store.list('deliveries')).length, 1);

  time.advance(SCAN_INTERVAL_MS);
  const second = await engine.runDrip({ batchSize: 1 });
  assert.equal(second.articles[0].article, 'Kubernetes 1.40 ships sidecar containers');
  assert.equal((await store.list('batch_items')).length, 2);
  assert.equal(output.calls.length, 2);
});

test('the daily limit stops scanning once reached', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([
    story('pg-18', 'PostgreSQL 18 adds asynchronous I/O'),
    story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'),
    story('rust-190', 'Rust 1.90 stabilizes async closures'),
  ]);
  const engine = radar({ store, source, options: { clock: time.clock } });

  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).status, 'success');
  time.advance(SCAN_INTERVAL_MS);
  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).status, 'success');
  time.advance(SCAN_INTERVAL_MS);
  const capped = await engine.runDrip({ batchSize: 1, dailyLimit: 2 });

  assert.equal(capped.status, 'skipped');
  assert.equal(capped.reason, 'daily_limit_reached');
  assert.equal(source.calls, 2);
});

test('a scan with no healthy source fails, backs off, and recovers', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([], { status: 'failed', articleCount: 0, failureType: 'transport' });
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  const failed = await engine.runDrip({ batchSize: 1 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'sources_failed');
  assert.equal((await store.list('day_batches'))[0].refillFailureCount, 1);

  time.advance(30_000);
  const backoff = await engine.runDrip({ batchSize: 1 });
  assert.equal(backoff.reason, 'refill_backoff');
  assert.equal(source.calls, 1);

  time.advance(30_000);
  source.articles = [article];
  source.diagnostic = { status: 'success', articleCount: 1 };
  const recovered = await engine.runDrip({ batchSize: 1 });
  assert.equal(recovered.status, 'success');
  assert.equal(output.calls.length, 1);
});

test('a partially degraded scan still posts healthy content without backoff', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const healthy = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const failing = new RecordingSource([], { status: 'failed', articleCount: 0, failureType: 'transport' });
  Object.defineProperty(failing, 'id', { get: () => 'failing-source' });
  const engine = new ContentRadar()
    .addSource(healthy)
    .addSource(failing)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock: time.clock });

  const result = await engine.runDrip({ batchSize: 1 });
  const [batch] = await store.list('day_batches');

  assert.equal(result.status, 'success');
  assert.equal(result.sourceHealth.degraded, true);
  assert.equal(batch.refillFailureCount, 0);
  assert.equal(batch.nextRefillAt, '2026-07-20T08:15:00.000Z');
});

test('a scan skips stories already delivered today, including links shared by other sources', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([{
    id: 'openai-blog',
    title: 'OpenAI launches GPT-5.5 with lower inference latency',
    url: 'https://openai.example/gpt-5-5',
    content: '',
    source: 'OpenAI',
  }]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });
  await engine.runDrip({ batchSize: 1 });

  source.articles = [
    {
      id: 'verge',
      title: 'GPT-5.5 is here: what OpenAI changed in its newest model',
      url: 'https://verge.example/gpt-5-5',
      content: '',
      source: 'The Verge',
    },
    {
      id: 'reddit-share',
      title: 'Everyone is talking about this release',
      url: 'https://openai.example/gpt-5-5?utm_source=reddit',
      content: '',
      source: 'Reddit',
    },
    story('pg-18', 'PostgreSQL 18 adds asynchronous I/O'),
  ];
  time.advance(SCAN_INTERVAL_MS);
  const next = await engine.runDrip({ batchSize: 1 });

  assert.equal(next.status, 'success');
  assert.equal(next.articles[0].article, 'PostgreSQL 18 adds asynchronous I/O');
  assert.deepEqual(next.stats.selection, { fetched: 3, fresh: 3, uncovered: 1, relevant: 1, ranked: 1, enqueued: 1 });
  assert.equal(output.calls.length, 2);
});

test('stories delivered on the previous publishing day or by a forced drip are not posted again', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock('2026-07-20T23:50:00.000Z');
  const source = new RecordingSource([story('nvidia-a', 'Nvidia unveils Rubin GPUs at GTC')]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });
  const forced = await engine.runDrip({ force: true, requestId: 'forced-nvidia', idempotencyKey: 'forced-nvidia-key' });
  assert.equal(forced.status, 'success');

  time.set('2026-07-21T00:10:00.000Z');
  source.articles = [
    story('nvidia-b', 'At GTC, Nvidia shows off Rubin architecture'),
    story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'),
  ];
  const next = await engine.runDrip({ batchSize: 1 });

  assert.equal(next.status, 'success');
  assert.equal(next.articles[0].article, 'Kubernetes 1.40 ships sidecar containers');
  assert.equal(output.calls.length, 2);
});

test('only one concurrent run may fetch during a scan claim', async () => {
  class BlockingSource extends RecordingSource {
    get sourceKey() { return 'blocking-source:feed-a'; }
    async fetch() {
      this.calls += 1;
      if (this.blocked) {
        this.onFetch?.();
        await this.blocked;
      }
      return structuredClone(this.articles);
    }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new BlockingSource([article], { status: 'success', articleCount: 1 });
  const engine = radar({ store, source, options: { clock: time.clock } });
  await engine.runDrip({ batchSize: 1, requestId: 'initial-scan' });

  time.advance(SCAN_INTERVAL_MS);
  source.articles = [];
  source.diagnostic = { status: 'empty', articleCount: 0 };
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  source.blocked = new Promise(resolve => { releaseFetch = resolve; });
  source.onFetch = markFetchStarted;

  const first = engine.runDrip({ batchSize: 1, requestId: 'scan-lease-one' });
  await fetchStarted;
  const second = await engine.runDrip({ batchSize: 1, requestId: 'scan-lease-two' });
  assert.equal(second.reason, 'refill_in_flight');
  assert.equal(source.calls, 2);
  releaseFetch();
  const completed = await first;
  assert.equal(completed.reason, 'no_articles');
  assert.equal(source.calls, 2);
});

test('a scan that loses its expired claim mid-fetch creates no deliveries', async () => {
  class GatedSource extends RecordingSource {
    get sourceKey() { return 'shared-source:feed-a'; }
    async fetch() {
      this.calls += 1;
      if (this.blocked) {
        this.onFetch?.();
        await this.blocked;
      }
      return structuredClone(this.articles);
    }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const slow = new GatedSource([article]);
  const fast = new GatedSource([]);
  const slowOutput = new RecordingOutput({ key: 'telegram:shared-radar' });
  const fastOutput = new RecordingOutput({ key: 'telegram:shared-radar' });
  const slowEngine = radar({ store, source: slow, output: slowOutput, options: { clock: time.clock } });
  const fastEngine = radar({ store, source: fast, output: fastOutput, options: { clock: time.clock } });
  await slowEngine.runDrip({ batchSize: 1, requestId: 'initial-scan' });

  time.advance(SCAN_INTERVAL_MS);
  slow.articles = [{ ...story('k8s-slow', 'Kubernetes 1.40 ships sidecar containers') }];
  fast.articles = [{ ...story('k8s-fast', 'Kubernetes 1.40 ships sidecar containers'), url: 'https://mirror.example/k8s-140' }];
  let releaseSlow;
  let markSlowStarted;
  const slowStarted = new Promise(resolve => { markSlowStarted = resolve; });
  slow.blocked = new Promise(resolve => { releaseSlow = resolve; });
  slow.onFetch = markSlowStarted;

  const lateScan = slowEngine.runDrip({ batchSize: 1, requestId: 'late-scan' });
  await slowStarted;
  time.advance(SCAN_CLAIM_EXPIRY_MS);
  const takeover = await fastEngine.runDrip({ batchSize: 1, requestId: 'takeover-scan' });
  assert.equal(takeover.status, 'success');
  releaseSlow();
  const late = await lateScan;

  assert.equal(late.status, 'skipped');
  assert.equal(late.reason, 'refill_claim_lost');
  assert.equal((await store.list('deliveries')).length, 2);
  assert.equal(slowOutput.calls.length + fastOutput.calls.length, 2);
});

test('source topology drift resets scan backoff', async () => {
  class MutableTopologySource extends RecordingSource {
    constructor(...args) { super(...args); this.topology = 'feed-a'; }
    get sourceKey() { return `mutable-source:${this.topology}`; }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new MutableTopologySource([article], { status: 'success', articleCount: 1 });
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  await engine.runDrip({ batchSize: 1, requestId: 'topology-initial' });
  time.advance(SCAN_INTERVAL_MS);
  source.articles = [];
  source.diagnostic = { status: 'failed', articleCount: 0, failureType: 'transport' };
  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'topology-failed' })).reason, 'sources_failed');

  source.topology = 'feed-b';
  source.articles = [story('drip-2', 'Rust 1.90 stabilizes async closures')];
  source.diagnostic = { status: 'success', articleCount: 1 };
  const refreshed = await engine.runDrip({ batchSize: 1, requestId: 'topology-refreshed' });
  assert.equal(refreshed.status, 'success');
  assert.equal(source.calls, 3);
  assert.equal(output.calls.length, 2);
});

test('source selection policy drift resets scan backoff', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock, maxArticlesPerSource: 1 } });
  await engine.runDrip({ batchSize: 1, requestId: 'selection-initial' });

  time.advance(SCAN_INTERVAL_MS);
  source.articles = [];
  source.diagnostic = { status: 'failed', articleCount: 0, failureType: 'transport' };
  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'selection-failed' })).reason, 'sources_failed');

  source.articles = [story('selection-new', 'Rust 1.90 stabilizes async closures')];
  source.diagnostic = { status: 'success', articleCount: 1 };
  engine.configure({ channelId: 'telegram-main', maxRetries: 0, clock: time.clock, maxArticlesPerSource: 2 });
  const refreshed = await engine.runDrip({ batchSize: 1, requestId: 'selection-refreshed' });
  assert.equal(refreshed.status, 'success');
  assert.equal(source.calls, 3);
  assert.equal(output.calls.length, 2);
});

test('restart adopts initial same-day deliveries persisted before batch linkage', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const clock = () => new Date('2026-07-20T08:00:00.000Z');
  const interrupted = radar({ store, source, options: { clock } });
  const machine = await interrupted._ensureMachine();
  const prepared = await interrupted._prepareArticles({ force: false, dryRun: false });
  await interrupted._prepareDripDeliveries(machine, prepared.articles, '2026-07-20');
  assert.equal((await store.list('deliveries')).length, 1);
  assert.equal((await store.list('batch_items')).length, 0);

  const recoveredOutput = new RecordingOutput();
  const recovered = radar({ store, source, output: recoveredOutput, options: { clock } });
  const result = await recovered.runDrip({ batchSize: 1, requestId: 'recover-initial-orphan' });
  assert.equal(result.status, 'success');
  assert.equal(source.calls, 1);
  assert.equal(recoveredOutput.calls.length, 1);
  assert.equal((await store.list('batch_items')).length, 1);
});

test('restart adopts scan deliveries persisted before linkage and closes the expired claim', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article], { status: 'success', articleCount: 1 });
  const initial = radar({ store, source, options: { clock: time.clock } });
  await initial.runDrip({ batchSize: 1, requestId: 'scan-orphan-initial' });

  time.advance(SCAN_INTERVAL_MS);
  const machine = await initial._ensureMachine();
  const batch = (await store.list('day_batches'))[0];
  const claim = await machine.claimBatchRefill({
    batchId: batch.batchId,
    sourceTopologyFingerprint: batch.sourceTopologyFingerprint,
  });
  source.articles = [story('scan-orphan', 'Rust 1.90 stabilizes async closures')];
  const scanned = await initial._prepareArticles({ force: false, dryRun: false });
  await initial._prepareDripDeliveries(machine, scanned.articles, '2026-07-20');
  assert.equal(claim.status, 'claimed');
  assert.equal((await store.list('deliveries')).length, 2);
  assert.equal((await store.list('batch_items')).length, 1);

  time.advance(SCAN_CLAIM_EXPIRY_MS);
  const recoveredOutput = new RecordingOutput();
  const recovered = radar({ store, source, output: recoveredOutput, options: { clock: time.clock } });
  const result = await recovered.runDrip({ batchSize: 1, requestId: 'recover-scan-orphan' });
  assert.equal(result.status, 'success');
  assert.equal(source.calls, 2);
  assert.equal(recoveredOutput.calls.length, 1);
  const recoveredBatch = (await store.list('day_batches'))[0];
  assert.equal(recoveredBatch.activeRefillClaimToken, null);
  assert.equal((await store.list('batch_items')).length, 2);
});

test('an automatically retrying item that fills the batch skips scanning', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article]);
  const output = new RecordingOutput({ results: [automaticFailure] });
  const engine = radar({ store, source, output, options: { clock: time.clock } });

  assert.equal((await engine.runDrip({ batchSize: 1 })).status, 'failed');
  source.articles.push(story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'));
  time.advance(SCAN_INTERVAL_MS);
  const retried = await engine.runDrip({ batchSize: 1 });

  assert.equal(retried.status, 'success');
  assert.equal(retried.articles[0].article, 'Drip survives failure');
  assert.equal(source.calls, 1);
  assert.equal(output.calls.length, 2);
});

test('repeated Telegram connect failures exhaust one item without blocking the channel', async () => {
  const refused = () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }),
    });
  };
  const transport = sequenceFetch([refused, refused, refused, jsonResponse(200, { ok: true, result: { message_id: 9 } })]);
  const output = new TelegramOutput({
    botToken: '123456:test-token',
    chatId: '-1001',
    fetch: transport.fetch,
    sleep: noDelay,
  });
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article]);
  const engine = radar({ store, source, output, options: { clock: time.clock } });
  const machine = new DeliveryStateMachine({ store, channelId: 'telegram-main' });

  // Every run retries the same item automatically; the third failed attempt exhausts it.
  for (const requestId of ['connect-1', 'connect-2', 'connect-3']) {
    assert.equal((await engine.runDrip({ batchSize: 1, requestId })).status, 'failed');
    assert.equal((await machine.getChannelState()).mutationState, 'free');
    time.advance(SCAN_INTERVAL_MS);
  }
  assert.equal((await store.list('deliveries'))[0].state, 'output_exhausted');

  // The exhausted item waits for an operator, and the next scan still posts newer content.
  source.articles = [article, story('later', 'Later item')];
  const later = await engine.runDrip({ batchSize: 1, requestId: 'connect-4' });
  assert.equal(later.status, 'success');
  assert.equal(later.articles[0].article, 'Later item');
  assert.equal(transport.calls.length, 4);
});

test('a scan error after claiming still delivers queued items and backs off', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([article]);
  const output = new RecordingOutput({ results: [automaticFailure] });
  let explode = false;
  const engine = radar({ store, source, output, options: { clock: time.clock } })
    .use(function selectionProbe(articles) {
      if (explode) throw new Error('selection exploded');
      return articles;
    });

  assert.equal((await engine.runDrip({ batchSize: 2 })).status, 'failed');
  explode = true;
  time.advance(SCAN_INTERVAL_MS);
  const delivered = await engine.runDrip({ batchSize: 2 });
  const [batch] = await store.list('day_batches');

  assert.equal(delivered.status, 'success');
  assert.equal(delivered.articles[0].article, 'Drip survives failure');
  assert.match(delivered.scanError, /selection exploded/);
  const scanLog = logged.mock.calls.find(call => call.arguments[0] === '[Radar] Scan failed');
  assert.ok(scanLog, 'scan failures are logged');
  assert.equal(scanLog.arguments[1].channelId, 'telegram-main');
  assert.match(scanLog.arguments[1].error, /selection exploded/);
  assert.equal(batch.refillFailureCount, 1);
  assert.equal(batch.activeRefillClaimToken, null);
  assert.equal(batch.nextRefillAt, '2026-07-20T08:16:00.000Z');

  time.advance(60_000);
  const failed = await engine.runDrip({ batchSize: 2 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'scan_failed');
  assert.equal(output.calls.length, 2);
});

test('a story forced out while a scan is fetching is not posted again by that scan', async () => {
  class GatedSource extends RecordingSource {
    get sourceKey() { return 'gated-source:feed-a'; }
    async fetch() {
      this.calls += 1;
      if (this.blocked) {
        this.onFetch?.();
        await this.blocked;
      }
      return structuredClone(this.articles);
    }
  }

  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const gated = new GatedSource([story('nvidia-b', 'At GTC, Nvidia shows off Rubin architecture')]);
  const scanOutput = new RecordingOutput({ key: 'telegram:shared-radar' });
  const forcedOutput = new RecordingOutput({ key: 'telegram:shared-radar' });
  const scanEngine = radar({ store, source: gated, output: scanOutput, options: { clock: time.clock } });
  const forcedEngine = radar({
    store,
    source: new RecordingSource([story('nvidia-a', 'Nvidia unveils Rubin GPUs at GTC')]),
    output: forcedOutput,
    options: { clock: time.clock },
  });
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  gated.blocked = new Promise(resolve => { release = resolve; });
  gated.onFetch = markStarted;

  const scan = scanEngine.runDrip({ batchSize: 1 });
  await started;
  const forced = await forcedEngine.runDrip({
    force: true,
    requestId: 'forced-during-scan',
    idempotencyKey: 'forced-during-scan-key',
  });
  assert.equal(forced.status, 'success');
  release();
  const result = await scan;

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_articles');
  assert.equal(scanOutput.calls.length, 0);
  assert.equal((await store.list('deliveries')).length, 1);
});

test('story coverage looks back one calendar publishing day across DST changes', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  // 2026-11-01 is the 25-hour fall-back day in America/New_York.
  const time = mutableClock('2026-10-31T16:00:00.000Z');
  const source = new RecordingSource([story('nvidia-a', 'Nvidia unveils Rubin GPUs at GTC')]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, options: { clock: time.clock, timezone: 'America/New_York' } });
  assert.equal((await engine.runDrip({ batchSize: 1 })).publishingDay, '2026-10-31');

  time.set('2026-11-02T04:30:00.000Z');
  source.articles = [story('nvidia-b', 'At GTC, Nvidia shows off Rubin architecture')];
  const late = await engine.runDrip({ batchSize: 1 });

  assert.equal(late.publishingDay, '2026-11-01');
  assert.equal(late.status, 'skipped');
  assert.equal(late.reason, 'no_articles');
  assert.equal(output.calls.length, 1);
});

test('preview and forced drips ignore radar-only scan settings', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const engine = radar({ store, source: new RecordingSource([article]) });

  const preview = await engine.runDrip({ dryRun: true, batchSize: 1, dailyLimit: 0, scanIntervalMinutes: 0 });
  assert.equal(preview.status, 'dry_run');
  const forced = await engine.runDrip({
    force: true,
    requestId: 'forced-ignores-scan-policy',
    idempotencyKey: 'forced-ignores-scan-policy-key',
    dailyLimit: 0,
  });
  assert.equal(forced.status, 'success');
  await assert.rejects(engine.runDrip({ batchSize: 1, dailyLimit: 0 }), /dailyLimit must be an integer in range 1-500/);
});

test('a source identity collision fails only that source', async () => {
  class CollidingSource extends RecordingSource {
    get id() { return 'colliding-source'; }
  }
  const store = new MemoryDeliveryStore({ durable: true });
  const healthy = new RecordingSource([story('pg-18', 'PostgreSQL 18 adds asynchronous I/O')]);
  const colliding = new CollidingSource([
    story('same-id', 'Kubernetes 1.40 ships sidecar containers'),
    { ...story('same-id', 'Rust 1.90 stabilizes async closures') },
  ]);
  const makeEngine = () => new ContentRadar()
    .addSource(healthy)
    .addSource(colliding)
    .useAI(new RecordingAI('hook'))
    .addOutput(new RecordingOutput())
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0 });

  const drip = await makeEngine().runDrip({ batchSize: 2 });
  assert.equal(drip.status, 'success');
  assert.deepEqual(drip.articles.map(item => item.article), ['PostgreSQL 18 adds asynchronous I/O']);
  const collision = drip.sourceHealth.diagnostics.find(value => value.sourceId === 'colliding-source');
  assert.equal(collision.status, 'failed');
  assert.equal(collision.failureType, 'identity_collision');

  const preview = await makeEngine().run({ dryRun: true });
  assert.equal(preview.status, 'dry_run');
  assert.equal(preview.sourceHealth.failed, 1);
});

test('the daily limit counts adopted orphans for today but not prior-day carryover', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const source = new RecordingSource([
    story('pg-18', 'PostgreSQL 18 adds asynchronous I/O'),
    story('k8s-140', 'Kubernetes 1.40 ships sidecar containers'),
  ]);
  const output = new RecordingOutput({ results: [automaticFailure] });
  const engine = radar({ store, source, output, options: { clock: time.clock } });
  const machine = await engine._ensureMachine();
  const prepared = await engine._prepareArticles({ force: false, dryRun: false });
  await engine._prepareDripDeliveries(machine, prepared.articles, '2026-07-20');

  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).status, 'failed');
  time.advance(SCAN_INTERVAL_MS);
  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).status, 'success');
  time.advance(SCAN_INTERVAL_MS);
  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).status, 'success');
  time.advance(SCAN_INTERVAL_MS);
  assert.equal((await engine.runDrip({ batchSize: 1, dailyLimit: 2 })).reason, 'daily_limit_reached');
  assert.equal(source.calls, 1);

  const carryOutput = new RecordingOutput({ results: [automaticFailure] });
  const carryStore = new MemoryDeliveryStore({ durable: true });
  const carrySource = new RecordingSource([article]);
  const carryTime = mutableClock('2026-07-20T20:00:00.000Z');
  const carry = radar({ store: carryStore, source: carrySource, output: carryOutput, options: { clock: carryTime.clock } });
  assert.equal((await carry.runDrip({ batchSize: 1, dailyLimit: 1 })).status, 'failed');
  carryTime.set('2026-07-21T08:00:00.000Z');
  assert.equal((await carry.runDrip({ batchSize: 1, dailyLimit: 1 })).articles[0].carriedFromPublishingDay, '2026-07-20');
  carrySource.articles = [story('rust-190', 'Rust 1.90 stabilizes async closures')];
  const fresh = await carry.runDrip({ batchSize: 1, dailyLimit: 1 });
  assert.equal(fresh.status, 'success');
  assert.equal(fresh.articles[0].article, 'Rust 1.90 stabilizes async closures');
});

test('forced drip replay blocks same-provider destination drift before mutation', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const failedOutput = new RecordingOutput({ key: 'recording:destination-a', results: [manualFailure] });
  const initial = radar({ store, source: new RecordingSource([article]), output: failedOutput });
  const first = await initial.runDrip({
    force: true,
    requestId: 'forced-topology-replay',
    idempotencyKey: 'forced-topology-key',
  });
  assert.equal(first.status, 'failed');

  const changedOutput = new RecordingOutput({ key: 'recording:destination-b' });
  const resumed = radar({
    store,
    source: new RecordingSource([article]),
    output: changedOutput,
    ai: new RecordingAI('must-not-regenerate'),
  });
  const replay = await resumed.runDrip({
    force: true,
    requestId: 'forced-topology-replay',
    idempotencyKey: 'forced-topology-key',
  });
  assert.equal(replay.status, 'failed');
  assert.equal(replay.reason, 'output_topology_changed');
  assert.equal(changedOutput.calls.length, 0);
});

test('forced drip uses a transient delivery and leaves the normal day batch unchanged', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const engine = radar({ store, source: new RecordingSource([article]), output });

  assert.equal((await engine.runDrip({ batchSize: 1, requestId: 'normal-drip' })).status, 'success');
  const batchBefore = (await store.list('day_batches'))[0];
  const itemsBefore = await store.list('batch_items');

  const forced = await engine.runDrip({
    force: true,
    requestId: 'forced-drip',
    idempotencyKey: 'forced-drip-key',
  });

  assert.equal(forced.status, 'success');
  assert.equal(output.calls.length, 2);
  assert.equal((await store.list('deliveries')).length, 2);
  assert.deepEqual(await store.list('day_batches'), [batchBefore]);
  assert.deepEqual(await store.list('batch_items'), itemsBefore);
});

test('paused operator canary forwards the single-mutation guard without creating backlog', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const machine = new DeliveryStateMachine({ store, channelId: 'telegram-main', allowEphemeral: true });
  await machine.setPaused(true, {
    expectedVersion: 1,
    idempotencyKey: 'pause-before-canary',
    operatorId: 'test-operator',
    reason: 'offline canary test',
  });
  const output = new RecordingOutput();
  const engine = radar({ store, source: new RecordingSource([article]), output });

  const result = await engine.runDrip({
    force: true,
    operatorForce: true,
    confirmPausedMutation: true,
    singleMutation: true,
    requestId: 'canary-request',
    idempotencyKey: 'canary-key',
  });

  assert.equal(result.status, 'success');
  assert.equal(output.calls.length, 1);
  assert.equal(output.calls[0].options.singleMutation, true);
  assert.equal((await store.list('day_batches')).length, 0);
  assert.equal((await store.list('batch_items')).length, 0);
});

test('next-day drip resumes prior-day retryable delivery before fetching a new batch', async () => {
  let now = new Date('2026-07-20T08:00:00.000Z');
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const ai = new RecordingAI('stored hook');
  const output = new RecordingOutput({
    results: [
      automaticFailure,
      {
        success: true,
        messageId: 'recovered-message',
        meta: { deliveryState: 'success', retryDisposition: 'never' },
      },
    ],
  });
  const engine = radar({ store, source, output, ai, options: { clock: () => new Date(now) } });

  assert.equal((await engine.runDrip({ batchSize: 1 })).status, 'failed');
  now = new Date('2026-07-21T08:00:00.000Z');
  const recovered = await engine.runDrip({ batchSize: 1 });

  assert.equal(recovered.status, 'success');
  assert.equal(recovered.articles[0].carriedFromPublishingDay, '2026-07-20');
  assert.equal(source.calls, 1);
  assert.equal(ai.calls.length, 1);
  assert.equal(output.calls.length, 2);
});

test('exact forced-drip replay stays bound to its persisted article selection', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const output = new RecordingOutput();
  const engine = radar({ store, source, output, ai: new RecordingAI('forced hook') });
  const options = {
    force: true,
    requestId: 'stable-force-request',
    idempotencyKey: 'stable-force-key',
  };

  const first = await engine.runDrip(options);
  source.articles = [{
    ...article,
    id: 'drip-2',
    title: 'Different article after replay',
    url: 'https://example.com/drip-2',
  }];
  const replay = await engine.runDrip(options);

  assert.equal(first.deliveryId, replay.deliveryId);
  assert.equal(output.calls.length, 1);
  assert.equal(source.calls, 1);
  assert.equal((await store.list('deliveries')).length, 1);
});

test('old forced-drip replay uses a compact tombstone without refetching or resending', async () => {
  let now = new Date('2026-07-20T08:00:00.000Z');
  const store = new MemoryDeliveryStore({ durable: true });
  const source = new RecordingSource([article]);
  const output = new RecordingOutput();
  const engine = radar({
    store,
    source,
    output,
    ai: new RecordingAI('private forced hook'),
    options: { clock: () => new Date(now) },
  });
  const options = {
    force: true,
    requestId: 'retained-force-request',
    idempotencyKey: 'retained-force-key',
  };

  assert.equal((await engine.runDrip(options)).status, 'success');
  now = new Date('2026-08-22T08:00:00.000Z');
  const replay = await engine.runDrip(options);

  assert.equal(replay.status, 'success');
  assert.equal(replay.reason, 'already_complete');
  assert.equal(source.calls, 1);
  assert.equal(output.calls.length, 1);
  const [tombstone] = await store.list('deliveries');
  assert.equal(tombstone.compacted, true);
  assert.equal(tombstone.generatedContent, undefined);
  assert.equal(tombstone.articleSnapshot, undefined);
  assert.deepEqual(await store.list('delivery_outputs'), []);
  assert.deepEqual(await store.list('attempts'), []);
});

test('concurrent first drip runs fetch once and link every prepared delivery', async () => {
  class BarrierSource extends RecordingSource {
    async fetch() {
      this.calls += 1;
      if (this.blocked) {
        this.onFetch?.();
        await this.blocked;
      }
      return structuredClone(this.articles);
    }
  }
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const outputA = new RecordingOutput({ key: 'telegram:shared-drip' });
  const outputB = new RecordingOutput({ key: 'telegram:shared-drip' });
  const sourceA = new BarrierSource([article]);
  const sourceB = new BarrierSource([story('drip-concurrent-b', 'Kubernetes 1.40 ships sidecar containers')]);
  const engineA = radar({ store, source: sourceA, output: outputA, options: { clock: time.clock } });
  const engineB = radar({ store, source: sourceB, output: outputB, options: { clock: time.clock } });
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  sourceA.blocked = new Promise(resolve => { release = resolve; });
  sourceA.onFetch = markStarted;

  const first = engineA.runDrip({ batchSize: 1 });
  await started;
  const second = await engineB.runDrip({ batchSize: 1 });
  assert.equal(second.reason, 'refill_in_flight');
  assert.equal(sourceB.calls, 0);
  release();
  assert.equal((await first).status, 'success');
  assert.equal((await store.list('deliveries')).length, 1);
  assert.equal((await store.list('batch_items')).length, 1);

  time.advance(SCAN_INTERVAL_MS);
  assert.equal((await engineB.runDrip({ batchSize: 1 })).status, 'success');
  assert.equal((await store.list('deliveries', value => value.state === 'succeeded')).length, 2);
  assert.equal(outputA.calls.length + outputB.calls.length, 2);
});
