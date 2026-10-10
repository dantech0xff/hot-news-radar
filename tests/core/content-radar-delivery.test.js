import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRadar } from '../../src/core/engine.js';
import { MemoryCache } from '../../src/core/caches.js';
import { opaqueId } from '../../src/core/delivery.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { TelegramOutput } from '../../src/outputs/telegram.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import { jsonResponse, noDelay, sequenceFetch } from '../outputs/test-helpers.js';

const article = {
  id: 'article-1',
  title: 'Truthful delivery',
  url: 'https://example.com/truthful',
  content: 'Details',
  source: 'Example',
};

function engine({ outputs = [new RecordingOutput()], store = new MemoryDeliveryStore({ durable: true }), cache = new MemoryCache() } = {}) {
  const source = new RecordingSource([article]);
  const ai = new RecordingAI('generated digest');
  const instance = new ContentRadar()
    .addSource(source)
    .useAI(ai)
    .useCache(cache)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', timezone: 'UTC', maxRetries: 0 });
  outputs.forEach(output => instance.addOutput(output));
  return { instance, source, ai, outputs, store, cache };
}

test('non-dry delivery preflight blocks zero outputs and missing durable store before AI', async () => {
  const source = new RecordingSource([article]);
  const ai = new RecordingAI();
  const noOutputs = new ContentRadar().addSource(source).useAI(ai).useDeliveryStore(new MemoryDeliveryStore({ durable: true }));
  await assert.rejects(noOutputs.run(), /at least one output/i);
  assert.equal(ai.calls.length, 0);

  const output = new RecordingOutput();
  const noStore = new ContentRadar().addSource(source).useAI(ai).addOutput(output);
  await assert.rejects(noStore.run(), /DeliveryStore|durable/i);
  assert.equal(ai.calls.length, 0);
  assert.equal(output.calls.length, 0);
});

test('direct force requires explicit identities before source, AI, output, or state mutation', async () => {
  const runtime = engine();
  await assert.rejects(runtime.instance.run({
    force: true,
    requestId: 'force-without-idempotency',
  }), /idempotencyKey is required/i);
  assert.equal(runtime.source.calls, 0);
  assert.equal(runtime.ai.calls.length, 0);
  assert.equal(runtime.outputs[0].calls.length, 0);
  assert.deepEqual(await runtime.store.list('deliveries'), []);
});

test('ordinary force cannot use the paused canary override and performs no external calls', async () => {
  const runtime = engine();
  const machine = new DeliveryStateMachine({ store: runtime.store, channelId: 'telegram-main' });
  await machine.setPaused(true, {
    expectedVersion: 1,
    idempotencyKey: 'pause-before-force-override-test',
    operatorId: 'ops-key',
    reason: 'offline safety test',
  });

  await assert.rejects(runtime.instance.run({
    force: true,
    requestId: 'ordinary-force-request',
    idempotencyKey: 'ordinary-force-key',
    confirmPausedMutation: true,
  }), /reserved for an operator single-mutation canary/i);
  const skipped = await runtime.instance.run({
    force: true,
    requestId: 'ordinary-force-request',
    idempotencyKey: 'ordinary-force-key',
  });
  assert.equal(skipped.reason, 'channel_paused');
  assert.equal(runtime.source.calls, 0);
  assert.equal(runtime.ai.calls.length, 0);
  assert.equal(runtime.outputs[0].calls.length, 0);
  assert.deepEqual(await runtime.store.list('deliveries'), []);
});

test('ambiguous output does not mark articles complete and returns ambiguous', async () => {
  const output = new RecordingOutput({ results: [new Error('network timeout')] });
  const { instance, store, cache } = engine({ outputs: [output] });
  const result = await instance.run({ requestId: 'digest-request-1' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(output.calls.length, 1);
  const ledger = (await store.list('articles'))[0];
  assert.ok(ledger.activeDeliveryId);
  assert.equal(ledger.terminalState, null);
  assert.equal(await cache.peek(`digest:${result.publishingDay}`), null);
});

test('a Telegram connect failure retries automatically and never blocks the channel', async () => {
  const refused = () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }),
    });
  };
  const transport = sequenceFetch([refused, jsonResponse(200, { ok: true, result: { message_id: 7 } })]);
  const output = new TelegramOutput({
    botToken: '123456:test-token',
    chatId: '-1001',
    fetch: transport.fetch,
    sleep: noDelay,
  });
  let now = new Date('2026-07-20T10:00:00.000Z');
  const { instance, store } = engine({ outputs: [output] });
  instance.configure({ clock: () => new Date(now) });
  const machine = new DeliveryStateMachine({ store, channelId: 'telegram-main' });

  const first = await instance.run({ requestId: 'telegram-connect-failure' });
  assert.equal(first.status, 'failed');
  assert.equal((await machine.getChannelState()).mutationState, 'free');
  assert.equal((await store.list('articles'))[0].terminalState, null);

  now = new Date('2026-07-20T10:00:05.000Z');
  const second = await instance.run({ requestId: 'telegram-connect-failure' });
  assert.equal(second.status, 'success');
  assert.equal(transport.calls.length, 2);
  assert.equal((await store.list('articles'))[0].terminalState, 'succeeded');
});

