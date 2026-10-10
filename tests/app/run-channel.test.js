import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  OPERATOR,
  SECRETS,
  channelInput,
  createActiveChannel,
  createRuntimeFixture,
  techArticle,
} from './helpers/runtime-fixture.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1_000;
const AMBIGUOUS = { success: false, meta: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'timeout' } };

function gossip(id = 'gossip') {
  return {
    id,
    title: 'Celebrity wedding gossip roundup',
    url: `https://example.test/${id}`,
    content: 'Red carpet fashion and dating rumours.',
    source: 'Recording Source',
  };
}

function contentByTitle(runtime, channelId = 'telegram-ops') {
  return Object.fromEntries(runtime.listContent({ channelId, limit: 100 }).items.map(item => [item.title, item]));
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

async function started(t, options) {
  const fixture = await createRuntimeFixture(t, options);
  const events = [];
  fixture.runtime.onEvent(event => events.push(event));
  assert.deepEqual(await fixture.runtime.start(), { leased: true });
  return { ...fixture, events };
}

test('a manual drip run delivers through the shared runner and records the run, sources, and library', async t => {
  const env = await started(t, {
    articles: [
      techArticle('rust-2', 'Rust 2.0 compiler ships async closures'),
      techArticle('gpu', 'GPU kernels land in Linux 7.0'),
      gossip(),
    ],
  });
  await createActiveChannel(env.runtime, env.credentialIds);

  const outcome = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.recorded, true);
  assert.equal(env.plugins.output.calls.length, 1);
  assert.equal(env.plugins.output.calls[0].options.article.title, 'Rust 2.0 compiler ships async closures');

  const run = env.runtime.getRun(outcome.runId);
  assert.equal(run.channelId, 'telegram-ops');
  assert.equal(run.triggerType, 'manual');
  assert.equal(run.status, 'success');
  assert.equal(run.outputsTotal, 1);
  assert.equal(run.outputsSucceeded, 1);
  assert.equal(run.outputsFailed, 0);
  assert.equal(run.aiInputTokens, 1);
  assert.equal(run.aiOutputTokens, 1);
  assert.equal(run.error, null);
  assert.deepEqual(run.stats.selection, { fetched: 3, fresh: 3, uncovered: 3, relevant: 2, ranked: 2, enqueued: 1 });
  assert.deepEqual(run.stats.generation, { attempted: 1, succeeded: 1, failed: 0 });
  assert.equal(run.stats.triggeredBy, OPERATOR);
  assert.equal(run.stats.mode, 'drip');
  assert.deepEqual(run.stats.outputResults.map(entry => [entry.outputId, entry.success, entry.messageIds]), [
    ['recording-output', true, ['message-1']],
  ]);
  assert.deepEqual(run.sourceHealth.map(entry => [entry.sourceId, entry.status, entry.articleCount, entry.errorClass]), [
    ['recording-source', 'healthy', 3, null],
  ]);

  const library = contentByTitle(env.runtime);
  assert.equal(library['Rust 2.0 compiler ships async closures'].status, 'delivered');
  assert.equal(library['Rust 2.0 compiler ships async closures'].messageId, 'message-1');
  assert.equal(library['Rust 2.0 compiler ships async closures'].runId, outcome.runId);
  assert.equal(env.runtime.getContent(library['Rust 2.0 compiler ships async closures'].id).summaryText, 'Bản tin công nghệ đã tóm tắt');
  assert.equal(library['GPU kernels land in Linux 7.0'].status, 'selected');
  assert.deepEqual(
    [library['Celebrity wedding gossip roundup'].status, library['Celebrity wedding gossip roundup'].rejectReason],
    ['rejected', 'not_tech'],
  );

  const runEvents = env.events.filter(event => event.type.startsWith('run.'));
  assert.deepEqual(runEvents.map(event => [event.type, event.data.runId, event.data.triggerType]), [
    ['run.started', outcome.runId, 'manual'],
    ['run.finished', outcome.runId, 'manual'],
  ]);
  assert.equal(runEvents[1].data.status, 'success');
});

