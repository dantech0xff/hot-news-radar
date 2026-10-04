import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import {
  DeliveryStateMachine,
  assertDeliveryTransition,
} from '../../src/core/delivery-state-machine.js';
import { RecordingOutput } from '../helpers/fakes.js';

const article = {
  id: 'article-1',
  title: 'Reliable delivery',
  url: 'https://example.com/reliable',
  content: 'content',
  source: 'Example',
};

async function prepared({ now = '2026-07-20T00:00:00.000Z', outputs } = {}) {
  let current = new Date(now);
  const store = new MemoryDeliveryStore({ durable: true });
  const machine = new DeliveryStateMachine({
    store,
    channelId: 'telegram-main',
    clock: () => new Date(current),
    attemptTimeoutMs: 1_000,
  });
  const selectedOutputs = outputs ?? [new RecordingOutput({ key: 'telegram:one' })];
  const delivery = await machine.prepareDelivery({
    requestId: 'request-1',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: selectedOutputs,
  });
  return { store, machine, delivery, outputs: selectedOutputs, setNow: value => { current = new Date(value); } };
}

test('explicit transition table fails closed', () => {
  assert.doesNotThrow(() => assertDeliveryTransition('delivery', 'pending_generation', 'generating'));
  assert.throws(
    () => assertDeliveryTransition('delivery', 'pending_generation', 'succeeded'),
    /Illegal delivery transition/,
  );
  assert.throws(() => assertDeliveryTransition('mystery', 'a', 'b'), /Unknown transition level/);
});

test('matching configuration never auto-clears a topology blocker', async () => {
  const original = new RecordingOutput({ key: 'telegram:topology-original' });
  const changed = new RecordingOutput({ key: 'telegram:topology-changed' });
  const { machine, delivery } = await prepared({ outputs: [original] });

  const blocked = await machine.validateOutputTopology(delivery.deliveryId, [changed]);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.delivery.state, 'blocked_topology');

  const matchingAgain = await machine.validateOutputTopology(delivery.deliveryId, [original]);
  assert.equal(matchingAgain.status, 'blocked');
  assert.equal(matchingAgain.reason, 'topology_restore_required');
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'blocked_topology');

  const preparedAgain = await machine.prepareDelivery({
    requestId: 'request-2',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [original],
  });
  assert.equal(preparedAgain.status, 'blocked');
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'blocked_topology');
});

test('only a versioned audited operator action restores a matching topology', async () => {
  const original = new RecordingOutput({ key: 'telegram:topology-restore' });
  const changed = new RecordingOutput({ key: 'telegram:topology-drift' });
  const { machine, delivery } = await prepared({ outputs: [original] });
  await machine.validateOutputTopology(delivery.deliveryId, [changed]);
  const blocked = await machine.getDelivery(delivery.deliveryId);
  const restoredTopology = await machine.validateOutputTopology(delivery.deliveryId, [original]);

  await assert.rejects(machine.reconcile({
    action: 'restore-topology',
    deliveryId: delivery.deliveryId,
    expectedVersion: blocked.version,
    topologyFingerprint: 'not-the-configured-topology',
    idempotencyKey: 'restore-topology-wrong-config',
    operatorId: 'ops-key-1',
    reason: 'configuration is still wrong',
  }), /has not been restored/i);

  const restored = await machine.reconcile({
    action: 'restore-topology',
    deliveryId: delivery.deliveryId,
    expectedVersion: blocked.version,
    topologyFingerprint: restoredTopology.topology.fingerprint,
    idempotencyKey: 'restore-topology-correct-config',
    operatorId: 'ops-key-1',
    reason: 'configuration was reviewed and restored',
  });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.delivery.state, 'pending_generation');
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'pending_generation');
  const [audit] = (await machine.store.list('operator_actions'))
    .filter(value => value.action === 'restore-topology');
  assert.equal(audit.result.deliveryState, 'pending_generation');

  const replay = await machine.reconcile({
    action: 'restore-topology',
    deliveryId: delivery.deliveryId,
    expectedVersion: blocked.version,
    topologyFingerprint: restoredTopology.topology.fingerprint,
    idempotencyKey: 'restore-topology-correct-config',
    operatorId: 'ops-key-1',
    reason: 'configuration was reviewed and restored',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.delivery.state, 'pending_generation');
});

