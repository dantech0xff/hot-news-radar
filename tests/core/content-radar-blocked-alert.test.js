import test from 'node:test';
import assert from 'node:assert/strict';

import { SCAN_INTERVAL_MS, first, mutationState, second, setup } from '../helpers/provable-output.js';

function observed() {
  const calls = [];
  return { calls, observer: async block => { calls.push(block); } };
}

async function blockedChannel(options = {}) {
  const env = setup({ options });
  await env.engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  env.source.articles = [first, second];
  env.time.advance(SCAN_INTERVAL_MS);
  return env;
}

test('a channel the engine cannot unblock is reported to the observer on every run, with the blocking attempt', async () => {
  const { calls, observer } = observed();
  const env = await blockedChannel({ onChannelBlocked: observer });
  const attempt = (await env.store.list('attempts')).find(value => value.kind === 'output');

  await env.engine.runDrip({ batchSize: 1, requestId: 'second-run' });
  env.time.advance(SCAN_INTERVAL_MS);
  await env.engine.runDrip({ batchSize: 1, requestId: 'third-run' });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    channelId: 'telegram-main',
    attemptId: attempt.attemptId,
    deliveryId: attempt.deliveryId,
    article: { title: first.title, url: first.url },
  });
  assert.equal(calls[1].attemptId, attempt.attemptId);
});

test('nothing is reported when the engine confirms the send itself or the channel was never blocked', async () => {
  const { calls, observer } = observed();
  const env = await blockedChannel({ onChannelBlocked: observer });
  env.output.proof = { messageId: '77' };

  const resumed = await env.engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.equal(resumed.status, 'success');
  assert.equal(await mutationState(env.machine), 'free');
  assert.equal(calls.length, 0);

  env.time.advance(SCAN_INTERVAL_MS);
  await env.engine.runDrip({ batchSize: 1, requestId: 'third-run' });
  assert.equal(calls.length, 0);
});

test('a block an operator cleared while the lookup ran is not reported', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { calls, observer } = observed();
  const env = await blockedChannel({ onChannelBlocked: observer });
  const attempt = (await env.store.list('attempts')).find(value => value.kind === 'output');
  const target = await env.machine.getOutput(attempt.deliveryId, attempt.outputKey);
  env.output.onLookup = () => env.machine.reconcile({
    action: 'confirm-delivered',
    deliveryId: attempt.deliveryId,
    outputKey: attempt.outputKey,
    expectedVersion: target.version,
    operatorId: 'ops',
    reason: 'checked the channel by hand',
    idempotencyKey: 'operator-confirm',
  });

  await env.engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.equal(await mutationState(env.machine), 'free');
  assert.equal(calls.length, 0);
});

test('an observer that throws never breaks the run', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const env = await blockedChannel({ onChannelBlocked: async () => { throw new Error('alert service down'); } });

  const result = await env.engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.notEqual(result.status, 'success');
  assert.equal(env.output.sends.length, 1);
  assert.equal(warn.mock.calls.some(call => String(call.arguments[0]).includes('observer failed')), true);
});

test('a healthy channel reports nothing', async () => {
  const { calls, observer } = observed();
  const env = setup({ options: { onChannelBlocked: observer } });
  env.output.timeoutNext = false;

  await env.engine.runDrip({ batchSize: 1, requestId: 'healthy-run' });

  assert.equal(calls.length, 0);
});