test('later drip scans deliver new candidates once, update library rows in place, and record each run', async t => {
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures'), techArticle('gpu', 'GPU kernels land in Linux 7.0'), gossip()],
  });
  await createActiveChannel(env.runtime, env.credentialIds);
  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  const rowsBefore = count(env.db, 'app_content_items');

  env.clock.advance(SCAN_INTERVAL_MS);
  const second = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(second.status, 'success');
  assert.deepEqual(env.plugins.output.calls.map(call => call.options.article.title), [
    'Rust 2.0 compiler ships async closures',
    'GPU kernels land in Linux 7.0',
  ]);
  assert.deepEqual(env.runtime.getRun(second.runId).stats.selection, { fetched: 3, fresh: 2, uncovered: 2, relevant: 1, ranked: 1, enqueued: 1 });
  assert.equal(count(env.db, 'app_content_items'), rowsBefore);
  const library = contentByTitle(env.runtime);
  assert.equal(library['GPU kernels land in Linux 7.0'].status, 'delivered');
  assert.equal(library['Celebrity wedding gossip roundup'].lastSeenAt, env.clock().toISOString());
  assert.equal(env.runtime.listRuns('telegram-ops').page.total, 2);
});

test('a digest run delivers one summary for all selected articles', async t => {
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures'), techArticle('gpu', 'GPU kernels land in Linux 7.0')],
    aiText: 'Bản tin tổng hợp trong ngày',
  });
  await createActiveChannel(env.runtime, env.credentialIds, { mode: 'digest' });

  const outcome = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(outcome.status, 'success');
  assert.equal(env.plugins.output.calls.length, 1);
  assert.equal(env.plugins.output.calls[0].content, 'Bản tin tổng hợp trong ngày');
  const run = env.runtime.getRun(outcome.runId);
  assert.equal(run.stats.mode, 'digest');
  assert.equal(typeof run.stats.deliveryId, 'string');
  assert.equal(run.outputsSucceeded, 1);
  const rows = Object.values(contentByTitle(env.runtime));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'delivered');
    assert.equal(row.deliveryId, run.stats.deliveryId);
  }
});

test('an ambiguous output is never resent automatically', async t => {
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [AMBIGUOUS],
  });
  await createActiveChannel(env.runtime, env.credentialIds);

  const first = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  env.plugins.source.articles.push(techArticle('gpu', 'GPU kernels land in Linux 7.0'));
  env.clock.advance(SCAN_INTERVAL_MS);
  const second = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(first.status, 'ambiguous');
  assert.equal(env.plugins.output.calls.length, 1);
  assert.notEqual(second.status, 'success');
  const library = contentByTitle(env.runtime);
  assert.equal(library['Rust 2.0 compiler ships async closures'].status, 'ambiguous');
  assert.equal(library['GPU kernels land in Linux 7.0'].status, 'queued');
  assert.equal((await env.runtime.getStatus('telegram-ops')).mutationState, 'blocked_ambiguous');
  assert.equal(env.runtime.getRun(first.runId).outputsFailed, 1);
});

test('a channel the engine cannot unblock is reported once to the alert chat', async t => {
  const sent = [];
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [AMBIGUOUS],
    runtimeOptions: { alertChatId: '123456789' },
  });
  env.plugins.output.notify = async (chatId, text) => { sent.push({ chatId, text }); return true; };
  await createActiveChannel(env.runtime, env.credentialIds);

  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  // The run that creates the block cannot know yet whether the next run will confirm it.
  assert.equal(sent.length, 0);

  env.plugins.source.articles.push(techArticle('gpu', 'GPU kernels land in Linux 7.0'));
  for (let run = 0; run < 2; run += 1) {
    env.clock.advance(SCAN_INTERVAL_MS);
    await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '123456789');
  assert.match(sent[0].text, /telegram-ops/);
  assert.match(sent[0].text, /Rust 2\.0 compiler ships async closures/);
});

test('without an alert chat a blocked channel stays quiet', async t => {
  const sent = [];
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    outputResults: [AMBIGUOUS],
  });
  env.plugins.output.notify = async (chatId, text) => { sent.push({ chatId, text }); return true; };
  await createActiveChannel(env.runtime, env.credentialIds);

  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  env.clock.advance(SCAN_INTERVAL_MS);
  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(sent.length, 0);
});

test('stories already delivered today are not queued again', async t => {
  const env = await started(t, { articles: [techArticle('gpt-6', 'OpenAI ships GPT-6 for developers')] });
  await createActiveChannel(env.runtime, env.credentialIds);
  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  env.plugins.source.articles = [techArticle('gpt-6-recap', 'Developers get GPT-6 from OpenAI today')];
  env.clock.advance(SCAN_INTERVAL_MS);
  const second = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(env.plugins.output.calls.length, 1);
  assert.equal(second.status, 'skipped');
  assert.deepEqual(env.runtime.getRun(second.runId).stats.selection, { fetched: 1, fresh: 1, uncovered: 0, relevant: 0, ranked: 0, enqueued: 0 });
  const recap = contentByTitle(env.runtime)['Developers get GPT-6 from OpenAI today'];
  assert.deepEqual([recap.status, recap.rejectReason], ['rejected', 'duplicate']);
});