test('claims and commits generation before any output can be claimed', async () => {
  const { machine, delivery } = await prepared();
  assert.equal((await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' })).status, 'blocked');

  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  assert.equal(generation.status, 'claimed');
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated content' });

  const output = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  assert.equal(output.status, 'claimed');
  assert.equal(output.content, 'generated content');
});

test('persists output A acknowledgement before output B becomes eligible', async () => {
  const outputA = new RecordingOutput({ key: 'telegram:a' });
  const outputB = new RecordingOutput({ key: 'telegram:b' });
  const { machine, delivery } = await prepared({ outputs: [outputA, outputB] });
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });

  const first = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  assert.equal(first.output.ordinal, 0);
  assert.equal((await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' })).reason, 'channel_busy');
  await machine.commitOutput(first.attempt.attemptId, {
    success: true,
    messageId: 'message-a',
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });

  assert.equal((await machine.getOutput(delivery.deliveryId, first.output.outputKey)).state, 'succeeded');
  const second = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  assert.equal(second.output.ordinal, 1);
});

test('stale output attempt becomes ambiguity and blocks all channel mutations', async () => {
  const { machine, delivery, setNow } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const claimed = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });

  setNow('2026-07-20T00:00:02.000Z');
  const recovered = await machine.recoverStaleAttempts();
  assert.equal(recovered.outputAmbiguous, 1);
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'needs_reconciliation');
  assert.equal((await machine.getChannelState()).mutationState, 'blocked_ambiguous');
  assert.equal((await machine.claimNextOutput(delivery.deliveryId, { requestId: 'other' })).reason, 'channel_blocked_ambiguous');
  assert.equal((await machine.getAttempt(claimed.attempt.attemptId)).state, 'ambiguous');
});

test('ambiguous result never creates an automatic retry', async () => {
  const { machine, delivery } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const claimed = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  const committed = await machine.commitOutput(claimed.attempt.attemptId, { success: false, error: 'timeout' });
  assert.equal(committed.result.meta.deliveryState, 'ambiguous');
  assert.equal((await machine.getOutput(delivery.deliveryId, claimed.output.outputKey)).state, 'needs_reconciliation');
});

test('operator retry atomically links and claims the exact ambiguous target', async () => {
  const { machine, delivery } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const first = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'timeout' });
  const blockedOutput = await machine.getOutput(delivery.deliveryId, first.output.outputKey);

  const retry = await machine.reconcile({
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: first.output.outputKey,
    expectedVersion: blockedOutput.version,
    idempotencyKey: 'operator-action-1',
    operatorId: 'ops-key-1',
    reason: 'provider confirms no message is visible',
    duplicateRiskAccepted: true,
    requestId: 'operator-retry-1',
  });
  assert.equal(retry.status, 'claimed');
  assert.equal(retry.attempt.requestId, 'operator-retry-1');
  assert.equal((await machine.getChannelState()).activeOutputAttemptId, retry.attempt.attemptId);
  assert.deepEqual(await machine.store.get('requests', 'operator-retry-1'), {
    requestId: 'operator-retry-1',
    channelId: 'telegram-main',
    triggerType: 'operator_retry',
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: first.output.outputKey,
    operatorActionId: retry.operatorActionId,
    payloadFingerprint: (await machine.store.get('requests', 'operator-retry-1')).payloadFingerprint,
    state: 'running',
    outcome: null,
    reason: null,
    result: null,
    runAttemptId: retry.attempt.attemptId,
    startedAt: retry.attempt.startedAt,
    deadlineAt: retry.attempt.deadlineAt,
    createdAt: retry.attempt.startedAt,
    updatedAt: retry.attempt.startedAt,
    version: 1,
  });

  const replay = await machine.reconcile({
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: first.output.outputKey,
    expectedVersion: blockedOutput.version,
    idempotencyKey: 'operator-action-1',
    operatorId: 'ops-key-1',
    reason: 'provider confirms no message is visible',
    duplicateRiskAccepted: true,
    requestId: 'operator-retry-1',
  });
  assert.equal(replay.attempt.attemptId, retry.attempt.attemptId);

  await assert.rejects(machine.reconcile({
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: first.output.outputKey,
    expectedVersion: blockedOutput.version,
    idempotencyKey: 'operator-action-1',
    operatorId: 'ops-key-1',
    reason: 'different payload under the same key',
    duplicateRiskAccepted: true,
    requestId: 'operator-retry-1',
  }), /Idempotency key conflicts/i);
});