test('safe partial delivery resumes only unresolved output with stored content', async () => {
  const outputA = new RecordingOutput({ key: 'telegram:a' });
  const outputB = new RecordingOutput({
    key: 'telegram:b',
    results: [
      {
        success: false,
        meta: {
          deliveryState: 'definitive_failure',
          retryDisposition: 'automatic',
          retryAfterMs: 0,
          sanitizedError: 'rate limited',
        },
      },
      {
        success: true,
        messageId: 'message-b',
        meta: { deliveryState: 'success', retryDisposition: 'never' },
      },
    ],
  });
  const { instance, ai, store } = engine({ outputs: [outputA, outputB] });

  const first = await instance.run({ requestId: 'digest-request-partial' });
  assert.equal(first.status, 'partial');
  assert.equal(outputA.calls.length, 1);
  assert.equal(outputB.calls.length, 1);

  const second = await instance.run({ requestId: 'digest-request-partial' });
  assert.equal(second.status, 'success');
  assert.equal(ai.calls.length, 1);
  assert.equal(outputA.calls.length, 1);
  assert.equal(outputB.calls.length, 2);
  assert.equal((await store.list('articles'))[0].terminalState, 'succeeded');
});

test('blocked replay keeps durable partial status after an earlier output succeeded', async () => {
  const outputA = new RecordingOutput({ key: 'telegram:partial-a' });
  const outputB = new RecordingOutput({
    key: 'telegram:partial-b',
    results: [{
      success: false,
      meta: {
        deliveryState: 'definitive_failure',
        retryDisposition: 'manual',
        sanitizedError: 'operator review required',
      },
    }],
  });
  const { instance } = engine({ outputs: [outputA, outputB] });

  assert.equal((await instance.run({ requestId: 'durable-partial' })).status, 'partial');
  const replay = await instance.run({ requestId: 'durable-partial' });

  assert.equal(replay.status, 'partial');
  assert.equal(replay.reason, 'manual_retry_required');
  assert.equal(outputA.calls.length, 1);
  assert.equal(outputB.calls.length, 1);
});

test('dry run performs no durable/cache/output writes', async () => {
  const { instance, store, cache, outputs } = engine();
  const result = await instance.run({ dryRun: true, requestId: 'preview-1' });
  assert.equal(result.status, 'dry_run');
  assert.equal(outputs[0].calls.length, 0);
  assert.equal((await store.list('deliveries')).length, 0);
  assert.equal(cache._store.size, 0);
});

test('duplicate source identities are collapsed before generation', async () => {
  const source = new RecordingSource([
    article,
    { ...article, title: article.title },
  ]);
  const ai = new RecordingAI();
  const output = new RecordingOutput();
  const result = await new ContentRadar()
    .addSource(source)
    .useAI(ai)
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0 })
    .run({ requestId: 'dedup-in-memory' });
  assert.equal(result.status, 'success');
  assert.equal(ai.calls[0].articles.length, 1);
});

test('shared durable store keeps article ownership isolated per channel', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const outputA = new RecordingOutput({ key: 'telegram:channel-a' });
  const outputB = new RecordingOutput({ key: 'telegram:channel-b' });
  const channelA = engine({ outputs: [outputA], store }).instance.configure({
    channelId: 'channel-a',
    maxRetries: 0,
  });
  const channelB = engine({ outputs: [outputB], store }).instance.configure({
    channelId: 'channel-b',
    maxRetries: 0,
  });

  assert.equal((await channelA.run({ requestId: 'channel-a-run' })).status, 'success');
  assert.equal((await channelB.run({ requestId: 'channel-b-run' })).status, 'success');
  assert.equal(outputA.calls.length, 1);
  assert.equal(outputB.calls.length, 1);
  const records = await store.list('articles');
  assert.equal(records.length, 2);
  assert.notEqual(records[0].articleHash, records[1].articleHash);
});