test('the daily limit stops scanning once reached', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  await createActiveChannel(env.runtime, env.credentialIds, {
    limits: { batchSize: 1, delayMs: 0, dailyLimit: 1, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
  });
  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  env.plugins.source.articles.push(techArticle('gpu', 'GPU kernels land in Linux 7.0'));
  env.clock.advance(SCAN_INTERVAL_MS);
  const second = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.equal(env.plugins.output.calls.length, 1);
  assert.equal(env.plugins.source.calls, 1);
  const run = env.runtime.getRun(second.runId);
  assert.equal(run.status, 'skipped');
  assert.equal(run.stats.reason, 'daily_limit_reached');
  assert.deepEqual(run.sourceHealth, [], 'a run without a fetch records no source health');
});

test('articles published before notBefore are rejected and never delivered; undated ones are kept', async t => {
  const env = await started(t, {
    articles: [
      techArticle('old', 'Rust 1.99 compiler release notes', { publishedAt: '2026-10-02T23:00:00.000Z' }),
      techArticle('fresh', 'GPU kernels land in Linux 7.0', { publishedAt: '2026-10-03T07:00:00.000Z' }),
      techArticle('undated', 'SQLite 4 preview ships'),
    ],
  });
  await createActiveChannel(env.runtime, env.credentialIds, {
    notBefore: '2026-10-03T00:00:00.000Z',
    limits: { batchSize: 3, delayMs: 0, dailyLimit: 18, maxArticles: 18, maxArticlesPerSource: 5, concurrency: 5 },
  });

  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });
  env.clock.advance(SCAN_INTERVAL_MS);
  await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  assert.deepEqual(env.plugins.output.calls.map(call => call.options.article.title).sort(), [
    'GPU kernels land in Linux 7.0',
    'SQLite 4 preview ships',
  ]);
  const old = contentByTitle(env.runtime)['Rust 1.99 compiler release notes'];
  assert.deepEqual([old.status, old.rejectReason], ['rejected', 'before_cutoff']);
});

test('a run with too much per-item detail keeps its counts and drops the detail', async t => {
  const longIds = index => Array.from({ length: 10 }, (_, part) => `${index}-${part}-${'9'.repeat(190)}`);
  const env = await started(t, {
    articles: Array.from({ length: 50 }, (_, index) => techArticle(`item-${index}`, randomUUID().split('-').join(' '))),
    outputResults: Array.from({ length: 50 }, (_, index) => ({
      success: true,
      meta: { deliveryState: 'success', retryDisposition: 'never', successfulMessageIds: longIds(index) },
    })),
  });
  await createActiveChannel(env.runtime, env.credentialIds, {
    limits: { batchSize: 50, delayMs: 0, dailyLimit: 100, maxArticles: 100, maxArticlesPerSource: 100, concurrency: 5 },
  });

  const outcome = await env.runtime.runNow('telegram-ops', OPERATOR, { wait: true });

  const run = env.runtime.getRun(outcome.runId);
  assert.equal(run.status, 'success');
  assert.equal(run.outputsSucceeded, 50);
  assert.equal(run.stats.detailTruncated, true);
  assert.deepEqual([run.stats.items, run.stats.outputResults], [[], []]);
  assert.equal(run.stats.selection.enqueued, 50);
});

test('preview is read-only: no send, no delivery state, no run or library rows', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures'), gossip()] });
  await createActiveChannel(env.runtime, env.credentialIds);
  const tables = ['deliveries', 'day_batches', 'batch_items', 'delivery_outputs', 'attempts', 'app_runs', 'app_content_items', 'app_source_health'];
  const before = Object.fromEntries(tables.map(table => [table, count(env.db, table)]));
  const stateBefore = await env.deliveryStore.get('channel_state', 'telegram-ops');

  const preview = await env.runtime.preview('telegram-ops');

  assert.equal(preview.status, 'dry_run');
  assert.equal(preview.mode, 'drip');
  assert.deepEqual(preview.items, [{ title: 'Rust 2.0 compiler ships async closures', hook: 'Bản tin công nghệ đã tóm tắt' }]);
  assert.deepEqual(preview.aiUsage, { attempted: 1, succeeded: 1, failed: 0, inputTokens: 1, outputTokens: 1 });
  assert.deepEqual(preview.sources.map(entry => [entry.sourceId, entry.status]), [['recording-source', 'healthy']]);
  assert.equal(env.plugins.output.calls.length, 0);
  assert.deepEqual(Object.fromEntries(tables.map(table => [table, count(env.db, table)])), before);
  assert.deepEqual(await env.deliveryStore.get('channel_state', 'telegram-ops'), stateBefore);
  assert.equal(JSON.stringify(preview).includes(SECRETS.botToken), false);
});

