import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryCache } from '../../src/core/caches.js';
import { buildEngine, runChannels, shouldRun } from '../../src/channels/runner.js';
import { RecordingOutput } from '../helpers/fakes.js';

function channel(id, mode = 'digest', schedule = '15 9 * * *') {
  return { id, mode, schedule, timezone: 'Asia/Singapore', batchSize: 3, delayMs: 0 };
}

test('channel engines gate tech relevance before scoring and semantic dedup', () => {
  const engine = buildEngine({
    id: 'telegram-main',
    sources: [],
    output: new RecordingOutput(),
    prompt: {},
    maxArticles: 12,
  }, { cache: new MemoryCache() });

  assert.deepEqual(
    engine.middlewares.map(middleware => JSON.parse(middleware.selectionKey)[0]),
    ['tech-relevance', 'scoring', 'semantic-dedup'],
  );
});

function recordingEngine() {
  const calls = [];
  return {
    calls,
    async run(options) { calls.push({ method: 'run', options }); return { status: 'success', reason: 'sent' }; },
    async runDrip(options) { calls.push({ method: 'runDrip', options }); return { status: 'success', reason: 'sent' }; },
  };
}

test('scheduled trigger honors each channel schedule in its timezone', async () => {
  const engine = recordingEngine();
  const now = new Date('2026-07-20T01:14:00.000Z'); // 09:14 Asia/Singapore
  const results = await runChannels([channel('digest')], {
    cache: {}, deliveryStore: {}, now, triggerType: 'scheduled',
    engineFactory: () => engine, logger: { log() {}, warn() {} },
  });
  assert.deepEqual(results, []);
  assert.equal(engine.calls.length, 0);

  assert.equal(shouldRun('15 9 * * *', new Date('2026-07-20T01:15:00.000Z'), 'Asia/Singapore'), true);
});

test('manual trigger bypasses schedule without forcing delivery selection', async () => {
  const engine = recordingEngine();
  const results = await runChannels([channel('digest')], {
    cache: {}, deliveryStore: {}, now: new Date('2026-07-20T01:14:00.000Z'), triggerType: 'manual',
    engineFactory: () => engine, logger: { log() {}, warn() {} },
  });
  assert.equal(results[0].status, 'success');
  assert.equal(engine.calls[0].method, 'run');
  assert.equal(engine.calls[0].options.force, false);
});

test('drip channels forward their daily post limit to the engine', async () => {
  const engine = recordingEngine();
  await runChannels([{ ...channel('drip', 'drip'), dailyLimit: 7 }], {
    cache: {}, deliveryStore: {}, triggerType: 'manual',
    engineFactory: () => engine, logger: { log() {}, warn() {} },
  });

  assert.equal(engine.calls[0].method, 'runDrip');
  assert.equal(engine.calls[0].options.dailyLimit, 7);
});

test('force trigger reaches both digest and drip engines', async () => {
  const digest = recordingEngine();
  const drip = recordingEngine();
  const engines = new Map([['digest', digest], ['drip', drip]]);
  await runChannels([channel('digest'), channel('drip', 'drip')], {
    cache: {}, deliveryStore: {}, triggerType: 'force', idempotencyKey: 'force-key',
    engineFactory: ch => engines.get(ch.id), logger: { log() {}, warn() {} },
  });
  assert.equal(digest.calls[0].options.force, true);
  assert.match(digest.calls[0].options.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.match(digest.calls[0].options.requestId, /^[a-f0-9]{64}$/);
  assert.notEqual(digest.calls[0].options.idempotencyKey, 'force-key');
  assert.equal(drip.calls[0].options.force, true);
  assert.match(drip.calls[0].options.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.notEqual(drip.calls[0].options.idempotencyKey, digest.calls[0].options.idempotencyKey);
  assert.notEqual(drip.calls[0].options.requestId, digest.calls[0].options.requestId);
  assert.equal(digest.calls[0].options.operatorForce, undefined);
});

test('legacy force maps to explicit force and emits one deprecation warning', async () => {
  const engine = recordingEngine();
  const warnings = [];
  await runChannels([channel('drip', 'drip')], {
    cache: {}, deliveryStore: {}, force: true, idempotencyKey: 'legacy-force-key',
    engineFactory: () => engine, logger: { log() {}, warn: value => warnings.push(value) },
  });
  assert.equal(engine.calls[0].options.force, true);
  assert.equal(warnings.length, 1);
});

test('runner redacts secret-bearing provider failures while preserving generic context', async () => {
  const logs = [];
  const results = await runChannels([channel('digest')], {
    cache: {}, deliveryStore: {}, triggerType: 'manual',
    engineFactory: () => ({
      async run() {
        throw new Error('provider outage body={"token":"raw-provider-token"} https://secret.example/hook');
      },
    }),
    logger: { log: value => logs.push(String(value)), warn() {} },
  });
  const projected = JSON.stringify(results) + logs.join('\n');
  assert.match(projected, /provider outage/i);
  assert.equal(projected.includes('raw-provider-token'), false);
  assert.equal(projected.includes('secret.example'), false);
});

test('explicit scheduled trigger cannot be converted to force by the force option', async () => {
  await assert.rejects(
    runChannels([channel('digest')], {
      cache: {}, deliveryStore: {}, triggerType: 'scheduled', force: true,
      engineFactory: () => recordingEngine(), logger: { log() {}, warn() {} },
    }),
    /force.*triggerType/i,
  );
});