test('retention keeps operator retry replay terminal without retaining content or raw reasons', async () => {
  const { machine, delivery, setNow } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'sensitive generated content' });
  const first = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'timeout' });
  const blockedOutput = await machine.getOutput(delivery.deliveryId, first.output.outputKey);
  const action = {
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: first.output.outputKey,
    expectedVersion: blockedOutput.version,
    idempotencyKey: 'retained-operator-retry',
    operatorId: 'ops-key-1',
    reason: 'provider confirms private target was not mutated',
    duplicateRiskAccepted: true,
    requestId: 'retained-operator-request',
  };
  const retry = await machine.reconcile(action);
  await machine.commitOutput(retry.attempt.attemptId, {
    success: true,
    messageId: 'message-after-retry',
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });
  const terminalDelivery = await machine.getDelivery(delivery.deliveryId);

  const audit = await machine.store.get('operator_actions', retry.operatorActionId);
  assert.equal(audit.reason, undefined);
  assert.match(audit.reasonHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(audit).includes('sensitive generated content'), false);
  assert.equal(JSON.stringify(audit).includes(action.reason), false);

  setNow('2026-08-22T00:00:00.000Z');
  await machine.compactHistory();
  assert.equal(await machine.getDelivery(delivery.deliveryId), null);
  assert.equal(await machine.getAttempt(retry.attempt.attemptId), null);
  const afterDeliveryRetention = await machine.reconcile(action);
  assert.equal(afterDeliveryRetention.status, 'succeeded');
  assert.equal(afterDeliveryRetention.deliveryId, delivery.deliveryId);
  assert.equal(afterDeliveryRetention.deliveryState, 'succeeded');
  assert.equal(afterDeliveryRetention.deliveryVersion, terminalDelivery.version);
  assert.equal(afterDeliveryRetention.outputKey, first.output.outputKey);
  assert.equal(afterDeliveryRetention.requestId, action.requestId);
  assert.equal(afterDeliveryRetention.replayed, true);

  setNow('2026-11-22T00:00:00.000Z');
  await machine.compactHistory();
  const compactedRequest = await machine.store.get('requests', action.requestId);
  assert.equal(compactedRequest.compacted, true);
  assert.equal(compactedRequest.result.deliveryState, 'succeeded');
  const afterRequestRetention = await machine.reconcile(action);
  assert.equal(afterRequestRetention.status, 'succeeded');
  assert.equal(afterRequestRetention.deliveryId, delivery.deliveryId);
  assert.equal(afterRequestRetention.deliveryState, 'succeeded');
  assert.equal(afterRequestRetention.deliveryVersion, terminalDelivery.version);
  assert.equal(afterRequestRetention.outputKey, first.output.outputKey);
  assert.equal(afterRequestRetention.replayed, true);
});

test('manual retry cannot steal another delivery ambiguity lease', async () => {
  const { machine, delivery, outputs } = await prepared();
  const generationA = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generationA.attempt.attemptId, { content: 'generated-a' });
  const outputA = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(outputA.attempt.attemptId, {
    success: false,
    meta: {
      deliveryState: 'definitive_failure',
      retryDisposition: 'manual',
      sanitizedError: 'manual failure',
    },
  });
  const retryTarget = await machine.getOutput(delivery.deliveryId, outputA.output.outputKey);

  const deliveryB = await machine.prepareDelivery({
    requestId: 'request-2',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [{ ...article, id: 'article-2', url: 'https://example.com/reliable-2' }],
    outputs,
  });
  const generationB = await machine.claimGeneration(deliveryB.deliveryId, { requestId: 'request-2' });
  await machine.commitGeneration(generationB.attempt.attemptId, { content: 'generated-b' });
  const outputB = await machine.claimNextOutput(deliveryB.deliveryId, { requestId: 'request-2' });
  await machine.commitOutput(outputB.attempt.attemptId, { success: false, error: 'unknown outcome' });
  const ambiguityLease = (await machine.getChannelState()).activeOutputAttemptId;

  await assert.rejects(machine.reconcile({
    action: 'retry-output',
    deliveryId: delivery.deliveryId,
    outputKey: retryTarget.outputKey,
    expectedVersion: retryTarget.version,
    idempotencyKey: 'wrong-lease-retry',
    operatorId: 'ops-key-1',
    reason: 'must not steal another delivery lease',
    requestId: 'wrong-lease-request',
  }), /lease is busy/i);

  const currentA = await machine.getDelivery(delivery.deliveryId);
  await machine.reconcile({
    action: 'abandon',
    deliveryId: delivery.deliveryId,
    expectedVersion: currentA.version,
    idempotencyKey: 'abandon-unrelated-manual-failure',
    operatorId: 'ops-key-1',
    reason: 'suppress only the manual-failed delivery',
  });
  assert.equal((await machine.getChannelState()).mutationState, 'blocked_ambiguous');
  assert.equal((await machine.getChannelState()).activeOutputAttemptId, ambiguityLease);
});

test('operator reconciliation refuses a delivery owned by another channel', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const machineA = new DeliveryStateMachine({ store, channelId: 'channel-a' });
  const machineB = new DeliveryStateMachine({ store, channelId: 'channel-b' });
  const delivery = await machineB.prepareDelivery({
    requestId: 'channel-b-delivery',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [new RecordingOutput({ key: 'telegram:channel-b' })],
  });
  const generation = await machineB.claimGeneration(delivery.deliveryId, { requestId: 'channel-b-delivery' });
  const exhausted = await machineB.failGeneration(generation.attempt.attemptId, new Error('failed'), {
    retryDisposition: 'never',
  });

  await assert.rejects(machineA.reconcile({
    action: 'retry-generation',
    deliveryId: delivery.deliveryId,
    expectedVersion: exhausted.version,
    idempotencyKey: 'cross-channel-retry',
    operatorId: 'ops-key-1',
    reason: 'must be rejected',
    requestId: 'cross-channel-request',
  }), /another channel/i);
  assert.equal((await machineB.getDelivery(delivery.deliveryId)).state, 'generation_exhausted');
});

