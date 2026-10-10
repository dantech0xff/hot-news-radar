import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import {
  ProvableOutput, SCAN_INTERVAL_MS, first, mutableClock, mutationState, second, setup,
} from '../helpers/provable-output.js';

test('an ambiguous send the destination can prove is confirmed on the next run, which then carries on', async () => {
  const { store, time, source, engine, machine, output } = setup();

  const ambiguous = await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
  const attempt = (await store.list('attempts')).find(value => value.kind === 'output');

  output.proof = { messageId: '77' };
  source.articles = [first, second];
  time.advance(SCAN_INTERVAL_MS);
  const resumed = await engine.runDrip({ batchSize: 1, requestId: 'next-run' });

  assert.equal(resumed.status, 'success');
  assert.deepEqual(output.sends.map(send => send.url), [first.url, second.url]);
  assert.equal(output.lookups.length, 1);
  assert.equal(output.lookups[0].articles[0].url, first.url);
  assert.equal(output.lookups[0].since.toISOString(), attempt.startedAt);
  assert.equal(output.lookups[0].until.toISOString(), attempt.completedAt);
  assert.equal(await mutationState(machine), 'free');

  const delivered = (await store.list('deliveries')).find(value => value.articleSnapshot[0].url === first.url);
  assert.equal(delivered.state, 'succeeded');
  const [action] = await store.list('operator_actions');
  assert.equal(action.action, 'confirm-delivered');
  assert.equal(action.operatorId, 'auto-reconcile');
  const confirmed = await machine.getOutput(delivered.deliveryId, attempt.outputKey);
  assert.deepEqual(confirmed.successfulMessageIds, ['77']);
});

test('without proof the output stays ambiguous, the lookup repeats every run, and nothing is sent again', async () => {
  const { time, source, engine, machine, output } = setup();
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  source.articles = [first, second];

  for (const requestId of ['second-run', 'third-run']) {
    time.advance(SCAN_INTERVAL_MS);
    const blocked = await engine.runDrip({ batchSize: 1, requestId });
    assert.notEqual(blocked.status, 'success');
  }

  assert.equal(output.sends.length, 1);
  assert.equal(output.lookups.length, 2);
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
});

test('a failing lookup never breaks the run and leaves the output ambiguous', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { time, source, engine, machine, output } = setup();
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  output.lookupError = new Error('preview unreachable');
  source.articles = [first, second];
  time.advance(SCAN_INTERVAL_MS);

  const result = await engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.notEqual(result.status, 'success');
  assert.equal(output.sends.length, 1);
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
  assert.equal(warn.mock.calls.some(call => String(call.arguments[0]).startsWith('[Reconcile]')), true);
});

test('a paused channel is left alone', async () => {
  const { time, engine, machine, output } = setup();
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  await machine.setPaused(true, {
    expectedVersion: (await machine.getChannelState()).version,
    idempotencyKey: 'pause-for-test',
    operatorId: 'ops',
    reason: 'pause for test',
  });
  output.proof = { messageId: '77' };
  time.advance(SCAN_INTERVAL_MS);

  const result = await engine.runDrip({ batchSize: 1, requestId: 'paused-run' });

  assert.equal(result.reason, 'channel_paused');
  assert.equal(output.lookups.length, 0);
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
});

test('a destination that is no longer the one the attempt used is never consulted', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const time = mutableClock();
  const original = setup({ store, time });
  await original.engine.runDrip({ batchSize: 1, requestId: 'first-run' });

  const moved = setup({ store, time, output: new ProvableOutput({ key: 'provable:another-destination' }) });
  moved.output.proof = { messageId: '77' };
  moved.output.timeoutNext = false;
  time.advance(SCAN_INTERVAL_MS);
  await moved.engine.runDrip({ batchSize: 1, requestId: 'moved-run' });

  assert.equal(moved.output.lookups.length, 0);
  assert.equal(original.output.lookups.length, 0);
  assert.equal(moved.output.sends.length, 0);
  assert.equal(await mutationState(original.machine), 'blocked_ambiguous');
});

test('an operator who confirms the same output first wins without breaking the run', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { store, time, source, engine, machine, output } = setup();
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  const attempt = (await store.list('attempts')).find(value => value.kind === 'output');
  const target = await machine.getOutput(attempt.deliveryId, attempt.outputKey);

  output.proof = { messageId: '77' };
  output.onLookup = () => machine.reconcile({
    action: 'confirm-delivered',
    deliveryId: attempt.deliveryId,
    outputKey: attempt.outputKey,
    expectedVersion: target.version,
    operatorId: 'ops',
    reason: 'checked the channel by hand',
    idempotencyKey: 'operator-confirm',
    messageId: '77',
  });
  source.articles = [first, second];
  time.advance(SCAN_INTERVAL_MS);

  const resumed = await engine.runDrip({ batchSize: 1, requestId: 'next-run' });

  assert.equal(resumed.status, 'success');
  assert.deepEqual(output.sends.map(send => send.url), [first.url, second.url]);
  assert.deepEqual((await store.list('operator_actions')).map(action => action.operatorId), ['ops']);
  assert.equal(warn.mock.calls.some(call => String(call.arguments[0]).startsWith('[Reconcile]')), true);
});

test('digest runs reconcile too: the same request replays as already complete', async () => {
  const { engine, machine, output } = setup();
  const ambiguous = await engine.run({ requestId: 'digest-1' });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(await mutationState(machine), 'blocked_ambiguous');

  output.proof = { messageId: '5' };
  const replay = await engine.run({ requestId: 'digest-1' });

  assert.equal(replay.status, 'success');
  assert.equal(replay.reason, 'already_complete');
  assert.equal(output.sends.length, 1);
  assert.equal(await mutationState(machine), 'free');
});

test('a send that already put some parts out is never confirmed from one matching post', async () => {
  const { time, source, engine, machine, output } = setup({ output: new ProvableOutput({ partial: true }) });
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  output.proof = { messageId: '77' };
  source.articles = [first, second];
  time.advance(SCAN_INTERVAL_MS);

  const result = await engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.notEqual(result.status, 'success');
  assert.equal(output.lookups.length, 0);
  assert.equal(output.sends.length, 1);
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
});

test('a lookup that never answers is abandoned at its own deadline and cancelled', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { time, source, engine, machine, output } = setup({ options: { reconcileLookupTimeoutMs: 20 } });
  await engine.runDrip({ batchSize: 1, requestId: 'first-run' });
  let cancelled = false;
  output.onLookup = query => new Promise(() => {
    query.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
  });
  source.articles = [first, second];
  time.advance(SCAN_INTERVAL_MS);

  const result = await engine.runDrip({ batchSize: 1, requestId: 'second-run' });

  assert.notEqual(result.status, 'success');
  assert.equal(cancelled, true);
  assert.equal(output.sends.length, 1);
  assert.equal(await mutationState(machine), 'blocked_ambiguous');
});