test('provider success followed by state commit failure stays durably attempting and ambiguous', async () => {
  class FailingCommitStore extends MemoryDeliveryStore {
    failNext = false;
    async transact(callback) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('simulated durable commit failure');
      }
      return super.transact(callback);
    }
  }
  const store = new FailingCommitStore({ durable: true });
  const output = new RecordingOutput();
  const originalSend = output.send.bind(output);
  output.send = async (...args) => {
    const result = await originalSend(...args);
    store.failNext = true;
    return result;
  };
  const { instance } = engine({ outputs: [output], store });
  const result = await instance.run({ requestId: 'commit-failure' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'state_commit_failed');
  assert.equal(output.calls.length, 1);
  assert.equal((await store.list('attempts', value => value.kind === 'output'))[0].state, 'attempting');
  assert.equal((await store.list('delivery_outputs'))[0].state, 'attempting');
});

test('same-day concurrent normal digests share one durable reservation and one provider mutation', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const outputA = new RecordingOutput({ key: 'telegram:shared-digest' });
  const outputB = new RecordingOutput({ key: 'telegram:shared-digest' });
  const sourceA = new RecordingSource([article]);
  const sourceB = new RecordingSource([{
    ...article,
    id: 'article-2',
    title: 'Competing digest snapshot',
    url: 'https://example.com/competing',
  }]);
  const makeEngine = (source, output) => new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI('digest'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({
      channelId: 'telegram-main',
      maxRetries: 0,
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
    });

  const results = await Promise.all([
    makeEngine(sourceA, outputA).run({ requestId: 'manual-request' }),
    makeEngine(sourceB, outputB).run({ requestId: 'scheduled-request' }),
  ]);

  assert.equal(results.filter(result => result.status === 'success').length, 1);
  assert.equal(results.filter(result => result.reason === 'digest_in_flight').length, 1);
  assert.equal(outputA.calls.length + outputB.calls.length, 1);
  assert.equal(sourceA.calls + sourceB.calls, 1);
  assert.equal((await store.list('deliveries')).length, 1);
  assert.equal((await store.list('delivery_reservations')).length, 1);
});

test('migrated legacy digest completion suppresses the matching normal publishing day', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  await store.transact(tx => tx.put('legacy_digest_compat', 'legacy-digest-2026-07-20', {
    compatId: 'legacy-digest-2026-07-20',
    channelId: 'telegram-main',
    publishingDay: '2026-07-20',
    importedAt: '2026-07-20T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  const { instance, source, ai, outputs } = engine({ store });
  instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date('2026-07-20T08:00:00.000Z'),
  });

  const result = await instance.run({ requestId: 'normal-after-legacy-migration' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'legacy_digest_complete');
  assert.equal(source.calls, 0);
  assert.equal(ai.calls.length, 0);
  assert.equal(outputs[0].calls.length, 0);
});

test('migrated legacy seen hash remains a direct dual-read dedup guard', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const legacySeenHash = compatibilityHash(article.id);
  const compatId = await opaqueId('legacy-seen-compat', 'telegram-main', legacySeenHash);
  await store.transact(tx => tx.put('legacy_seen_compat', compatId, {
    compatId,
    channelId: 'telegram-main',
    legacyHash: legacySeenHash,
    importedAt: '2026-07-20T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  const { instance, ai, outputs } = engine({ store });
  instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date('2026-07-20T08:00:00.000Z'),
  });

  const result = await instance.run({ requestId: 'normal-with-imported-seen' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_articles');
  assert.equal(ai.calls.length, 0);
  assert.equal(outputs[0].calls.length, 0);
});

test('expired migrated legacy seen compatibility no longer suppresses an article', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const legacySeenHash = compatibilityHash(article.id);
  const compatId = await opaqueId('legacy-seen-compat', 'telegram-main', legacySeenHash);
  await store.transact(tx => tx.put('legacy_seen_compat', compatId, {
    compatId,
    channelId: 'telegram-main',
    legacyHash: legacySeenHash,
    importedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-08T00:00:00.000Z',
  }, { expectedVersion: 0 }));
  const { instance, ai, outputs } = engine({ store });
  instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date('2026-07-20T08:00:00.000Z'),
  });

  const result = await instance.run({ requestId: 'normal-after-legacy-seen-expiry' });
  assert.equal(result.status, 'success');
  assert.equal(ai.calls.length, 1);
  assert.equal(outputs[0].calls.length, 1);
});