test('abandon rejects a delivery while a provider attempt is still live', async () => {
  const { machine, delivery } = await prepared();
  await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  const generating = await machine.getDelivery(delivery.deliveryId);
  await assert.rejects(machine.reconcile({
    action: 'abandon',
    deliveryId: delivery.deliveryId,
    expectedVersion: generating.version,
    idempotencyKey: 'abandon-live-generation',
    operatorId: 'ops-key-1',
    reason: 'must wait for recovery',
  }), /active provider attempt/i);
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'generating');
});

test('expired reservation owner cannot link with a stale claim token', async () => {
  const { machine, outputs, setNow } = await prepared();
  const first = await machine.claimDeliveryReservation({
    reservationId: 'reservation-stale-token',
    requestId: 'reservation-owner-one',
  });
  setNow('2026-07-20T00:00:02.000Z');
  const second = await machine.claimDeliveryReservation({
    reservationId: 'reservation-stale-token',
    requestId: 'reservation-owner-two',
  });
  const selected = [{ ...article, id: 'reservation-article', url: 'https://example.com/reservation' }];
  await machine.bindDeliveryReservation('reservation-stale-token', second.claimToken, {
    articles: selected,
    sourceHealth: { exhaustionEligible: true },
  });
  const delivery = await machine.prepareDelivery({
    requestId: 'reservation-owner-one',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: selected,
    outputs,
  });

  await assert.rejects(
    machine.linkDeliveryReservation('reservation-stale-token', first.claimToken, delivery.deliveryId),
    /no longer claimable/i,
  );
  assert.equal((await machine.getDeliveryReservation('reservation-stale-token')).deliveryId, null);
});

test('day batch refill claim is transactional and stale commits fail closed', async () => {
  const { machine } = await prepared();
  await machine.ensureDayBatch({
    batchId: 'batch-refill-lease',
    publishingDay: '2026-07-20',
    mode: 'drip',
    sourceTopologyFingerprint: 'source-topology-one',
    sourceHealth: { exhaustionEligible: true },
    deliveries: [],
  });
  const claims = await Promise.all([
    machine.claimBatchRefill({ batchId: 'batch-refill-lease', sourceTopologyFingerprint: 'source-topology-one' }),
    machine.claimBatchRefill({ batchId: 'batch-refill-lease', sourceTopologyFingerprint: 'source-topology-one' }),
  ]);
  const winner = claims.find(claim => claim.status === 'claimed');
  assert.equal(claims.filter(claim => claim.status === 'claimed').length, 1);
  assert.equal(claims.find(claim => claim.status !== 'claimed').reason, 'refill_in_flight');

  await assert.rejects(machine.recordBatchRefill({
    batchId: 'batch-refill-lease',
    claimToken: 'stale-token',
    sourceTopologyFingerprint: 'source-topology-one',
    sourceHealth: { healthy: 1, exhaustionEligible: true },
    deliveries: [],
    scanIntervalMs: 900_000,
  }), /no longer owned/i);
  const committed = await machine.recordBatchRefill({
    batchId: 'batch-refill-lease',
    claimToken: winner.claimToken,
    sourceTopologyFingerprint: 'source-topology-one',
    sourceHealth: { healthy: 1, exhaustionEligible: true },
    deliveries: [],
    scanIntervalMs: 900_000,
  });
  assert.equal(committed.refillCount, 1);
  assert.equal(committed.exhausted, false);
  assert.equal(committed.activeRefillClaimToken, null);
  assert.equal(committed.nextRefillAt, '2026-07-20T00:15:00.000Z');
});

async function radarBatch(machine, { batchId = 'radar-batch', publishingDay = '2026-07-20' } = {}) {
  await machine.ensureDayBatch({
    batchId,
    publishingDay,
    mode: 'drip',
    sourceTopologyFingerprint: 'radar-topology',
    sourceHealth: null,
    deliveries: [],
  });
  return { batchId, sourceTopologyFingerprint: 'radar-topology' };
}

test('radar scans claim again only after each scan interval elapses', async () => {
  const { machine, setNow } = await prepared();
  const target = await radarBatch(machine);
  const first = await machine.claimBatchRefill(target);
  await machine.recordBatchRefill({
    ...target, claimToken: first.claimToken, sourceHealth: { healthy: 1 }, deliveries: [], scanIntervalMs: 900_000,
  });

  setNow('2026-07-20T00:10:00.000Z');
  const early = await machine.claimBatchRefill(target);
  assert.equal(early.status, 'blocked');
  assert.equal(early.reason, 'refill_not_due');

  setNow('2026-07-20T00:15:00.000Z');
  const second = await machine.claimBatchRefill(target);
  assert.equal(second.status, 'claimed');
  const recorded = await machine.recordBatchRefill({
    ...target, claimToken: second.claimToken, sourceHealth: { healthy: 2 }, deliveries: [], scanIntervalMs: 900_000,
  });
  assert.equal(recorded.refillCount, 2);
  assert.equal(recorded.exhausted, false);
  assert.equal(recorded.nextRefillAt, '2026-07-20T00:30:00.000Z');
});