test('a run whose channel cannot be built is recorded as an error naming the slot, never a value', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  const record = await createActiveChannel(env.runtime, env.credentialIds);
  await env.runtime.updateChannel(record.id, {
    version: record.version,
    telegram: { botTokenCredentialId: null, chatIdCredentialId: env.credentialIds.chatId },
  }, OPERATOR);

  const outcome = await env.runtime.runNow(record.id, OPERATOR, { wait: true });

  assert.equal(outcome.status, 'error');
  const run = env.runtime.getRun(outcome.runId);
  assert.match(run.error, /missing required credentials: telegram\.botTokenCredentialId/);
  assert.equal(run.stats.reason, 'channel_build_failed');
  for (const secret of Object.values(SECRETS)) assert.equal(JSON.stringify(run).includes(secret), false);
  assert.equal(env.plugins.output.calls.length, 0);
});

test('manual runs of a paused channel are recorded as skipped without building the channel', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  const record = await env.runtime.createChannel({
    ...channelInput(env.credentialIds),
    telegram: { botTokenCredentialId: null, chatIdCredentialId: null },
  }, OPERATOR);

  const outcome = await env.runtime.runNow(record.id, OPERATOR, { wait: true });

  assert.deepEqual([outcome.status, outcome.reason, outcome.recorded], ['skipped', 'channel_paused', true]);
  assert.equal(env.runtime.getRun(outcome.runId).status, 'skipped');
  assert.equal(env.plugins.source.calls, 0);
});

test('a scheduled tick runs the channel with the scheduled trigger', async t => {
  const env = await started(t, { articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')] });
  await createActiveChannel(env.runtime, env.credentialIds);
  env.clock.set('2026-10-03T09:00:00.000Z');

  const finished = new Promise(resolve => {
    env.runtime.onEvent(event => { if (event.type === 'run.finished') resolve(event); });
  });
  env.cron.fire('telegram-ops');
  const event = await finished;

  assert.equal(event.data.triggerType, 'scheduled');
  assert.equal(event.data.status, 'success');
  assert.equal(env.runtime.getRun(event.data.runId).triggerType, 'scheduled');
  assert.equal(env.plugins.output.calls.length, 1);
});

test('a cutover channel delivers nothing while its notBefore is unset, even after it was resumed', async t => {
  const warnings = [];
  const env = await started(t, {
    articles: [techArticle('rust-2', 'Rust 2.0 compiler ships async closures')],
    logger: { log() {}, warn: message => warnings.push(String(message)), error() {} },
  });
  await env.runtime.seedDefaultChannels();
  const gatewayToken = env.credentials.create({ label: 'Gateway', kind: 'ai_gateway_token', value: 'fake-gateway-token', actor: OPERATOR }).id;
  const seeded = env.runtime.getChannel('telegram-main');
  const ready = await env.runtime.updateChannel('telegram-main', {
    version: seeded.version,
    notBefore: '2026-10-03T00:00:00Z',
    telegram: { botTokenCredentialId: env.credentialIds.botToken, chatIdCredentialId: env.credentialIds.chatId },
    ai: { ...seeded.ai, gateway: { ...seeded.ai.gateway, tokenCredentialId: gatewayToken } },
  }, OPERATOR);
  const { version } = await env.runtime.getStatus('telegram-main');
  await env.runtime.control('telegram-main', 'resume', { idempotencyKey: 'resume-main', expectedVersion: version, reason: 'Cutover approved' }, OPERATOR);

  // The cutover instant is cleared after the channel was resumed.
  await env.runtime.updateChannel('telegram-main', { version: ready.version, notBefore: null }, OPERATOR);
  assert.equal((await env.runtime.getStatus('telegram-main')).paused, false);
  await assert.rejects(env.runtime.runNow('telegram-main', OPERATOR), { code: 'cutover_required' });
  env.cron.fire('telegram-main', '2026-10-03T08:00:00.000Z');
  for (let turn = 0; turn < 200 && !warnings.some(line => line.includes('telegram-main')); turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  await env.runtime.stop();

  assert.equal(env.plugins.source.calls, 0);
  assert.equal(env.plugins.output.calls.length, 0);
  assert.equal(env.runtime.listRuns('telegram-main').page.total, 0);
  assert.ok(warnings.some(line => /telegram-main: scheduled run skipped; set notBefore/.test(line)), warnings.join('\n'));
});