test('paused delivery exits before reservations, source reads, AI, or output calls', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const now = '2026-07-20T08:00:00.000Z';
  await store.transact(tx => tx.put('channel_state', 'telegram-main', {
    channelId: 'telegram-main',
    mutationState: 'free',
    activeOutputAttemptId: null,
    paused: true,
    createdAt: now,
    updatedAt: now,
  }, { expectedVersion: 0 }));
  const { instance, source, ai, outputs } = engine({ store });
  instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date(now),
  });

  const result = await instance.run({ requestId: 'paused-digest-must-not-backlog' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'channel_paused');
  assert.equal(source.calls, 0);
  assert.equal(ai.calls.length, 0);
  assert.equal(outputs[0].calls.length, 0);
  assert.deepEqual(await store.list('delivery_reservations'), []);
  assert.deepEqual(await store.list('deliveries'), []);
});

test('normal restart recovers an expired generation claim and safely resumes stored articles', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const firstClock = () => new Date('2026-07-20T08:00:00.000Z');
  const machine = new DeliveryStateMachine({
    store,
    channelId: 'telegram-main',
    clock: firstClock,
    attemptTimeoutMs: 1_000,
  });
  const delivery = await machine.prepareDelivery({
    requestId: 'crashed-generation',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [output],
  });
  assert.equal((await machine.claimGeneration(delivery.deliveryId, { requestId: 'crashed-generation' })).status, 'claimed');

  const restarted = engine({ outputs: [output], store });
  restarted.instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    attemptTimeoutMs: 1_000,
    clock: () => new Date('2026-07-20T08:00:02.000Z'),
  });
  const result = await restarted.instance.run({ requestId: 'restart-after-generation-crash' });

  assert.equal(result.status, 'success');
  assert.equal(restarted.source.calls, 0);
  assert.equal(restarted.ai.calls.length, 1);
  assert.equal(output.calls.length, 1);
  assert.equal((await store.list('attempts')).filter(value => value.state === 'generation_expired').length, 1);
});

test('normal restart converts an expired output claim to ambiguity without resending', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const output = new RecordingOutput();
  const machine = new DeliveryStateMachine({
    store,
    channelId: 'telegram-main',
    clock: () => new Date('2026-07-20T08:00:00.000Z'),
    attemptTimeoutMs: 1_000,
  });
  const delivery = await machine.prepareDelivery({
    requestId: 'crashed-output',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [output],
  });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'crashed-output' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'stored digest' });
  assert.equal((await machine.claimNextOutput(delivery.deliveryId, { requestId: 'crashed-output' })).status, 'claimed');

  const restarted = engine({ outputs: [output], store });
  restarted.instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    attemptTimeoutMs: 1_000,
    clock: () => new Date('2026-07-20T08:00:02.000Z'),
  });
  const result = await restarted.instance.run({ requestId: 'restart-after-output-crash' });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'output_needs_reconciliation');
  assert.equal(restarted.source.calls, 0);
  assert.equal(restarted.ai.calls.length, 0);
  assert.equal(output.calls.length, 0);
  assert.equal((await machine.getOutput(delivery.deliveryId, delivery.outputTopology[0].outputKey)).state, 'needs_reconciliation');
});

test('restart drains pending legacy mirrors before returning an already-complete digest', async () => {
  class FailingCache extends MemoryCache {
    async set() { throw new Error('offline mirror unavailable'); }
  }
  const store = new MemoryDeliveryStore({ durable: true });
  const first = engine({ store, cache: new FailingCache() });
  first.instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date('2026-07-20T08:00:00.000Z'),
  });
  assert.equal((await first.instance.run({ requestId: 'mirror-before-crash' })).status, 'success');
  assert.equal((await store.list('maintenance_outbox')).every(row => row.state === 'retry_pending'), true);

  const recoveredCache = new MemoryCache({ now: () => Date.parse('2026-07-20T08:00:10.000Z') });
  const restarted = engine({ store, cache: recoveredCache });
  restarted.instance.configure({
    channelId: 'telegram-main',
    timezone: 'UTC',
    maxRetries: 0,
    clock: () => new Date('2026-07-20T08:00:10.000Z'),
  });
  const result = await restarted.instance.run({ requestId: 'restart-drains-mirror' });

  assert.equal(result.status, 'success');
  assert.equal(result.reason, 'already_complete');
  assert.equal(await recoveredCache.peek(`seen:${compatibilityHash(article.id)}`), '1');
  assert.ok(await recoveredCache.peek('digest:2026-07-20'));
  assert.equal((await store.list('maintenance_outbox')).every(row => row.state === 'succeeded'), true);
  assert.equal(restarted.source.calls, 0);
  assert.equal(restarted.outputs[0].calls.length, 0);
});

function compatibilityHash(value) {
  let hash = 0;
  const string = String(value);
  for (let index = 0; index < string.length; index++) {
    hash = ((hash << 5) - hash) + string.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}