test('failed radar scans back off exponentially and a healthy scan resets the streak', async () => {
  const { machine, setNow } = await prepared();
  const target = await radarBatch(machine);
  const scan = async (sourceHealth) => {
    const claim = await machine.claimBatchRefill(target);
    assert.equal(claim.status, 'claimed');
    return machine.recordBatchRefill({
      ...target, claimToken: claim.claimToken, sourceHealth, deliveries: [], scanIntervalMs: 900_000,
    });
  };

  const failed = await scan({ healthy: 0, failed: 2 });
  assert.equal(failed.refillFailureCount, 1);
  assert.equal(failed.refillCount, 0);
  assert.equal(failed.nextRefillAt, '2026-07-20T00:01:00.000Z');
  assert.equal((await machine.claimBatchRefill(target)).reason, 'refill_backoff');

  setNow('2026-07-20T00:01:00.000Z');
  const failedAgain = await scan({ healthy: 0, unknown: 1 });
  assert.equal(failedAgain.refillFailureCount, 2);
  assert.equal(failedAgain.nextRefillAt, '2026-07-20T00:03:00.000Z');

  setNow('2026-07-20T00:03:00.000Z');
  const recovered = await scan({ healthy: 1, failed: 1, degraded: true });
  assert.equal(recovered.refillFailureCount, 0);
  assert.equal(recovered.refillCount, 1);
  assert.equal(recovered.nextRefillAt, '2026-07-20T00:18:00.000Z');
});

test('legacy exhausted or already refilled day batches do not block radar scans', async () => {
  const { store, machine } = await prepared();
  await store.transact(tx => tx.put('day_batches', 'legacy-batch', {
    batchId: 'legacy-batch',
    channelId: 'telegram-main',
    publishingDay: '2026-07-20',
    mode: 'drip',
    sourceTopologyFingerprint: 'radar-topology',
    sourceHealth: { exhaustionEligible: true },
    refillCount: 1,
    refillFailureCount: 3,
    activeRefillClaimToken: null,
    refillDeadlineAt: null,
    nextRefillAt: null,
    exhausted: true,
    createdAt: '2026-07-19T23:00:00.000Z',
    updatedAt: '2026-07-19T23:00:00.000Z',
  }, { expectedVersion: 0 }));

  const claim = await machine.claimBatchRefill({ batchId: 'legacy-batch', sourceTopologyFingerprint: 'radar-topology' });
  assert.equal(claim.status, 'claimed');
});

test('scan claims renew only while their token still owns the batch', async () => {
  const { machine, setNow } = await prepared();
  const target = await radarBatch(machine);
  const first = await machine.claimBatchRefill({ ...target, leaseMs: 5_000 });
  assert.equal(first.batch.refillDeadlineAt, '2026-07-20T00:00:05.000Z');

  setNow('2026-07-20T00:00:06.000Z');
  const renewed = await machine.renewBatchRefillClaim({ batchId: target.batchId, claimToken: first.claimToken, leaseMs: 5_000 });
  assert.equal(renewed.status, 'renewed');
  assert.equal(renewed.batch.refillDeadlineAt, '2026-07-20T00:00:11.000Z');

  setNow('2026-07-20T00:00:12.000Z');
  const takeover = await machine.claimBatchRefill({ ...target, leaseMs: 5_000 });
  assert.equal(takeover.status, 'claimed');
  assert.equal((await machine.renewBatchRefillClaim({ batchId: target.batchId, claimToken: first.claimToken })).status, 'lost');
});

test('orphan adoption links scan deliveries but recovers only an expired claim', async () => {
  const { machine, outputs, setNow } = await prepared();
  const live = await radarBatch(machine, { batchId: 'live-claim-batch' });
  const liveClaim = await machine.claimBatchRefill({ ...live, leaseMs: 60_000 });
  const inFlight = await machine.prepareDelivery({
    requestId: 'in-flight-scan-item',
    mode: 'drip',
    publishingDay: '2026-07-20',
    articles: [{ ...article, id: 'in-flight', url: 'https://example.com/in-flight' }],
    outputs,
  });

  const adoptedLive = await machine.adoptOrphanedDripDeliveries({ ...live, publishingDay: '2026-07-20' });
  assert.equal(adoptedLive.adoptedCount, 1);
  assert.equal(adoptedLive.batch.activeRefillClaimToken, liveClaim.claimToken);
  assert.deepEqual((await machine.listBatchItems(live.batchId)).map(item => item.deliveryId), [inFlight.deliveryId]);

  setNow('2026-07-20T00:01:00.000Z');
  const crashed = await radarBatch(machine, { batchId: 'crashed-claim-batch', publishingDay: '2026-07-21' });
  await machine.claimBatchRefill({ ...crashed, leaseMs: 1_000 });
  await machine.prepareDelivery({
    requestId: 'crashed-scan-item',
    mode: 'drip',
    publishingDay: '2026-07-21',
    articles: [{ ...article, id: 'crashed', url: 'https://example.com/crashed' }],
    outputs,
  });
  setNow('2026-07-20T00:01:05.000Z');
  const recovered = await machine.adoptOrphanedDripDeliveries({ ...crashed, publishingDay: '2026-07-21' });
  assert.equal(recovered.adoptedCount, 1);
  assert.equal(recovered.batch.activeRefillClaimToken, null);
});

test('a scan that enqueued articles counts as successful even without a healthy source', async () => {
  const { machine, outputs } = await prepared();
  const target = await radarBatch(machine);
  const claim = await machine.claimBatchRefill(target);
  const delivery = await machine.prepareDelivery({
    requestId: 'unknown-source-item',
    mode: 'drip',
    publishingDay: '2026-07-20',
    articles: [{ ...article, id: 'unknown-source', url: 'https://example.com/unknown-source' }],
    outputs,
  });

  const recorded = await machine.recordBatchRefill({
    ...target,
    claimToken: claim.claimToken,
    sourceHealth: { healthy: 0, unknown: 1 },
    deliveries: [delivery],
    scanIntervalMs: 900_000,
  });

  assert.equal(recorded.refillFailureCount, 0);
  assert.equal(recorded.refillCount, 1);
  assert.equal(recorded.nextRefillAt, '2026-07-20T00:15:00.000Z');
});

test('scan records require an interval and honor an explicit failure', async () => {
  const { machine } = await prepared();
  const target = await radarBatch(machine);
  const claim = await machine.claimBatchRefill(target);

  await assert.rejects(machine.recordBatchRefill({
    ...target, claimToken: claim.claimToken, sourceHealth: { healthy: 1 }, deliveries: [],
  }), /scanIntervalMs/);
  const failed = await machine.recordBatchRefill({
    ...target,
    claimToken: claim.claimToken,
    sourceHealth: { healthy: 3 },
    deliveries: [],
    scanIntervalMs: 900_000,
    failed: true,
  });
  assert.equal(failed.refillFailureCount, 1);
  assert.equal(failed.nextRefillAt, '2026-07-20T00:01:00.000Z');
});

test('recent delivery lookup includes forced drips and stays channel-local', async () => {
  const { store, machine, outputs } = await prepared();
  const other = new DeliveryStateMachine({
    store,
    channelId: 'other-channel',
    clock: () => new Date('2026-07-20T00:00:00.000Z'),
  });
  await machine.prepareDelivery({
    requestId: 'forced-yesterday',
    mode: 'drip',
    publishingDay: '2026-07-19',
    articles: [{ ...article, id: 'forced', url: 'https://example.com/forced' }],
    outputs,
    forceKind: 'force',
  });
  await other.prepareDelivery({
    requestId: 'other-channel-item',
    mode: 'drip',
    publishingDay: '2026-07-20',
    articles: [{ ...article, id: 'other', url: 'https://example.com/other' }],
    outputs: [new RecordingOutput({ key: 'x:one' })],
  });

  const deliveries = await machine.listDeliveriesForPublishingDays(['2026-07-20', '2026-07-19']);
  assert.deepEqual(deliveries.map(delivery => delivery.requestId).sort(), ['forced-yesterday', 'request-1']);
});

test('orphan adoption checks only the deterministic current batch after large retained history', async () => {
  const { store, machine, outputs } = await prepared();
  const publishingDay = '2026-07-20';
  const batchId = 'z-current-drip-batch';
  const topology = 'source-topology-current';
  const dripDelivery = await machine.prepareDelivery({
    requestId: 'current-drip-request',
    mode: 'drip',
    publishingDay,
    articles: [{ ...article, id: 'current-drip-article', url: 'https://example.com/current-drip' }],
    outputs,
  });
  await machine.ensureDayBatch({
    batchId,
    publishingDay,
    mode: 'drip',
    sourceTopologyFingerprint: topology,
    sourceHealth: { exhaustionEligible: true },
    deliveries: [dripDelivery],
  });
  await store.transact(tx => {
    for (let index = 0; index < 1_000; index += 1) {
      const itemId = `a-history-${String(index).padStart(4, '0')}`;
      tx.put('batch_items', itemId, {
        itemId,
        channelId: 'telegram-main',
        batchId: `history-batch-${index}`,
        position: 0,
        deliveryId: `history-delivery-${index}`,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }, { expectedVersion: 0 });
    }
  });

  const adopted = await machine.adoptOrphanedDripDeliveries({
    batchId,
    publishingDay,
    sourceTopologyFingerprint: topology,
  });

  assert.equal(adopted.adoptedCount, 0);
  assert.equal((await machine.listBatchItems(batchId)).length, 1);
});

test('pause idempotency rejects reuse for a different control payload', async () => {
  const { machine } = await prepared();
  const first = await machine.setPaused(true, {
    expectedVersion: 1,
    idempotencyKey: 'pause-key',
    operatorId: 'ops-key-1',
    reason: 'maintenance window',
  });
  const replay = await machine.setPaused(true, {
    expectedVersion: 1,
    idempotencyKey: 'pause-key',
    operatorId: 'ops-key-1',
    reason: 'maintenance window',
  });
  assert.equal(replay.version, first.version);

  await assert.rejects(machine.setPaused(false, {
    expectedVersion: first.version,
    idempotencyKey: 'pause-key',
    operatorId: 'ops-key-1',
    reason: 'resume with reused key',
  }), /Idempotency key conflicts/i);
});

test('active article pointer prevents cross-day automatic reselection', async () => {
  const { machine, delivery, outputs } = await prepared();
  const nextDay = await machine.prepareDelivery({
    requestId: 'request-next-day',
    mode: 'drip',
    publishingDay: '2026-07-21',
    articles: [article],
    outputs,
  });
  assert.equal(nextDay.deliveryId, delivery.deliveryId);
  assert.equal(nextDay.resumed, true);
});

test('abandon releases ambiguity and permanently suppresses articles', async () => {
  const { machine, delivery } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const first = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(first.attempt.attemptId, { success: false, error: 'unknown' });
  const current = await machine.getDelivery(delivery.deliveryId);

  await machine.reconcile({
    action: 'abandon',
    deliveryId: delivery.deliveryId,
    expectedVersion: current.version,
    idempotencyKey: 'abandon-1',
    operatorId: 'ops-key-1',
    reason: 'duplicate risk is unacceptable',
  });

  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'abandoned');
  assert.equal((await machine.getChannelState()).mutationState, 'free');
  const ledger = (await machine.listArticleRecords())[0];
  assert.equal(ledger.safetySuppressed, true);
  assert.equal(ledger.activeDeliveryId, null);
});

test('operator generation retry is versioned, linked, and immediately claimed', async () => {
  const { machine, delivery } = await prepared();
  const first = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  const exhausted = await machine.failGeneration(first.attempt.attemptId, new Error('poison'), {
    retryDisposition: 'never',
  });
  assert.equal(exhausted.state, 'generation_exhausted');

  const retry = await machine.reconcile({
    action: 'retry-generation',
    deliveryId: delivery.deliveryId,
    expectedVersion: exhausted.version,
    idempotencyKey: 'retry-generation-1',
    operatorId: 'ops-key-1',
    reason: 'prompt corrected',
    requestId: 'operator-generation-1',
  });
  assert.equal(retry.status, 'claimed');
  assert.equal(retry.attempt.kind, 'generation');
  assert.equal(retry.attempt.requestId, 'operator-generation-1');
  const ready = await machine.commitGeneration(retry.attempt.attemptId, { content: 'recovered content' });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(await machine.store.get('requests', 'operator-generation-1'), {
    ...(await machine.store.get('requests', 'operator-generation-1')),
    state: 'completed',
    outcome: 'success',
    reason: 'generation_ready',
    runAttemptId: null,
    deadlineAt: null,
  });
});

test('maintenance dead-letter retry claims only the immutable mirror row', async () => {
  const { machine, delivery } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const output = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(output.attempt.attemptId, {
    success: true,
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });
  const claimed = await machine.claimMaintenance();
  const dead = await machine.commitMaintenance(claimed.outboxId, { success: false, error: 'KV unavailable', maxAttempts: 1 });
  assert.equal(dead.state, 'dead_letter');

  const retry = await machine.reconcile({
    action: 'retry-maintenance',
    outboxId: dead.outboxId,
    expectedVersion: dead.version,
    idempotencyKey: 'retry-maintenance-1',
    operatorId: 'ops-key-1',
    reason: 'KV recovered',
  });
  assert.equal(retry.status, 'claimed');
  assert.equal(retry.outbox.targetKey, dead.targetKey);
  assert.equal(retry.outbox.targetValue, dead.targetValue);
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'succeeded');
});

test('paused maintenance claims an authorized row behind more than one thousand ordinary rows', async () => {
  const { store, machine } = await prepared();
  const channel = await machine.getChannelState();
  await machine.setPaused(true, {
    expectedVersion: channel.version,
    idempotencyKey: 'pause-large-maintenance-backlog',
    operatorId: 'ops-key-1',
    reason: 'exercise bounded paused maintenance selection',
  });
  const now = '2026-07-20T00:00:00.000Z';
  await store.transact(tx => {
    for (let index = 0; index < 1_001; index += 1) {
      const outboxId = `a-ordinary-${String(index).padStart(4, '0')}`;
      tx.put('maintenance_outbox', outboxId, {
        outboxId,
        channelId: 'telegram-main',
        state: 'pending',
        attemptCount: 0,
        deadlineAt: null,
        nextAttemptAt: null,
        pauseOverrideActionId: null,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
    }
    tx.put('maintenance_outbox', 'z-authorized-override', {
      outboxId: 'z-authorized-override',
      channelId: 'telegram-main',
      state: 'retry_pending',
      attemptCount: 1,
      deadlineAt: null,
      nextAttemptAt: null,
      pauseOverrideActionId: 'authorized-maintenance-action',
      createdAt: now,
      updatedAt: now,
    }, { expectedVersion: 0 });
  });

  const claimed = await machine.claimMaintenance();

  assert.equal(claimed.outboxId, 'z-authorized-override');
  assert.equal(claimed.state, 'attempting');
});

test('unpaused maintenance claims a due row behind more than one thousand deferred rows', async () => {
  const { store, machine } = await prepared();
  const now = '2026-07-20T00:00:00.000Z';
  await store.transact(tx => {
    for (let index = 0; index < 1_001; index += 1) {
      const outboxId = `a-deferred-${String(index).padStart(4, '0')}`;
      tx.put('maintenance_outbox', outboxId, {
        outboxId,
        channelId: 'telegram-main',
        state: 'retry_pending',
        attemptCount: 1,
        deadlineAt: null,
        nextAttemptAt: '2026-07-21T00:00:00.000Z',
        pauseOverrideActionId: null,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
    }
    tx.put('maintenance_outbox', 'z-due-maintenance', {
      outboxId: 'z-due-maintenance',
      channelId: 'telegram-main',
      state: 'pending',
      attemptCount: 0,
      deadlineAt: null,
      nextAttemptAt: null,
      pauseOverrideActionId: null,
      createdAt: now,
      updatedAt: now,
    }, { expectedVersion: 0 });
  });

  const claimed = await machine.claimMaintenance();

  assert.equal(claimed.outboxId, 'z-due-maintenance');
  assert.equal(claimed.state, 'attempting');
});

test('maintenance claims are isolated when channels share one durable store', async () => {
  const store = new MemoryDeliveryStore({ durable: true });
  const machineA = new DeliveryStateMachine({ store, channelId: 'channel-a' });
  const machineB = new DeliveryStateMachine({ store, channelId: 'channel-b' });
  const delivery = await machineB.prepareDelivery({
    requestId: 'channel-b-request',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [new RecordingOutput({ key: 'telegram:channel-b' })],
  });
  const generation = await machineB.claimGeneration(delivery.deliveryId, { requestId: 'channel-b-request' });
  await machineB.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const output = await machineB.claimNextOutput(delivery.deliveryId, { requestId: 'channel-b-request' });
  await machineB.commitOutput(output.attempt.attemptId, {
    success: true,
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });

  assert.equal(await machineA.claimMaintenance(), null);
  const claimedByB = await machineB.claimMaintenance();
  assert.equal(claimedByB.channelId, 'channel-b');
});

test('stale-attempt recovery is isolated when channels share one durable store', async () => {
  let current = new Date('2026-07-20T00:00:00.000Z');
  const store = new MemoryDeliveryStore({ durable: true });
  const options = {
    store,
    clock: () => new Date(current),
    attemptTimeoutMs: 1_000,
  };
  const machineA = new DeliveryStateMachine({ ...options, channelId: 'channel-a' });
  const machineB = new DeliveryStateMachine({ ...options, channelId: 'channel-b' });
  const delivery = await machineB.prepareDelivery({
    requestId: 'channel-b-stale',
    mode: 'digest',
    publishingDay: '2026-07-20',
    articles: [article],
    outputs: [new RecordingOutput({ key: 'telegram:channel-b-stale' })],
  });
  const generation = await machineB.claimGeneration(delivery.deliveryId, {
    requestId: 'channel-b-stale',
  });
  current = new Date('2026-07-20T00:00:02.000Z');

  const unrelatedRecovery = await machineA.recoverStaleAttempts();
  assert.deepEqual(unrelatedRecovery, {
    generationExpired: 0,
    outputAmbiguous: 0,
    maintenanceRecovered: 0,
  });
  assert.equal((await machineB.getAttempt(generation.attempt.attemptId)).state, 'attempting');

  const ownerRecovery = await machineB.recoverStaleAttempts();
  assert.equal(ownerRecovery.generationExpired, 1);
  assert.equal((await machineB.getAttempt(generation.attempt.attemptId)).state, 'generation_expired');
});

test('expired maintenance claim is recovered without changing authoritative delivery success', async () => {
  const { store, machine, delivery, setNow } = await prepared();
  const generation = await machine.claimGeneration(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitGeneration(generation.attempt.attemptId, { content: 'generated' });
  const output = await machine.claimNextOutput(delivery.deliveryId, { requestId: 'request-1' });
  await machine.commitOutput(output.attempt.attemptId, {
    success: true,
    meta: { deliveryState: 'success', retryDisposition: 'never' },
  });
  const claimed = await machine.claimMaintenance();
  await store.transact(tx => {
    for (const row of tx.list('maintenance_outbox', value => value.outboxId !== claimed.outboxId)) {
      tx.put('maintenance_outbox', row.outboxId, {
        ...row,
        state: 'succeeded',
      }, { expectedVersion: row.version });
    }
  });

  setNow('2026-07-20T00:00:31.000Z');
  const recovered = await machine.recoverStaleAttempts();
  const retried = await machine.claimMaintenance();

  assert.equal(recovered.maintenanceRecovered, 1);
  assert.equal(retried.outboxId, claimed.outboxId);
  assert.equal(retried.attemptCount, 2);
  assert.equal((await machine.getDelivery(delivery.deliveryId)).state, 'succeeded');
});
