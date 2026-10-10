import {
  buildOutputTopology,
  channelArticleHash,
  normalizeSendResult,
  opaqueId,
  projectArticle,
  sanitizeError,
} from './delivery.js';
import { assertDeliveryStore } from './delivery-store.js';

const TRANSITIONS = Object.freeze({
  attempt: {
    attempting: new Set(['succeeded', 'definitive_failed', 'ambiguous', 'generation_expired']),
  },
  output: {
    pending: new Set(['attempting', 'abandoned']),
    attempting: new Set(['succeeded', 'automatic_retry_pending', 'manual_retry_required', 'needs_reconciliation', 'exhausted', 'abandoned']),
    automatic_retry_pending: new Set(['attempting', 'exhausted', 'abandoned']),
    manual_retry_required: new Set(['manual_retry_pending', 'attempting', 'abandoned']),
    manual_retry_pending: new Set(['attempting', 'abandoned']),
    needs_reconciliation: new Set(['manual_retry_pending', 'attempting', 'succeeded', 'abandoned']),
    exhausted: new Set(['manual_retry_pending', 'attempting', 'abandoned']),
    succeeded: new Set(),
    abandoned: new Set(),
  },
  delivery: {
    pending_generation: new Set(['generating', 'blocked_topology', 'abandoned']),
    generating: new Set(['ready', 'generation_retry_pending', 'generation_exhausted', 'abandoned']),
    generation_retry_pending: new Set(['generating', 'manual_generation_retry_pending', 'generation_exhausted', 'blocked_topology', 'abandoned']),
    manual_generation_retry_pending: new Set(['generating', 'blocked_topology', 'abandoned']),
    generation_exhausted: new Set(['manual_generation_retry_pending', 'generating', 'blocked_topology', 'abandoned']),
    ready: new Set(['delivering', 'succeeded', 'blocked_topology', 'abandoned']),
    delivering: new Set(['ready', 'partial_retryable', 'output_manual_retry_required', 'output_exhausted', 'needs_reconciliation', 'succeeded', 'abandoned']),
    partial_retryable: new Set(['delivering', 'blocked_topology', 'abandoned']),
    output_manual_retry_required: new Set(['delivering', 'blocked_topology', 'abandoned']),
    output_exhausted: new Set(['delivering', 'blocked_topology', 'abandoned']),
    blocked_topology: new Set([
      'pending_generation', 'generation_retry_pending', 'manual_generation_retry_pending',
      'generation_exhausted', 'ready', 'partial_retryable',
      'output_manual_retry_required', 'output_exhausted', 'abandoned',
    ]),
    needs_reconciliation: new Set(['ready', 'delivering', 'succeeded', 'abandoned']),
    succeeded: new Set(),
    abandoned: new Set(),
  },
});

/**
 * Default time budgets for one attempt. An output or generation call has to finish inside the lease
 * that guards it: a call still running when its lease lapses is recovered as ambiguous, and an
 * ambiguous output blocks the whole channel until an operator reconciles it. So the budgets nest,
 * output (and generation) call < attempt lease, and the output call outlasts a provider's own
 * per-request timeout, which would otherwise be cut off by the engine before it can answer.
 * They must also leave room, inside the shutdown wait, for a source scan: a deploy that kills the
 * process in the middle of a send leaves that output ambiguous.
 * The engine, this state machine, and operator retries all read these so they cannot drift apart.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
export const DEFAULT_GENERATION_TIMEOUT_MS = 25_000;
export const DEFAULT_OUTPUT_TIMEOUT_MS = 60_000;

const TERMINAL_DELIVERY_STATES = new Set(['succeeded', 'abandoned']);
const TERMINAL_OUTPUT_STATES = new Set(['succeeded', 'abandoned']);
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SCAN_FAILURE_STREAK = 10;
const MAX_SCAN_BACKOFF_MS = 60 * 60 * 1_000;
const RECENT_DELIVERY_LOOKUP_LIMIT = 500;

export class DeliveryStateMachine {
  constructor({
    store,
    channelId,
    clock = () => new Date(),
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    maxGenerationAttempts = 3,
    maxOutputAttempts = 3,
    allowEphemeral = false,
  }) {
    this.store = assertDeliveryStore(store, { allowEphemeral });
    this.channelId = requiredString(channelId, 'channelId');
    this.clock = clock;
    this.attemptTimeoutMs = positiveInteger(attemptTimeoutMs, 'attemptTimeoutMs');
    this.maxGenerationAttempts = positiveInteger(maxGenerationAttempts, 'maxGenerationAttempts');
    this.maxOutputAttempts = positiveInteger(maxOutputAttempts, 'maxOutputAttempts');
  }

  async prepareDelivery({ requestId, mode, publishingDay, articles, outputs, forceKind = null, singleMutation = false }) {
    requiredString(requestId, 'requestId');
    if (!['digest', 'drip'].includes(mode)) throw new Error('Delivery mode must be digest or drip');
    requiredString(publishingDay, 'publishingDay');
    if (!Array.isArray(articles) || articles.length === 0) throw new Error('Delivery requires at least one article');
    const snapshots = articles.map(projectArticle);
    const hashes = [];
    for (const snapshot of snapshots) hashes.push(await channelArticleHash(this.channelId, snapshot));
    if (new Set(hashes).size !== hashes.length) throw new Error('Duplicate article identity in delivery');
    const topology = await buildOutputTopology(outputs);
    const deliveryId = await opaqueId(
      'delivery', this.channelId, forceKind ?? 'normal', mode, requestId, ...hashes,
    );
    const now = this._nowIso();

    return this.store.transact(tx => {
      const channel = ensureChannel(tx, this.channelId, now);
      if (channel.paused && forceKind !== 'operator') {
        return { status: 'blocked', reason: 'channel_paused', deliveryId: null };
      }

      const activeIds = new Set();
      let suppressed = false;
      for (const hash of hashes) {
        const ledger = tx.get('articles', hash);
        if (ledger?.safetySuppressed || ledger?.terminalState === 'succeeded') suppressed = true;
        if (ledger?.activeDeliveryId) activeIds.add(ledger.activeDeliveryId);
      }
      if (activeIds.size > 1) throw new Error('Articles are owned by different active deliveries');
      if (activeIds.size === 1) {
        const activeDeliveryId = [...activeIds][0];
        const active = tx.get('deliveries', activeDeliveryId);
        if (!active || TERMINAL_DELIVERY_STATES.has(active.state)) {
          throw new Error('Article ledger points to an invalid active delivery');
        }
        if (Boolean(active.singleMutation) !== Boolean(singleMutation)) {
          throw new Error('Delivery single-mutation policy changed while active');
        }
        if (active.topologyFingerprint !== topology.fingerprint) {
          if (active.state === 'blocked_topology') {
            return { ...active, resumed: true, status: 'blocked' };
          }
          assertDeliveryTransition('delivery', active.state, 'blocked_topology');
          tx.put('deliveries', active.deliveryId, {
            ...active,
            state: 'blocked_topology',
            reason: 'output_topology_changed',
            topologyBlockedFromState: active.state,
            updatedAt: now,
          }, { expectedVersion: active.version });
          return { ...active, state: 'blocked_topology', resumed: true, status: 'blocked' };
        }
        if (active.state === 'blocked_topology') {
          return { ...active, resumed: true, status: 'blocked', reason: 'topology_restore_required' };
        }
        return { ...active, resumed: true, status: 'resumed' };
      }
      if (suppressed && !forceKind) return { status: 'suppressed', reason: 'article_terminal', deliveryId: null };

      const existing = tx.get('deliveries', deliveryId);
      if (existing) {
        if (Boolean(existing.singleMutation) !== Boolean(singleMutation)) {
          throw new Error('Delivery id conflicts with a different single-mutation policy');
        }
        return { ...existing, resumed: true, status: existing.state };
      }

      const delivery = tx.put('deliveries', deliveryId, {
        deliveryId,
        channelId: this.channelId,
        requestId,
        mode,
        publishingDay,
        forceKind,
        singleMutation: Boolean(singleMutation),
        state: 'pending_generation',
        articleHashes: hashes,
        articleSnapshot: snapshots,
        generatedContent: null,
        contentChecksum: null,
        outputTopology: topology.outputs,
        topologyFingerprint: topology.fingerprint,
        outputSummary: {
          total: topology.outputs.length,
          succeeded: 0,
          unresolved: topology.outputs.length,
          ambiguous: 0,
        },
        generationAttemptCount: 0,
        authorizedRetryRequestId: null,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });

      hashes.forEach((hash, index) => {
        const current = tx.get('articles', hash);
        tx.put('articles', hash, {
          articleHash: hash,
          sourceKey: snapshots[index].source,
          firstSeenAt: current?.firstSeenAt ?? now,
          activeDeliveryId: deliveryId,
          terminalState: current?.terminalState ?? null,
          safetySuppressed: current?.safetySuppressed ?? false,
          lastPublishingDay: publishingDay,
          updatedAt: now,
        }, { expectedVersion: current?.version ?? 0 });
      });

      topology.outputs.forEach(output => {
        const outputId = outputRecordId(deliveryId, output.outputKey);
        tx.put('delivery_outputs', outputId, {
          deliveryId,
          outputKey: output.outputKey,
          providerId: output.providerId,
          ordinal: output.ordinal,
          state: 'pending',
          attemptCount: 0,
          retryDisposition: null,
          nextAttemptAt: null,
          authorizedRetryRequestId: null,
          successfulMessageIds: [],
          partialMutation: null,
          sanitizedError: null,
          activeAttemptId: null,
          updatedAt: now,
        }, { expectedVersion: 0 });
      });
      return { ...delivery, resumed: false, status: 'created' };
    });
  }

  async validateOutputTopology(deliveryId, outputs) {
    const topology = await buildOutputTopology(outputs);
    const now = this._nowIso();
    return this.store.transact(tx => {
      const delivery = requireRecord(tx, 'deliveries', deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      if (delivery.topologyFingerprint === topology.fingerprint) {
        if (delivery.state === 'blocked_topology') {
          return { status: 'blocked', reason: 'topology_restore_required', delivery, topology };
        }
        return { status: 'valid', delivery, topology };
      }
      const blockable = new Set([
        'pending_generation', 'generation_retry_pending', 'manual_generation_retry_pending',
        'generation_exhausted', 'ready', 'partial_retryable',
        'output_manual_retry_required', 'output_exhausted',
      ]);
      if (!blockable.has(delivery.state)) {
        return { status: 'blocked', reason: 'output_topology_changed', delivery, topology };
      }
      assertDeliveryTransition('delivery', delivery.state, 'blocked_topology');
      const blocked = tx.put('deliveries', delivery.deliveryId, {
        ...delivery,
        state: 'blocked_topology',
        reason: 'output_topology_changed',
        topologyBlockedFromState: delivery.state,
        updatedAt: now,
      }, { expectedVersion: delivery.version });
      return { status: 'blocked', reason: 'output_topology_changed', delivery: blocked, topology };
    });
  }

  async claimGeneration(deliveryId, { requestId, confirmPausedMutation = false }) {
    const attemptId = crypto.randomUUID();
    const now = this._now();
    return this.store.transact(tx => {
      const delivery = requireRecord(tx, 'deliveries', deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      const channel = ensureChannel(tx, this.channelId, now.toISOString());
      if (channel.paused && !confirmPausedMutation) return { status: 'blocked', reason: 'channel_paused' };
      if (delivery.state === 'ready' || delivery.generatedContent) return { status: 'ready', delivery };
      const eligible = new Set(['pending_generation', 'generation_retry_pending', 'manual_generation_retry_pending']);
      if (!eligible.has(delivery.state)) return { status: 'blocked', reason: delivery.state };
      if (delivery.state === 'generation_retry_pending' && delivery.nextGenerationAttemptAt && new Date(delivery.nextGenerationAttemptAt) > now) {
        return { status: 'blocked', reason: 'generation_backoff' };
      }
      if (delivery.state === 'manual_generation_retry_pending' && delivery.authorizedRetryRequestId !== requestId) {
        return { status: 'blocked', reason: 'generation_retry_not_authorized' };
      }
      if (delivery.generationAttemptCount >= this.maxGenerationAttempts) {
        return { status: 'blocked', reason: 'generation_attempts_exhausted' };
      }
      assertDeliveryTransition('delivery', delivery.state, 'generating');
      const attempt = tx.put('attempts', attemptId, {
        attemptId,
        channelId: this.channelId,
        deliveryId,
        outputKey: null,
        kind: 'generation',
        requestId,
        state: 'attempting',
        claimedVersion: delivery.version,
        startedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
        completedAt: null,
      }, { expectedVersion: 0 });
      tx.put('deliveries', deliveryId, {
        ...delivery,
        state: 'generating',
        generationAttemptCount: delivery.generationAttemptCount + 1,
        activeGenerationAttemptId: attemptId,
        updatedAt: now.toISOString(),
      }, { expectedVersion: delivery.version });
      return { status: 'claimed', attempt };
    });
  }

  async commitGeneration(attemptId, { content }) {
    const boundedContent = requiredString(content, 'generated content', 64 * 1024);
    const checksum = await opaqueId('content', boundedContent);
    const now = this._nowIso();
    return this.store.transact(tx => {
      const attempt = requireRecord(tx, 'attempts', attemptId);
      if (attempt.kind !== 'generation' || attempt.state !== 'attempting') throw new Error('Generation attempt is not active');
      const delivery = requireRecord(tx, 'deliveries', attempt.deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      if (delivery.activeGenerationAttemptId !== attemptId || delivery.state !== 'generating') {
        throw new Error('Generation attempt no longer owns the delivery');
      }
      assertDeliveryTransition('attempt', attempt.state, 'succeeded');
      assertDeliveryTransition('delivery', delivery.state, 'ready');
      tx.put('attempts', attemptId, {
        ...attempt, state: 'succeeded', completedAt: now,
      }, { expectedVersion: attempt.version });
      const updated = tx.put('deliveries', delivery.deliveryId, {
        ...delivery,
        state: 'ready',
        generatedContent: boundedContent,
        contentChecksum: checksum,
        activeGenerationAttemptId: null,
        authorizedRetryRequestId: null,
        updatedAt: now,
      }, { expectedVersion: delivery.version });
      completeOperatorRetryRequest(tx, attempt, {
        state: 'completed', outcome: 'success', reason: 'generation_ready', delivery: updated, now,
      });
      return updated;
    });
  }

  async failGeneration(attemptId, error, { retryDisposition = 'automatic', retryAfterMs = 1_000 } = {}) {
    const now = this._now();
    return this.store.transact(tx => {
      const attempt = requireRecord(tx, 'attempts', attemptId);
      if (attempt.kind !== 'generation' || attempt.state !== 'attempting') throw new Error('Generation attempt is not active');
      const delivery = requireRecord(tx, 'deliveries', attempt.deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      const exhausted = delivery.generationAttemptCount >= this.maxGenerationAttempts || retryDisposition === 'never';
      const nextState = exhausted ? 'generation_exhausted' : 'generation_retry_pending';
      assertDeliveryTransition('attempt', attempt.state, 'definitive_failed');
      assertDeliveryTransition('delivery', delivery.state, nextState);
      tx.put('attempts', attemptId, {
        ...attempt,
        state: 'definitive_failed',
        completedAt: now.toISOString(),
        classifiedResult: { retryDisposition, sanitizedError: sanitizeError(error) },
      }, { expectedVersion: attempt.version });
      const updated = tx.put('deliveries', delivery.deliveryId, {
        ...delivery,
        state: nextState,
        activeGenerationAttemptId: null,
        nextGenerationAttemptAt: exhausted ? null : new Date(now.getTime() + retryAfterMs).toISOString(),
        sanitizedError: sanitizeError(error),
        updatedAt: now.toISOString(),
      }, { expectedVersion: delivery.version });
      completeOperatorRetryRequest(tx, attempt, {
        state: 'completed', outcome: 'failed', reason: nextState, delivery: updated, now: now.toISOString(),
      });
      return updated;
    });
  }

  async claimNextOutput(deliveryId, { requestId, confirmPausedMutation = false }) {
    const attemptId = crypto.randomUUID();
    const now = this._now();
    return this.store.transact(tx => {
      const delivery = requireRecord(tx, 'deliveries', deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      const channel = ensureChannel(tx, this.channelId, now.toISOString());
      if (channel.paused && !confirmPausedMutation) return { status: 'blocked', reason: 'channel_paused' };
      if (channel.mutationState === 'blocked_ambiguous') return { status: 'blocked', reason: 'channel_blocked_ambiguous' };
      if (channel.mutationState === 'active') return { status: 'blocked', reason: 'channel_busy' };
      if (!delivery.generatedContent || !['ready', 'delivering', 'partial_retryable', 'output_manual_retry_required', 'output_exhausted'].includes(delivery.state)) {
        return { status: 'blocked', reason: delivery.state };
      }
      const outputs = deliveryOutputs(tx, deliveryId);
      if (outputs.every(output => TERMINAL_OUTPUT_STATES.has(output.state))) {
        return { status: 'complete', delivery };
      }
      const output = outputs.find(record => !TERMINAL_OUTPUT_STATES.has(record.state));
      if (!output) return { status: 'complete', delivery };
      if (output.state === 'automatic_retry_pending' && output.nextAttemptAt && new Date(output.nextAttemptAt) > now) {
        return { status: 'blocked', reason: 'output_backoff', output };
      }
      if (output.state === 'manual_retry_pending' && output.authorizedRetryRequestId !== requestId) {
        return { status: 'blocked', reason: 'output_retry_not_authorized', output };
      }
      if (!['pending', 'automatic_retry_pending', 'manual_retry_pending'].includes(output.state)) {
        return { status: 'blocked', reason: output.state, output };
      }
      if (output.attemptCount >= this.maxOutputAttempts && output.state !== 'manual_retry_pending') {
        return { status: 'blocked', reason: 'output_attempts_exhausted', output };
      }
      return claimOutputInTransaction({
        tx,
        attemptId,
        requestId,
        delivery,
        output,
        channel,
        now,
        attemptTimeoutMs: this.attemptTimeoutMs,
      });
    });
  }

  async commitOutput(attemptId, rawResult) {
    const now = this._now();
    const result = normalizeSendResult(rawResult, { now: now.getTime() });
    return this.store.transact(tx => {
      const attempt = requireRecord(tx, 'attempts', attemptId);
      if (attempt.kind !== 'output' || attempt.state !== 'attempting') throw new Error('Output attempt is not active');
      const outputId = outputRecordId(attempt.deliveryId, attempt.outputKey);
      const output = requireRecord(tx, 'delivery_outputs', outputId);
      const delivery = requireRecord(tx, 'deliveries', attempt.deliveryId);
      assertDeliveryChannel(delivery, this.channelId);
      const channel = requireRecord(tx, 'channel_state', this.channelId);
      if (output.activeAttemptId !== attemptId || channel.activeOutputAttemptId !== attemptId) {
        throw new Error('Output attempt no longer owns the channel mutation lease');
      }

      let attemptState;
      let outputState;
      if (result.meta.deliveryState === 'success') {
        attemptState = 'succeeded';
        outputState = 'succeeded';
      } else if (result.meta.deliveryState === 'ambiguous') {
        attemptState = 'ambiguous';
        outputState = 'needs_reconciliation';
      } else {
        attemptState = 'definitive_failed';
        if (result.meta.retryDisposition === 'automatic' && output.attemptCount < this.maxOutputAttempts) {
          outputState = 'automatic_retry_pending';
        } else if (result.meta.retryDisposition === 'manual') {
          outputState = 'manual_retry_required';
        } else {
          outputState = 'exhausted';
        }
      }
      const ambiguous = outputState === 'needs_reconciliation';
      assertDeliveryTransition('attempt', attempt.state, attemptState);
      assertDeliveryTransition('output', output.state, outputState);
      tx.put('attempts', attemptId, {
        ...attempt,
        state: attemptState,
        completedAt: now.toISOString(),
        classifiedResult: result.meta,
      }, { expectedVersion: attempt.version });
      tx.put('delivery_outputs', outputId, {
        ...output,
        state: outputState,
        retryDisposition: result.meta.retryDisposition,
        nextAttemptAt: outputState === 'automatic_retry_pending' ? result.meta.nextAttemptAt ?? new Date(now.getTime() + 1_000).toISOString() : null,
        authorizedRetryRequestId: null,
        successfulMessageIds: result.meta.successfulMessageIds ?? output.successfulMessageIds,
        partialMutation: result.meta.partialMutation ?? null,
        sanitizedError: result.meta.sanitizedError ?? null,
        activeAttemptId: ambiguous ? attemptId : null,
        updatedAt: now.toISOString(),
      }, { expectedVersion: output.version });
      tx.put('channel_state', this.channelId, {
        ...channel,
        mutationState: ambiguous ? 'blocked_ambiguous' : 'free',
        activeOutputAttemptId: ambiguous ? attemptId : null,
        updatedAt: now.toISOString(),
      }, { expectedVersion: channel.version });
      const updatedDelivery = aggregateDelivery(tx, delivery.deliveryId, now.toISOString());
      completeOperatorRetryRequest(tx, attempt, {
        state: outputState === 'needs_reconciliation' ? 'blocked' : 'completed',
        outcome: outputState === 'succeeded' ? 'success' : outputState === 'needs_reconciliation' ? 'ambiguous' : 'failed',
        reason: outputState,
        delivery: updatedDelivery,
        now: now.toISOString(),
      });
      return { delivery: updatedDelivery, result };
    });
  }

  async recoverStaleAttempts() {
    const now = this._now();
    return this.store.transact(tx => {
      const summary = { generationExpired: 0, outputAmbiguous: 0, maintenanceRecovered: 0 };
      const attempts = [
        ...tx.query('attempts', { channelId: this.channelId, state: 'attempting' }),
        ...tx.query('attempts', { channelId: null, state: 'attempting' }),
      ].filter(attempt => new Date(attempt.deadlineAt) <= now);
      for (const attempt of attempts) {
        const delivery = requireRecord(tx, 'deliveries', attempt.deliveryId);
        if (delivery.channelId !== this.channelId) continue;
        if (attempt.kind === 'generation') {
          assertDeliveryTransition('attempt', attempt.state, 'generation_expired');
          const exhausted = delivery.generationAttemptCount >= this.maxGenerationAttempts;
          const nextState = exhausted ? 'generation_exhausted' : 'generation_retry_pending';
          assertDeliveryTransition('delivery', delivery.state, nextState);
          tx.put('attempts', attempt.attemptId, {
            ...attempt, state: 'generation_expired', completedAt: now.toISOString(),
          }, { expectedVersion: attempt.version });
          const updated = tx.put('deliveries', delivery.deliveryId, {
            ...delivery,
            state: nextState,
            activeGenerationAttemptId: null,
            nextGenerationAttemptAt: exhausted ? null : now.toISOString(),
            updatedAt: now.toISOString(),
          }, { expectedVersion: delivery.version });
          completeOperatorRetryRequest(tx, attempt, {
            state: 'completed', outcome: 'failed', reason: 'generation_expired', delivery: updated, now: now.toISOString(),
          });
          summary.generationExpired += 1;
          continue;
        }
        const outputId = outputRecordId(attempt.deliveryId, attempt.outputKey);
        const output = requireRecord(tx, 'delivery_outputs', outputId);
        const channel = requireRecord(tx, 'channel_state', this.channelId);
        assertDeliveryTransition('attempt', attempt.state, 'ambiguous');
        assertDeliveryTransition('output', output.state, 'needs_reconciliation');
        tx.put('attempts', attempt.attemptId, {
          ...attempt,
          state: 'ambiguous',
          completedAt: now.toISOString(),
          classifiedResult: { deliveryState: 'ambiguous', retryDisposition: 'manual', sanitizedError: 'attempt deadline expired' },
        }, { expectedVersion: attempt.version });
        tx.put('delivery_outputs', outputId, {
          ...output,
          state: 'needs_reconciliation',
          retryDisposition: 'manual',
          sanitizedError: 'attempt deadline expired',
          updatedAt: now.toISOString(),
        }, { expectedVersion: output.version });
        const updated = tx.put('deliveries', delivery.deliveryId, {
          ...delivery, state: 'needs_reconciliation', updatedAt: now.toISOString(),
        }, { expectedVersion: delivery.version });
        tx.put('channel_state', this.channelId, {
          ...channel,
          mutationState: 'blocked_ambiguous',
          activeOutputAttemptId: attempt.attemptId,
          updatedAt: now.toISOString(),
        }, { expectedVersion: channel.version });
        completeOperatorRetryRequest(tx, attempt, {
          state: 'blocked', outcome: 'ambiguous', reason: 'attempt_deadline_expired', delivery: updated, now: now.toISOString(),
        });
        summary.outputAmbiguous += 1;
      }
      for (const row of tx.query('maintenance_outbox', {
        channelId: this.channelId,
        state: 'attempting',
      }).filter(value => value.deadlineAt && new Date(value.deadlineAt) <= now)) {
        const exhausted = row.attemptCount >= 5;
        tx.put('maintenance_outbox', row.outboxId, {
          ...row,
          state: exhausted ? 'dead_letter' : 'retry_pending',
          deadlineAt: null,
          nextAttemptAt: exhausted ? null : now.toISOString(),
          sanitizedError: 'maintenance attempt deadline expired',
          updatedAt: now.toISOString(),
        }, { expectedVersion: row.version });
        summary.maintenanceRecovered += 1;
      }
      return summary;
    });
  }

  async compactHistory() {
    const now = this._now();
    return this.store.transact(tx => compactHistoryInTransaction(tx, this.channelId, now));
  }

  async reconcile(action) {
    const operatorId = requiredString(action.operatorId, 'operatorId');
    const reason = requiredString(action.reason, 'reason', 500);
    const actionKey = await opaqueId('operator-action', this.channelId, requiredString(action.idempotencyKey, 'idempotencyKey'));
    const reasonHash = await opaqueId('operator-reason', this.channelId, reason);
    const payloadFingerprint = await opaqueId(
      'operator-action-payload',
      action.action ?? '',
      action.deliveryId ?? '',
      action.outputKey ?? '',
      action.outboxId ?? '',
      action.requestId ?? '',
      action.expectedVersion ?? '',
      operatorId,
      reasonHash,
      action.messageId ?? '',
      action.confirmPausedMutation === true,
      action.duplicateRiskAccepted === true,
    );
    const attemptId = crypto.randomUUID();
    const now = this._now();
    const transactionResult = await this.store.transact(tx => {
      const existing = tx.get('operator_actions', actionKey);
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint) {
          throw new Error('Idempotency key conflicts with a different operator action');
        }
        return { replayedActionId: actionKey };
      }
      const delivery = action.action === 'retry-maintenance'
        ? null
        : requireRecord(tx, 'deliveries', action.deliveryId);
      if (delivery) assertDeliveryChannel(delivery, this.channelId);
      let result;
      if (action.action === 'retry-generation') {
        if (delivery.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (!['generation_retry_pending', 'generation_exhausted'].includes(delivery.state)) {
          throw new Error(`Delivery state ${delivery.state} cannot retry generation`);
        }
        const channel = requireRecord(tx, 'channel_state', this.channelId);
        if (channel.paused && action.confirmPausedMutation !== true) {
          throw new Error('Paused channel generation retry requires confirmPausedMutation=true');
        }
        const requestId = requiredString(action.requestId, 'requestId');
        assertDeliveryTransition('delivery', delivery.state, 'generating');
        const attempt = tx.put('attempts', attemptId, {
          attemptId,
          channelId: this.channelId,
          deliveryId: delivery.deliveryId,
          outputKey: null,
          kind: 'generation',
          requestId,
          state: 'attempting',
          claimedVersion: delivery.version,
          startedAt: now.toISOString(),
          deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
          completedAt: null,
          operatorActionId: actionKey,
        }, { expectedVersion: 0 });
        tx.put('deliveries', delivery.deliveryId, {
          ...delivery,
          state: 'generating',
          generationAttemptCount: delivery.generationAttemptCount + 1,
          activeGenerationAttemptId: attemptId,
          authorizedRetryRequestId: requestId,
          updatedAt: now.toISOString(),
        }, { expectedVersion: delivery.version });
        startOperatorRetryRequest(tx, {
          requestId,
          channelId: this.channelId,
          action: action.action,
          deliveryId: delivery.deliveryId,
          outputKey: null,
          attempt,
          operatorActionId: actionKey,
          payloadFingerprint,
          now: now.toISOString(),
        });
        result = { status: 'claimed', attempt, articles: delivery.articleSnapshot, delivery };
      } else if (action.action === 'retry-output') {
        const output = requireRecord(tx, 'delivery_outputs', outputRecordId(delivery.deliveryId, action.outputKey));
        if (output.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (!['needs_reconciliation', 'manual_retry_required', 'exhausted'].includes(output.state)) {
          throw new Error(`Output state ${output.state} cannot be retried`);
        }
        if (output.state === 'needs_reconciliation' && action.duplicateRiskAccepted !== true) {
          throw new Error('duplicateRiskAccepted=true is required for ambiguous output retry');
        }
        const channel = requireRecord(tx, 'channel_state', this.channelId);
        if (channel.paused && action.confirmPausedMutation !== true) {
          throw new Error('Paused channel retry requires confirmPausedMutation=true');
        }
        assertRetryOutputLease(tx, channel, delivery, output);
        assertDeliveryTransition('output', output.state, 'attempting');
        assertDeliveryTransition('delivery', delivery.state, 'delivering');
        const requestId = requiredString(action.requestId, 'requestId');
        const attempt = tx.put('attempts', attemptId, {
          attemptId,
          channelId: this.channelId,
          deliveryId: delivery.deliveryId,
          outputKey: output.outputKey,
          kind: 'output',
          requestId,
          state: 'attempting',
          claimedVersion: output.version,
          startedAt: now.toISOString(),
          deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
          completedAt: null,
          operatorActionId: actionKey,
        }, { expectedVersion: 0 });
        tx.put('delivery_outputs', outputRecordId(delivery.deliveryId, output.outputKey), {
          ...output,
          state: 'attempting',
          attemptCount: output.attemptCount + 1,
          authorizedRetryRequestId: requestId,
          activeAttemptId: attemptId,
          updatedAt: now.toISOString(),
        }, { expectedVersion: output.version });
        tx.put('deliveries', delivery.deliveryId, {
          ...delivery,
          state: 'delivering',
          authorizedRetryRequestId: requestId,
          updatedAt: now.toISOString(),
        }, { expectedVersion: delivery.version });
        tx.put('channel_state', this.channelId, {
          ...channel,
          mutationState: 'active',
          activeOutputAttemptId: attemptId,
          updatedAt: now.toISOString(),
        }, { expectedVersion: channel.version });
        startOperatorRetryRequest(tx, {
          requestId,
          channelId: this.channelId,
          action: action.action,
          deliveryId: delivery.deliveryId,
          outputKey: output.outputKey,
          attempt,
          operatorActionId: actionKey,
          payloadFingerprint,
          now: now.toISOString(),
        });
        result = { status: 'claimed', attempt, content: delivery.generatedContent, output, delivery };
      } else if (action.action === 'restore-topology') {
        if (delivery.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (delivery.state !== 'blocked_topology') {
          throw new Error(`Delivery state ${delivery.state} cannot restore topology`);
        }
        const topologyFingerprint = requiredString(action.topologyFingerprint, 'topologyFingerprint');
        if (delivery.topologyFingerprint !== topologyFingerprint) {
          throw new Error('Configured output topology has not been restored');
        }
        result = {
          status: 'restored',
          delivery: restoreTopologyBlockedDelivery(tx, delivery, now.toISOString()),
        };
      } else if (action.action === 'confirm-delivered') {
        const output = requireRecord(tx, 'delivery_outputs', outputRecordId(delivery.deliveryId, action.outputKey));
        if (output.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (output.state !== 'needs_reconciliation') throw new Error('Only ambiguous output can be confirmed');
        const channel = requireRecord(tx, 'channel_state', this.channelId);
        if (channel.mutationState !== 'blocked_ambiguous'
          || !channelLeaseBelongsToOutput(tx, channel, output)) {
          throw new Error('Ambiguous output no longer owns the channel mutation lease');
        }
        assertDeliveryTransition('output', output.state, 'succeeded');
        tx.put('delivery_outputs', outputRecordId(delivery.deliveryId, output.outputKey), {
          ...output,
          state: 'succeeded',
          successfulMessageIds: action.messageId ? [String(action.messageId).slice(0, 200)] : output.successfulMessageIds,
          activeAttemptId: null,
          updatedAt: now.toISOString(),
        }, { expectedVersion: output.version });
        tx.put('channel_state', this.channelId, {
          ...channel, mutationState: 'free', activeOutputAttemptId: null, updatedAt: now.toISOString(),
        }, { expectedVersion: channel.version });
        result = { status: 'confirmed', delivery: aggregateDelivery(tx, delivery.deliveryId, now.toISOString()) };
      } else if (action.action === 'abandon') {
        if (delivery.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (TERMINAL_DELIVERY_STATES.has(delivery.state)) result = { status: delivery.state, delivery };
        else {
          const liveAttempt = tx.query('attempts', {
            deliveryId: delivery.deliveryId,
            state: 'attempting',
          }, { limit: 1 })[0];
          if (liveAttempt) throw new Error('Delivery has an active provider attempt');
          const channel = requireRecord(tx, 'channel_state', this.channelId);
          result = {
            status: 'abandoned',
            delivery: abandonDelivery(tx, delivery, this.channelId, now.toISOString(), reasonHash),
          };
        }
      } else if (action.action === 'retry-maintenance') {
        const outbox = requireRecord(tx, 'maintenance_outbox', action.outboxId);
        if (outbox.channelId !== this.channelId) throw new Error('Maintenance outbox belongs to another channel');
        if (outbox.version !== action.expectedVersion) throw new Error('Operator action version conflict');
        if (outbox.state !== 'dead_letter') throw new Error('Only dead-letter maintenance can be retried');
        const channel = requireRecord(tx, 'channel_state', this.channelId);
        if (channel.paused && action.confirmPausedMutation !== true) {
          throw new Error('Paused maintenance retry requires confirmPausedMutation=true');
        }
        const claimed = tx.put('maintenance_outbox', outbox.outboxId, {
          ...outbox,
          state: 'attempting',
          attemptCount: outbox.attemptCount + 1,
          deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
          nextAttemptAt: null,
          pauseOverrideActionId: channel.paused ? actionKey : null,
          operatorActionId: actionKey,
          updatedAt: now.toISOString(),
        }, { expectedVersion: outbox.version });
        result = { status: 'claimed', outbox: claimed };
      } else {
        throw new Error(`Unsupported reconciliation action: ${action.action}`);
      }
      tx.put('operator_actions', actionKey, {
        actionId: actionKey,
        action: action.action,
        channelId: this.channelId,
        deliveryId: action.deliveryId ?? null,
        outputKey: action.outputKey ?? null,
        operatorId,
        reasonHash,
        requestId: action.requestId ?? null,
        outboxId: action.outboxId ?? null,
        payloadFingerprint,
        state: 'minimized',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        result: operatorActionAuditResult(result, action),
      }, { expectedVersion: 0 });
      return result;
    });
    if (transactionResult.replayedActionId) {
      return this._resolveOperatorAction(transactionResult.replayedActionId);
    }
    return { ...transactionResult, operatorActionId: actionKey, replayed: false };
  }

  async setPaused(paused, { expectedVersion, idempotencyKey, operatorId, reason }) {
    const normalizedOperatorId = requiredString(operatorId, 'operatorId');
    const normalizedReason = requiredString(reason, 'reason', 500);
    const actionKey = await opaqueId('operator-action', this.channelId, requiredString(idempotencyKey, 'idempotencyKey'));
    const reasonHash = await opaqueId('operator-reason', this.channelId, normalizedReason);
    const payloadFingerprint = await opaqueId(
      'operator-action-payload',
      paused ? 'pause' : 'resume',
      expectedVersion ?? '',
      normalizedOperatorId,
      reasonHash,
    );
    const now = this._nowIso();
    const transactionResult = await this.store.transact(tx => {
      const existing = tx.get('operator_actions', actionKey);
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint) {
          throw new Error('Idempotency key conflicts with a different operator action');
        }
        return { replayedActionId: actionKey };
      }
      const channel = ensureChannel(tx, this.channelId, now);
      if (channel.version !== expectedVersion) throw new Error('Operator action version conflict');
      const updated = tx.put('channel_state', this.channelId, {
        ...channel, paused: Boolean(paused), updatedAt: now,
      }, { expectedVersion: channel.version });
      const result = { status: paused ? 'paused' : 'resumed', channel: updated };
      tx.put('operator_actions', actionKey, {
        actionId: actionKey,
        action: paused ? 'pause' : 'resume',
        channelId: this.channelId,
        deliveryId: null,
        outputKey: null,
        operatorId: normalizedOperatorId,
        reasonHash,
        payloadFingerprint,
        state: 'minimized',
        createdAt: now,
        updatedAt: now,
        result: operatorActionAuditResult(result, { requestId: null, outputKey: null }),
      }, { expectedVersion: 0 });
      return result;
    });
    if (transactionResult.replayedActionId) {
      return this._resolveOperatorAction(transactionResult.replayedActionId);
    }
    return transactionResult;
  }

  async claimDeliveryReservation({ reservationId, requestId }) {
    requiredString(reservationId, 'reservationId');
    requiredString(requestId, 'requestId');
    const claimToken = crypto.randomUUID();
    const now = this._now();
    return this.store.transact(tx => {
      const existing = tx.get('delivery_reservations', reservationId);
      if (existing?.deliveryId) return { status: 'linked', reservation: existing };
      if (existing?.state === 'completed') return { status: 'completed', reservation: existing };
      if (
        existing?.state === 'retry_pending'
        && existing.nextAttemptAt
        && new Date(existing.nextAttemptAt) > now
      ) {
        return { status: 'blocked', reason: 'reservation_backoff', reservation: existing };
      }
      const live = existing?.deadlineAt && new Date(existing.deadlineAt) > now;
      if (live && existing.ownerRequestId !== requestId) {
        return { status: 'in_flight', reservation: existing };
      }
      if (live && existing.ownerRequestId === requestId) {
        return { status: 'owned', claimToken: existing.claimToken, reservation: existing };
      }
      const updated = tx.put('delivery_reservations', reservationId, {
        reservationId,
        channelId: this.channelId,
        ownerRequestId: requestId,
        deliveryRequestId: existing?.deliveryRequestId ?? requestId,
        claimToken,
        state: 'preparing',
        articleSnapshot: existing?.articleSnapshot ?? null,
        sourceHealth: existing?.sourceHealth ?? null,
        deliveryId: null,
        attemptCount: Number(existing?.attemptCount ?? 0) + 1,
        nextAttemptAt: null,
        startedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      }, { expectedVersion: existing?.version ?? 0 });
      return { status: 'owned', claimToken, reservation: updated };
    });
  }

  async bindDeliveryReservation(reservationId, claimToken, { articles, sourceHealth }) {
    if (!Array.isArray(articles) || articles.length === 0) throw new Error('Reservation selection requires articles');
    const snapshots = articles.map(projectArticle);
    const now = this._nowIso();
    return this.store.transact(tx => {
      const reservation = requireRecord(tx, 'delivery_reservations', reservationId);
      if (reservation.articleSnapshot) return reservation;
      if (reservation.claimToken !== claimToken || reservation.state !== 'preparing') {
        throw new Error('Delivery reservation is no longer owned by this claim');
      }
      return tx.put('delivery_reservations', reservationId, {
        ...reservation,
        articleSnapshot: snapshots,
        sourceHealth: sourceHealth ?? null,
        updatedAt: now,
      }, { expectedVersion: reservation.version });
    });
  }

  async linkDeliveryReservation(reservationId, claimToken, deliveryId) {
    const now = this._nowIso();
    return this.store.transact(tx => {
      const reservation = requireRecord(tx, 'delivery_reservations', reservationId);
      if (reservation.deliveryId) {
        if (reservation.deliveryId !== deliveryId) throw new Error('Delivery reservation is already linked');
        return reservation;
      }
      const delivery = requireRecord(tx, 'deliveries', deliveryId);
      const sameSelection = JSON.stringify(delivery.articleSnapshot) === JSON.stringify(reservation.articleSnapshot);
      if (!sameSelection || delivery.requestId !== reservation.deliveryRequestId) {
        throw new Error('Delivery does not match its reservation');
      }
      if (reservation.claimToken !== claimToken || reservation.state !== 'preparing') {
        throw new Error('Delivery reservation is no longer claimable');
      }
      return tx.put('delivery_reservations', reservationId, {
        ...reservation,
        state: 'linked',
        deliveryId,
        deadlineAt: null,
        updatedAt: now,
      }, { expectedVersion: reservation.version });
    });
  }

  async completeDeliveryReservation(reservationId, claimToken, { retryable, reason, sourceHealth }) {
    const now = this._now();
    return this.store.transact(tx => {
      const reservation = requireRecord(tx, 'delivery_reservations', reservationId);
      if (reservation.claimToken !== claimToken || reservation.deliveryId) {
        throw new Error('Delivery reservation is no longer owned by this claim');
      }
      return tx.put('delivery_reservations', reservationId, {
        ...reservation,
        state: retryable ? 'retry_pending' : 'completed',
        reason: String(reason ?? 'no_articles').slice(0, 120),
        sourceHealth: sourceHealth ?? reservation.sourceHealth,
        deadlineAt: null,
        nextAttemptAt: retryable ? new Date(now.getTime() + 60_000).toISOString() : null,
        updatedAt: now.toISOString(),
      }, { expectedVersion: reservation.version });
    });
  }

  async getDeliveryReservation(reservationId) {
    return this.store.get('delivery_reservations', reservationId);
  }

  async ensureDayBatch({ batchId, publishingDay, mode, sourceTopologyFingerprint, sourceHealth, deliveries, exhausted = false }) {
    requiredString(batchId, 'batchId');
    if (!Array.isArray(deliveries)) throw new Error('Batch deliveries must be an array');
    const now = this._nowIso();
    return this.store.transact(tx => {
      const existing = tx.get('day_batches', batchId);
      if (existing) {
        if (existing.sourceTopologyFingerprint !== sourceTopologyFingerprint) {
          throw new Error('Source topology changed for an existing day batch');
        }
        appendBatchDeliveries(tx, existing, deliveries, now);
        return existing;
      }
      const batch = tx.put('day_batches', batchId, {
        batchId,
        channelId: this.channelId,
        publishingDay,
        mode,
        sourceTopologyFingerprint,
        sourceHealth,
        refillCount: 0,
        refillFailureCount: 0,
        activeRefillClaimToken: null,
        refillDeadlineAt: null,
        nextRefillAt: null,
        exhausted: Boolean(exhausted),
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
      appendBatchDeliveries(tx, batch, deliveries, now);
      return batch;
    });
  }

  async adoptOrphanedDripDeliveries({ batchId, publishingDay, sourceTopologyFingerprint }) {
    const now = this._nowIso();
    return this.store.transact(tx => {
      let batch = tx.get('day_batches', batchId);
      if (batch?.channelId !== undefined && batch.channelId !== this.channelId) {
        throw new Error('Day batch belongs to another channel');
      }
      if (batch && batch.sourceTopologyFingerprint !== sourceTopologyFingerprint) {
        throw new Error('Source topology changed before orphan adoption');
      }
      const currentBatchItems = tx.query('batch_items', { batchId }, {
        orderBy: 'createdAt', direction: 'asc', limit: 1_000,
      });
      const linkedDeliveryIds = new Set(currentBatchItems.map(item => item.deliveryId));
      const orphans = tx.query('deliveries', {
        channelId: this.channelId,
        publishingDay,
      }).filter(delivery => (
        delivery.mode === 'drip'
        && delivery.publishingDay === publishingDay
        && delivery.forceKind === null
        && !TERMINAL_DELIVERY_STATES.has(delivery.state)
        && !linkedDeliveryIds.has(delivery.deliveryId)
      ));
      if (!batch && orphans.length === 0) return { batch: null, adoptedCount: 0 };
      if (!batch) {
        batch = tx.put('day_batches', batchId, {
          batchId,
          channelId: this.channelId,
          publishingDay,
          mode: 'drip',
          sourceTopologyFingerprint,
          sourceHealth: {
            total: 0,
            healthy: 0,
            failed: 0,
            unknown: 0,
            degraded: true,
            exhaustionEligible: false,
            recoveredOrphans: true,
          },
          refillCount: 0,
          refillFailureCount: 0,
          activeRefillClaimToken: null,
          refillDeadlineAt: null,
          nextRefillAt: null,
          exhausted: false,
          createdAt: now,
          updatedAt: now,
        }, { expectedVersion: 0 });
      }
      const claimStartedAt = Date.parse(batch.updatedAt ?? '');
      // A live scan claim still owns its in-flight deliveries: link them, but never steal the claim.
      const claimExpired = !batch.refillDeadlineAt || Date.parse(batch.refillDeadlineAt) <= Date.parse(now);
      const recoversClaimedRefill = Boolean(batch.activeRefillClaimToken)
        && claimExpired
        && Number.isFinite(claimStartedAt)
        && orphans.some(delivery => Date.parse(delivery.createdAt ?? '') >= claimStartedAt);
      if (recoversClaimedRefill) {
        batch = tx.put('day_batches', batchId, {
          ...batch,
          sourceHealth: {
            ...(batch.sourceHealth ?? {}),
            degraded: false,
            exhaustionEligible: false,
            recoveredOrphans: true,
          },
          refillCount: Math.max(1, Number(batch.refillCount ?? 0)),
          activeRefillClaimToken: null,
          refillDeadlineAt: null,
          nextRefillAt: null,
          exhausted: false,
          updatedAt: now,
        }, { expectedVersion: batch.version });
      }
      appendBatchDeliveries(tx, batch, orphans, now);
      return { batch, adoptedCount: orphans.length };
    });
  }

  async syncBatchItem(batchId, deliveryId) {
    const now = this._nowIso();
    return this.store.transact(tx => {
      const item = tx.query('batch_items', { batchId, deliveryId }, { limit: 1 })[0];
      if (!item) return null;
      const delivery = requireRecord(tx, 'deliveries', deliveryId);
      return tx.put('batch_items', item.itemId, {
        ...item,
        itemState: itemStateFromDelivery(delivery.state),
        updatedAt: now,
      }, { expectedVersion: item.version });
    });
  }

  async refreshBatchTopology(batchId, sourceTopologyFingerprint) {
    const now = this._nowIso();
    return this.store.transact(tx => {
      const batch = requireRecord(tx, 'day_batches', batchId);
      if (batch.sourceTopologyFingerprint === sourceTopologyFingerprint) return batch;
      return tx.put('day_batches', batchId, {
        ...batch,
        sourceTopologyFingerprint,
        refillCount: 0,
        refillFailureCount: 0,
        activeRefillClaimToken: null,
        refillDeadlineAt: null,
        nextRefillAt: null,
        exhausted: false,
        updatedAt: now,
      }, { expectedVersion: batch.version });
    });
  }

  /**
   * Claim one radar scan of the day batch. The persisted `refill*` field names predate
   * continuous scanning; each "refill" is now one interval-gated scan of the sources.
   */
  async claimBatchRefill({ batchId, sourceTopologyFingerprint, leaseMs = this.attemptTimeoutMs }) {
    const lease = positiveInteger(leaseMs, 'leaseMs');
    const claimToken = crypto.randomUUID();
    const now = this._now();
    return this.store.transact(tx => {
      const batch = requireRecord(tx, 'day_batches', batchId);
      if (batch.channelId !== this.channelId) throw new Error('Day batch belongs to another channel');
      if (batch.sourceTopologyFingerprint !== sourceTopologyFingerprint) {
        throw new Error('Source topology changed before refill claim');
      }
      if (batch.nextRefillAt && new Date(batch.nextRefillAt) > now) {
        const reason = Number(batch.refillFailureCount ?? 0) > 0 ? 'refill_backoff' : 'refill_not_due';
        return { status: 'blocked', reason, batch };
      }
      if (batch.activeRefillClaimToken && batch.refillDeadlineAt && new Date(batch.refillDeadlineAt) > now) {
        return { status: 'in_flight', reason: 'refill_in_flight', batch };
      }
      const claimed = tx.put('day_batches', batchId, {
        ...batch,
        activeRefillClaimToken: claimToken,
        refillDeadlineAt: new Date(now.getTime() + lease).toISOString(),
        updatedAt: now.toISOString(),
      }, { expectedVersion: batch.version });
      return { status: 'claimed', claimToken, batch: claimed };
    });
  }

  /** Extend a scan claim right before creating deliveries; a lost claim must create none. */
  async renewBatchRefillClaim({ batchId, claimToken, leaseMs = this.attemptTimeoutMs }) {
    const lease = positiveInteger(leaseMs, 'leaseMs');
    const now = this._now();
    return this.store.transact(tx => {
      const batch = requireRecord(tx, 'day_batches', batchId);
      if (batch.channelId !== this.channelId) throw new Error('Day batch belongs to another channel');
      if (!claimToken || batch.activeRefillClaimToken !== claimToken) return { status: 'lost', batch };
      const renewed = tx.put('day_batches', batchId, {
        ...batch,
        refillDeadlineAt: new Date(now.getTime() + lease).toISOString(),
        updatedAt: now.toISOString(),
      }, { expectedVersion: batch.version });
      return { status: 'renewed', batch: renewed };
    });
  }

  /**
   * Commit one radar scan. A scan fails when it enqueued nothing and no source was healthy
   * (or the caller reports a failure); failures back off up to an hour and never lock the day.
   */
  async recordBatchRefill({ batchId, claimToken, sourceTopologyFingerprint, sourceHealth, deliveries, scanIntervalMs, failed }) {
    if (!Array.isArray(deliveries)) throw new Error('Refill deliveries must be an array');
    const intervalMs = positiveInteger(scanIntervalMs, 'scanIntervalMs');
    if (failed !== undefined && typeof failed !== 'boolean') throw new Error('Refill failure flag must be a boolean');
    const scanFailed = failed ?? (!(Number(sourceHealth?.healthy) > 0) && deliveries.length === 0);
    const now = this._now();
    return this.store.transact(tx => {
      const batch = requireRecord(tx, 'day_batches', batchId);
      if (batch.channelId !== this.channelId) throw new Error('Day batch belongs to another channel');
      if (batch.sourceTopologyFingerprint !== sourceTopologyFingerprint) {
        throw new Error('Source topology changed before refill commit');
      }
      if (!claimToken || batch.activeRefillClaimToken !== claimToken) {
        throw new Error('Day batch refill claim is no longer owned');
      }
      const existingItems = tx.query('batch_items', { batchId }, {
        orderBy: 'createdAt', direction: 'asc', limit: 1_000,
      });
      const existingDeliveryIds = new Set(existingItems.map(item => item.deliveryId));
      const additions = deliveries.filter(delivery => delivery?.deliveryId && !existingDeliveryIds.has(delivery.deliveryId));
      let nextPosition = existingItems.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1;
      for (const delivery of additions) {
        const itemId = `${batchId}:${String(nextPosition).padStart(6, '0')}`;
        tx.put('batch_items', itemId, {
          itemId,
          channelId: this.channelId,
          batchId,
          position: nextPosition,
          articleHash: delivery.articleHashes?.[0] ?? null,
          deliveryId: delivery.deliveryId,
          itemState: itemStateFromDelivery(delivery.state),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }, { expectedVersion: 0 });
        nextPosition += 1;
      }
      const refillCount = Number(batch.refillCount ?? 0);
      const failures = scanFailed ? Math.min(MAX_SCAN_FAILURE_STREAK, Number(batch.refillFailureCount ?? 0) + 1) : 0;
      const delayMs = scanFailed ? Math.min(MAX_SCAN_BACKOFF_MS, 60_000 * (2 ** (failures - 1))) : intervalMs;
      return tx.put('day_batches', batchId, {
        ...batch,
        sourceHealth: sourceHealth ?? batch.sourceHealth ?? null,
        refillCount: scanFailed ? refillCount : refillCount + 1,
        refillFailureCount: failures,
        activeRefillClaimToken: null,
        refillDeadlineAt: null,
        nextRefillAt: new Date(now.getTime() + delayMs).toISOString(),
        exhausted: false,
        updatedAt: now.toISOString(),
      }, { expectedVersion: batch.version });
    });
  }

  async getDayBatch(batchId) { return this.store.get('day_batches', batchId); }

  /** Read this channel's deliveries of any state or trigger for the given publishing days. */
  async listDeliveriesForPublishingDays(publishingDays) {
    if (!Array.isArray(publishingDays)) throw new Error('Publishing days must be an array');
    const deliveries = [];
    for (const publishingDay of new Set(publishingDays.map(day => requiredString(day, 'publishingDay')))) {
      deliveries.push(...await this.store.query('deliveries', {
        channelId: this.channelId,
        publishingDay,
      }, { orderBy: 'createdAt', direction: 'desc', limit: RECENT_DELIVERY_LOOKUP_LIMIT }));
    }
    return deliveries;
  }
  async listBatchItems(batchId) {
    return (await this.store.query('batch_items', { batchId }, {
      orderBy: 'createdAt', direction: 'asc', limit: 1_000,
    })).sort((a, b) => a.position - b.position);
  }

  async claimMaintenance() {
    const now = this._now();
    const channelSnapshot = await this.store.get('channel_state', this.channelId);
    const candidate = channelSnapshot?.paused
      ? await this.store.findPausedMaintenance(this.channelId, { claimableOnly: true })
      : await this.store.findMaintenance(this.channelId, { claimableOnly: true });
    return this.store.transact(tx => {
      const channel = ensureChannel(tx, this.channelId, now.toISOString());
      const row = candidate && tx.get('maintenance_outbox', candidate.outboxId);
      if (!isMaintenanceClaimable(row, this.channelId, now, channel.paused)) return null;
      return tx.put('maintenance_outbox', row.outboxId, {
        ...row,
        state: 'attempting',
        attemptCount: row.attemptCount + 1,
        deadlineAt: new Date(now.getTime() + this.attemptTimeoutMs).toISOString(),
        updatedAt: now.toISOString(),
      }, { expectedVersion: row.version });
    });
  }

  async commitMaintenance(outboxId, { success, error, maxAttempts = 5 }) {
    const now = this._now();
    return this.store.transact(tx => {
      const row = requireRecord(tx, 'maintenance_outbox', outboxId);
      if (row.channelId !== this.channelId) throw new Error('Maintenance outbox belongs to another channel');
      if (row.state !== 'attempting') throw new Error('Maintenance outbox row is not attempting');
      const exhausted = row.attemptCount >= maxAttempts;
      const updated = tx.put('maintenance_outbox', outboxId, {
        ...row,
        state: success ? 'succeeded' : exhausted ? 'dead_letter' : 'retry_pending',
        deadlineAt: null,
        nextAttemptAt: success || exhausted ? null : new Date(now.getTime() + Math.min(60_000, 1_000 * (2 ** row.attemptCount))).toISOString(),
        sanitizedError: success ? null : sanitizeError(error),
        updatedAt: now.toISOString(),
      }, { expectedVersion: row.version });
      if (row.operatorActionId) {
        const action = requireRecord(tx, 'operator_actions', row.operatorActionId);
        tx.put('operator_actions', action.actionId, {
          ...action,
          result: {
            status: updated.state,
            outboxId: updated.outboxId,
            outboxState: updated.state,
            outboxVersion: updated.version,
            deliveryId: updated.deliveryId ?? null,
          },
          updatedAt: now.toISOString(),
        }, { expectedVersion: action.version });
      }
      return updated;
    });
  }

  async getDelivery(deliveryId) { return this.store.get('deliveries', deliveryId); }
  async getAttempt(attemptId) { return this.store.get('attempts', attemptId); }
  async getOutput(deliveryId, outputKey) { return this.store.get('delivery_outputs', outputRecordId(deliveryId, outputKey)); }
  async getChannelState() { return this.store.get('channel_state', this.channelId); }
  async listArticleRecords() { return this.store.list('articles'); }
  async listDeliveries(predicate) { return this.store.list('deliveries', predicate); }
  async queryDeliveries(filters = {}, options = {}) {
    return this.store.query('deliveries', { ...filters, channelId: this.channelId }, options);
  }
  async listOutputs(deliveryId) { return this.store.query('delivery_outputs', { deliveryId }); }
  async listOutbox(predicate = () => true) {
    return (await this.store.query('maintenance_outbox', { channelId: this.channelId })).filter(predicate);
  }

  async _resolveOperatorAction(actionId) {
    const action = await this.store.get('operator_actions', actionId);
    if (!action) throw new Error('Operator action was not found');
    const initial = action.result;
    const attemptId = initial?.attemptId ?? initial?.attempt?.attemptId;
    if (attemptId) {
      const attempt = await this.store.get('attempts', attemptId);
      const delivery = attempt?.deliveryId ? await this.getDelivery(attempt.deliveryId) : null;
      if (!attempt && initial?.requestId) {
        const request = await this.store.get('requests', initial.requestId);
        if (request) {
          const retainedResult = request.result ?? {};
          const retainedDelivery = retainedResult.deliveryId
            ? await this.getDelivery(retainedResult.deliveryId)
            : null;
          return {
            status: retainedResult.deliveryState ?? request.outcome ?? initial.status,
            delivery: retainedDelivery,
            deliveryId: retainedDelivery?.deliveryId ?? retainedResult.deliveryId ?? initial.deliveryId ?? null,
            deliveryState: retainedDelivery?.state ?? retainedResult.deliveryState ?? initial.deliveryState ?? null,
            deliveryVersion: retainedDelivery?.version ?? retainedResult.deliveryVersion ?? initial.deliveryVersion ?? null,
            outputKey: retainedResult.outputKey ?? initial.outputKey ?? null,
            requestId: request.requestId,
            result: retainedResult,
            operatorActionId: actionId,
            replayed: true,
          };
        }
      }
      return {
        status: attempt?.state === 'attempting' ? 'claimed' : delivery?.state ?? attempt?.state ?? initial.status,
        attempt,
        delivery,
        deliveryId: delivery?.deliveryId ?? attempt?.deliveryId ?? initial?.deliveryId ?? null,
        deliveryState: delivery?.state ?? initial?.deliveryState ?? null,
        deliveryVersion: delivery?.version ?? initial?.deliveryVersion ?? null,
        outputKey: attempt?.outputKey ?? initial?.outputKey ?? null,
        result: attempt?.classifiedResult ?? initial.result,
        requestId: initial?.requestId ?? attempt?.requestId ?? null,
        operatorActionId: actionId,
        replayed: true,
      };
    }
    const outboxId = initial?.outboxId ?? initial?.outbox?.outboxId;
    if (outboxId) {
      const outbox = await this.store.get('maintenance_outbox', outboxId);
      return {
        ...initial,
        status: outbox?.state ?? initial.status,
        outbox,
        operatorActionId: actionId,
        replayed: true,
      };
    }
    const delivery = initial?.deliveryId ? await this.getDelivery(initial.deliveryId) : null;
    const channel = !initial?.deliveryId ? await this.getChannelState() : null;
    return {
      ...initial,
      delivery,
      channel,
      operatorActionId: actionId,
      replayed: true,
    };
  }

  _now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Delivery clock returned an invalid instant');
    return date;
  }
  _nowIso() { return this._now().toISOString(); }
}

export function assertDeliveryTransition(level, from, to) {
  const levels = TRANSITIONS[level];
  if (!levels) throw new Error(`Unknown transition level: ${level}`);
  if (from === to) return;
  if (!levels[from]?.has(to)) throw new Error(`Illegal ${level} transition: ${from} -> ${to}`);
}

function claimOutputInTransaction({ tx, attemptId, requestId, delivery, output, channel, now, attemptTimeoutMs }) {
  assertDeliveryTransition('output', output.state, 'attempting');
  assertDeliveryTransition('delivery', delivery.state, 'delivering');
  const attempt = tx.put('attempts', attemptId, {
    attemptId,
    channelId: channel.channelId,
    deliveryId: delivery.deliveryId,
    outputKey: output.outputKey,
    kind: 'output',
    requestId,
    state: 'attempting',
    claimedVersion: output.version,
    startedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + attemptTimeoutMs).toISOString(),
    completedAt: null,
  }, { expectedVersion: 0 });
  const updatedOutput = tx.put('delivery_outputs', outputRecordId(delivery.deliveryId, output.outputKey), {
    ...output,
    state: 'attempting',
    attemptCount: output.attemptCount + 1,
    activeAttemptId: attemptId,
    updatedAt: now.toISOString(),
  }, { expectedVersion: output.version });
  tx.put('deliveries', delivery.deliveryId, {
    ...delivery, state: 'delivering', updatedAt: now.toISOString(),
  }, { expectedVersion: delivery.version });
  tx.put('channel_state', channel.channelId, {
    ...channel,
    mutationState: 'active',
    activeOutputAttemptId: attemptId,
    updatedAt: now.toISOString(),
  }, { expectedVersion: channel.version });
  return { status: 'claimed', attempt, output: updatedOutput, content: delivery.generatedContent };
}

function startOperatorRetryRequest(tx, {
  requestId,
  channelId,
  action,
  deliveryId,
  outputKey,
  attempt,
  operatorActionId,
  payloadFingerprint,
  now,
}) {
  if (tx.get('requests', requestId)) throw new Error('Operator retry request id already exists');
  tx.put('requests', requestId, {
    requestId,
    channelId,
    triggerType: 'operator_retry',
    action,
    deliveryId,
    outputKey,
    operatorActionId,
    payloadFingerprint,
    state: 'running',
    outcome: null,
    reason: null,
    result: null,
    runAttemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    createdAt: now,
    updatedAt: now,
  }, { expectedVersion: 0 });
}

function completeOperatorRetryRequest(tx, attempt, { state, outcome, reason, delivery, now }) {
  const request = tx.get('requests', attempt.requestId);
  if (!request || request.triggerType !== 'operator_retry') return;
  if (request.runAttemptId !== attempt.attemptId || request.state !== 'running') {
    throw new Error('Operator retry request no longer owns its provider attempt');
  }
  tx.put('requests', request.requestId, {
    ...request,
    state,
    outcome,
    reason,
    result: {
      status: outcome,
      reason,
      deliveryId: delivery.deliveryId,
      deliveryState: delivery.state,
      deliveryVersion: delivery.version,
      outputKey: attempt.outputKey,
    },
    runAttemptId: null,
    deadlineAt: null,
    updatedAt: now,
  }, { expectedVersion: request.version });
  const action = requireRecord(tx, 'operator_actions', request.operatorActionId);
  tx.put('operator_actions', action.actionId, {
    ...action,
    result: {
      status: delivery.state,
      outcome,
      requestId: request.requestId,
      deliveryId: delivery.deliveryId,
      deliveryState: delivery.state,
      deliveryVersion: delivery.version,
      outputKey: attempt.outputKey,
      attemptId: attempt.attemptId,
    },
    updatedAt: now,
  }, { expectedVersion: action.version });
}

function compactHistoryInTransaction(tx, channelId, now) {
  const marker = tx.get('retention_state', channelId);
  const lastRun = Date.parse(marker?.lastRunAt ?? '');
  if (Number.isFinite(lastRun) && lastRun > now.getTime() - DAY_MS) {
    return { status: 'skipped', reason: 'retention_interval', lastRunAt: marker.lastRunAt };
  }
  const counts = { deliveries: 0, outputs: 0, attempts: 0, batchItems: 0, batches: 0, outbox: 0, requests: 0, actions: 0 };
  const deliveries = tx.query('deliveries', {
    channelId,
    state: [...TERMINAL_DELIVERY_STATES],
    retentionStatus: null,
  }, { orderBy: 'updatedAt', direction: 'asc', limit: 1_000 });
  const byDeliveryId = new Map(deliveries.map(value => [value.deliveryId, value]));
  const liveAttemptDeliveryIds = new Set([
    ...tx.query('attempts', { channelId, state: 'attempting' }),
    ...tx.query('attempts', { channelId: null, state: 'attempting' }),
  ].map(value => value.deliveryId));
  const prunedDeliveryIds = new Set();

  for (const delivery of deliveries) {
    if (
      !TERMINAL_DELIVERY_STATES.has(delivery.state)
      || liveAttemptDeliveryIds.has(delivery.deliveryId)
      || !olderThan(delivery, now, 30)
    ) continue;
    if (delivery.forceKind) {
      if (!delivery.compacted) {
        tx.put('deliveries', delivery.deliveryId, compactDeliveryTombstone(delivery), {
          expectedVersion: delivery.version,
        });
      }
    } else {
      tx.delete('deliveries', delivery.deliveryId, { expectedVersion: delivery.version });
    }
    prunedDeliveryIds.add(delivery.deliveryId);
    counts.deliveries += 1;
  }
  for (const deliveryId of prunedDeliveryIds) {
    for (const output of tx.query('delivery_outputs', { deliveryId })) {
      tx.delete('delivery_outputs', `${output.deliveryId}:${output.outputKey}`, { expectedVersion: output.version });
      counts.outputs += 1;
    }
    for (const attempt of tx.query('attempts', { deliveryId })) {
      if (attempt.state === 'attempting') continue;
      tx.delete('attempts', attempt.attemptId, { expectedVersion: attempt.version });
      counts.attempts += 1;
    }
    for (const reservation of tx.query('delivery_reservations', { deliveryId })) {
      tx.delete('delivery_reservations', reservation.reservationId, { expectedVersion: reservation.version });
    }
    for (const item of tx.query('batch_items', { deliveryId })) {
      tx.delete('batch_items', item.itemId, { expectedVersion: item.version });
      counts.batchItems += 1;
    }
  }
  const batchCandidates = tx.query('day_batches', { channelId }, {
    orderBy: 'updatedAt', direction: 'asc', limit: 1_000,
  });
  for (const batch of batchCandidates) {
    if (olderThan(batch, now, 90) && tx.count('batch_items', { batchId: batch.batchId }) === 0) {
      tx.delete('day_batches', batch.batchId, { expectedVersion: batch.version });
      counts.batches += 1;
    }
  }
  for (const row of tx.query('maintenance_outbox', {
    channelId,
    state: 'succeeded',
    retentionStatus: null,
  }, { orderBy: 'updatedAt', direction: 'asc', limit: 1_000 })) {
    if (!olderThan(row, now, 30)) continue;
    tx.delete('maintenance_outbox', row.outboxId, { expectedVersion: row.version });
    counts.outbox += 1;
  }

  const retainedActionIds = new Set();
  for (const request of tx.query('requests', {
    channelId,
    state: ['accepted', 'running', 'blocked'],
  })) retainedActionIds.add(request.operatorActionId);
  for (const request of tx.query('requests', {
    channelId,
    state: ['completed', 'blocked'],
    retentionStatus: null,
  }, { orderBy: 'updatedAt', direction: 'asc', limit: 1_000 })) {
    if (!olderThan(request, now, 90)) continue;
    const deliveryId = request.deliveryId ?? request.result?.deliveryId;
    const referencedDelivery = deliveryId ? tx.get('deliveries', deliveryId) : null;
    if (referencedDelivery && !TERMINAL_DELIVERY_STATES.has(referencedDelivery.state)) {
      retainedActionIds.add(request.operatorActionId);
      continue;
    }
    if (!['force', 'canary', 'operator_retry'].includes(request.triggerType)) {
      tx.delete('requests', request.requestId, { expectedVersion: request.version });
    } else if (!request.compacted) {
      tx.put('requests', request.requestId, {
        requestId: request.requestId,
        channelId: request.channelId,
        triggerType: request.triggerType,
        action: request.action,
        deliveryId,
        outputKey: request.outputKey,
        operatorActionId: request.operatorActionId,
        state: request.state,
        outcome: request.outcome,
        reason: request.reason,
        result: compactRequestResult(request.result, deliveryId),
        payloadFingerprint: request.payloadFingerprint,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        retentionStatus: 'compacted',
        compacted: true,
      }, { expectedVersion: request.version });
    }
    counts.requests += 1;
  }

  const referencedActions = new Set([
    ...tx.query('attempts', { channelId, state: 'attempting' }).map(value => value.operatorActionId),
    ...tx.query('attempts', { channelId: null, state: 'attempting' }).map(value => value.operatorActionId),
    ...tx.query('maintenance_outbox', {
      channelId,
      state: ['pending', 'attempting', 'retry_pending', 'dead_letter'],
    })
      .flatMap(value => [value.pauseOverrideActionId, value.operatorActionId]),
    ...retainedActionIds,
  ].filter(Boolean));
  const actionCandidates = [
    ...tx.query('operator_actions', { state: ['minimized', 'recorded'] }, {
      orderBy: 'createdAt', direction: 'asc', limit: 1_000,
    }),
    ...tx.query('operator_actions', { state: null }, {
      orderBy: 'createdAt', direction: 'asc', limit: 1_000,
    }),
  ];
  for (const action of actionCandidates) {
    const relatedDelivery = !action.channelId && action.deliveryId
      ? byDeliveryId.get(action.deliveryId) ?? tx.get('deliveries', action.deliveryId)
      : null;
    const belongsToChannel = action.channelId === channelId
      || relatedDelivery?.channelId === channelId;
    if (!belongsToChannel) continue;
    const agedOut = olderThan(action, now, 365);
    const needsDataMinimization = Object.hasOwn(action, 'reason')
      || Boolean(action.result?.delivery || action.result?.articles || action.result?.content
        || action.result?.attempt || action.result?.outbox);
    if (!needsDataMinimization && (referencedActions.has(action.actionId) || action.compacted || !agedOut)) continue;
    tx.put('operator_actions', action.actionId, {
      actionId: action.actionId,
      action: action.action,
      channelId,
      deliveryId: action.deliveryId,
      outputKey: action.outputKey,
      outboxId: action.outboxId,
      migrationId: action.migrationId,
      requestId: action.requestId,
      operatorId: action.operatorId,
      reasonHash: action.reasonHash,
      duplicateRiskAckHash: action.duplicateRiskAckHash,
      duplicateRiskAccepted: action.duplicateRiskAccepted,
      payloadFingerprint: action.payloadFingerprint,
      state: agedOut ? 'compacted' : 'minimized',
      createdAt: action.createdAt,
      updatedAt: now.toISOString(),
      result: compactOperatorActionResult(action.result),
      compacted: action.compacted === true || agedOut,
    }, { expectedVersion: action.version });
    counts.actions += 1;
  }

  tx.put('retention_state', channelId, {
    channelId,
    lastRunAt: now.toISOString(),
    counts,
    updatedAt: now.toISOString(),
  }, { expectedVersion: marker?.version ?? 0 });
  return { status: 'compacted', counts };
}

function compactOperatorActionResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    status: result.status,
    outcome: result.outcome ?? null,
    requestId: result.requestId ?? null,
    deliveryId: result.delivery?.deliveryId ?? result.deliveryId ?? null,
    deliveryState: result.delivery?.state ?? result.deliveryState ?? null,
    deliveryVersion: result.delivery?.version ?? result.deliveryVersion ?? null,
    outputKey: result.output?.outputKey ?? result.outputKey ?? null,
    outboxId: result.outbox?.outboxId ?? result.outboxId ?? null,
    outboxState: result.outbox?.state ?? result.outboxState ?? null,
    outboxVersion: result.outbox?.version ?? result.outboxVersion ?? null,
    attemptId: result.attemptId ?? result.attempt?.attemptId ?? null,
    migrationId: result.migrationId ?? null,
    sourceFingerprint: result.sourceFingerprint ?? null,
    destinationFingerprint: result.destinationFingerprint ?? null,
    counts: compactMigrationCounts(result.counts),
    importedAt: result.importedAt ?? null,
    version: result.version ?? null,
  };
}

function compactMigrationCounts(counts) {
  if (!counts || typeof counts !== 'object') return null;
  return {
    keys: finiteCount(counts.keys),
    seen: finiteCount(counts.seen),
    digests: finiteCount(counts.digests),
    queues: finiteCount(counts.queues),
    importedQueueItems: finiteCount(counts.importedQueueItems),
    duplicateQueueItems: finiteCount(counts.duplicateQueueItems),
  };
}

function finiteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function operatorActionAuditResult(result, action) {
  if (!result || typeof result !== 'object') return { status: 'unknown' };
  return {
    status: result.status,
    requestId: action.requestId ?? null,
    deliveryId: result.delivery?.deliveryId ?? action.deliveryId ?? null,
    deliveryState: result.delivery?.state ?? null,
    deliveryVersion: result.delivery?.version ?? result.deliveryVersion ?? null,
    outputKey: result.output?.outputKey ?? action.outputKey ?? null,
    attemptId: result.attempt?.attemptId ?? null,
    outboxId: result.outbox?.outboxId ?? action.outboxId ?? null,
    outboxState: result.outbox?.state ?? null,
    outboxVersion: result.outbox?.version ?? null,
    channelVersion: result.channel?.version ?? null,
    paused: result.channel?.paused ?? null,
  };
}

function compactDeliveryTombstone(delivery) {
  return {
    deliveryId: delivery.deliveryId,
    channelId: delivery.channelId,
    requestId: delivery.requestId,
    mode: delivery.mode,
    publishingDay: delivery.publishingDay,
    forceKind: delivery.forceKind,
    singleMutation: delivery.singleMutation === true,
    topologyFingerprint: delivery.topologyFingerprint,
    state: delivery.state,
    reason: delivery.reason ?? null,
    articleHashes: delivery.articleHashes ?? [],
    contentChecksum: delivery.contentChecksum ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    retentionStatus: 'compacted',
    compacted: true,
  };
}

function compactRequestResult(result, deliveryId) {
  if (!result || typeof result !== 'object') return deliveryId ? { deliveryId } : null;
  return {
    status: result.status ?? null,
    reason: result.reason ?? null,
    deliveryId: result.deliveryId ?? deliveryId ?? null,
    deliveryState: result.deliveryState ?? null,
    deliveryVersion: result.deliveryVersion ?? null,
    outputKey: result.outputKey ?? null,
  };
}

function olderThan(record, now, days) {
  const timestamp = Date.parse(record?.updatedAt ?? record?.createdAt ?? '');
  return Number.isFinite(timestamp) && timestamp < now.getTime() - days * DAY_MS;
}

function aggregateDelivery(tx, deliveryId, now) {
  const delivery = requireRecord(tx, 'deliveries', deliveryId);
  const outputs = deliveryOutputs(tx, deliveryId);
  let nextState;
  if (outputs.every(output => output.state === 'succeeded')) nextState = 'succeeded';
  else if (outputs.some(output => output.state === 'needs_reconciliation')) nextState = 'needs_reconciliation';
  else if (outputs.some(output => output.state === 'manual_retry_required')) nextState = 'output_manual_retry_required';
  else if (outputs.some(output => output.state === 'exhausted')) nextState = 'output_exhausted';
  else if (outputs.some(output => output.state === 'automatic_retry_pending')) nextState = 'partial_retryable';
  else nextState = 'ready';
  assertDeliveryTransition('delivery', delivery.state, nextState);
  const updated = tx.put('deliveries', deliveryId, {
    ...delivery,
    state: nextState,
    outputSummary: {
      total: outputs.length,
      succeeded: outputs.filter(output => output.state === 'succeeded').length,
      unresolved: outputs.filter(output => !TERMINAL_OUTPUT_STATES.has(output.state)).length,
      ambiguous: outputs.filter(output => output.state === 'needs_reconciliation').length,
    },
    updatedAt: now,
  }, { expectedVersion: delivery.version });
  if (nextState === 'succeeded') finalizeArticlesAndOutbox(tx, updated, now);
  return updated;
}

function assertDeliveryChannel(delivery, channelId) {
  if (delivery.channelId !== channelId) throw new Error('Delivery belongs to another channel');
}

function channelLeaseAttempt(tx, channel) {
  if (!channel.activeOutputAttemptId) return null;
  return tx.get('attempts', channel.activeOutputAttemptId);
}

function channelLeaseBelongsToOutput(tx, channel, output) {
  const attempt = channelLeaseAttempt(tx, channel);
  return attempt?.kind === 'output'
    && attempt.deliveryId === output.deliveryId
    && attempt.outputKey === output.outputKey;
}

function channelLeaseBelongsToDelivery(tx, channel, deliveryId) {
  const attempt = channelLeaseAttempt(tx, channel);
  return attempt?.kind === 'output' && attempt.deliveryId === deliveryId;
}

function assertRetryOutputLease(tx, channel, delivery, output) {
  if (output.state === 'needs_reconciliation') {
    if (channel.mutationState !== 'blocked_ambiguous'
      || !channelLeaseBelongsToOutput(tx, channel, output)) {
      throw new Error('Ambiguous output no longer owns the channel mutation lease');
    }
    return;
  }
  if (channel.mutationState !== 'free' || channel.activeOutputAttemptId) {
    throw new Error('Channel mutation lease is busy');
  }
  if (output.deliveryId !== delivery.deliveryId) throw new Error('Recovery output belongs to another delivery');
}

function restoreTopologyBlockedDelivery(tx, delivery, now) {
  const restoreState = delivery.topologyBlockedFromState;
  if (!restoreState) throw new Error('Topology-blocked delivery has no safe restore state');
  assertDeliveryTransition('delivery', delivery.state, restoreState);
  return tx.put('deliveries', delivery.deliveryId, {
    ...delivery,
    state: restoreState,
    reason: null,
    topologyBlockedFromState: null,
    updatedAt: now,
  }, { expectedVersion: delivery.version });
}

function finalizeArticlesAndOutbox(tx, delivery, now) {
  for (let index = 0; index < delivery.articleHashes.length; index++) {
    const hash = delivery.articleHashes[index];
    const snapshot = delivery.articleSnapshot[index];
    const article = requireRecord(tx, 'articles', hash);
    tx.put('articles', hash, {
      ...article,
      activeDeliveryId: null,
      terminalState: 'succeeded',
      safetySuppressed: false,
      updatedAt: now,
    }, { expectedVersion: article.version });
    const outboxId = `legacy_seen:${delivery.deliveryId}:${hash}`;
    if (!tx.get('maintenance_outbox', outboxId)) {
      tx.put('maintenance_outbox', outboxId, {
        outboxId,
        kind: 'legacy_seen',
        channelId: delivery.channelId,
        deliveryId: delivery.deliveryId,
        targetKey: `seen:${legacyHash(snapshot.id)}`,
        targetValue: '1',
        state: 'pending',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
    }
  }
  if (delivery.mode === 'digest') {
    const outboxId = `legacy_digest:${delivery.deliveryId}`;
    if (!tx.get('maintenance_outbox', outboxId)) {
      tx.put('maintenance_outbox', outboxId, {
        outboxId,
        kind: 'legacy_digest',
        channelId: delivery.channelId,
        deliveryId: delivery.deliveryId,
        targetKey: `digest:${delivery.publishingDay}`,
        targetValue: JSON.stringify({ sentAt: now, articleCount: delivery.articleHashes.length }),
        state: 'pending',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      }, { expectedVersion: 0 });
    }
  }
}

function legacyHash(value) {
  let hash = 0;
  const string = String(value);
  for (let index = 0; index < string.length; index++) {
    hash = ((hash << 5) - hash) + string.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}

function abandonDelivery(tx, delivery, channelId, now, reasonHash) {
  assertDeliveryTransition('delivery', delivery.state, 'abandoned');
  const channel = requireRecord(tx, 'channel_state', channelId);
  const ownsChannelLease = channelLeaseBelongsToDelivery(tx, channel, delivery.deliveryId);
  for (const output of deliveryOutputs(tx, delivery.deliveryId)) {
    if (!TERMINAL_OUTPUT_STATES.has(output.state)) {
      assertDeliveryTransition('output', output.state, 'abandoned');
      tx.put('delivery_outputs', outputRecordId(delivery.deliveryId, output.outputKey), {
        ...output, state: 'abandoned', activeAttemptId: null, updatedAt: now,
      }, { expectedVersion: output.version });
    }
  }
  for (const hash of delivery.articleHashes) {
    const article = requireRecord(tx, 'articles', hash);
    tx.put('articles', hash, {
      ...article,
      activeDeliveryId: null,
      terminalState: 'abandoned',
      safetySuppressed: true,
      suppressionReasonHash: reasonHash,
      suppressionReason: undefined,
      updatedAt: now,
    }, { expectedVersion: article.version });
  }
  if (ownsChannelLease) {
    tx.put('channel_state', channelId, {
      ...channel, mutationState: 'free', activeOutputAttemptId: null, updatedAt: now,
    }, { expectedVersion: channel.version });
  }
  return tx.put('deliveries', delivery.deliveryId, {
    ...delivery,
    state: 'abandoned',
    abandonReasonHash: reasonHash,
    abandonReason: undefined,
    updatedAt: now,
  }, { expectedVersion: delivery.version });
}

function ensureChannel(tx, channelId, now) {
  const existing = tx.get('channel_state', channelId);
  if (existing) return existing;
  return tx.put('channel_state', channelId, {
    channelId,
    mutationState: 'free',
    activeOutputAttemptId: null,
    paused: false,
    createdAt: now,
    updatedAt: now,
  }, { expectedVersion: 0 });
}

function deliveryOutputs(tx, deliveryId) {
  return tx.query('delivery_outputs', { deliveryId })
    .sort((a, b) => a.ordinal - b.ordinal);
}

function outputRecordId(deliveryId, outputKey) { return `${deliveryId}:${outputKey}`; }

function requireRecord(tx, table, id) {
  const record = tx.get(table, id);
  if (!record) throw new Error(`${table}/${id} was not found`);
  return record;
}

function requiredString(value, label, maximum = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return result;
}

function itemStateFromDelivery(state) {
  if (state === 'succeeded') return 'delivered';
  if (state === 'abandoned') return 'suppressed';
  if (['pending_generation', 'ready'].includes(state)) return 'queued';
  if (['generating', 'delivering'].includes(state)) return 'running';
  if (['generation_retry_pending', 'partial_retryable'].includes(state)) return 'retryable';
  return 'blocked';
}

function isMaintenanceClaimable(row, channelId, now, pauseOverrideRequired) {
  return Boolean(
    row
    && row.channelId === channelId
    && ['pending', 'retry_pending'].includes(row.state)
    && (!pauseOverrideRequired || (
      typeof row.pauseOverrideActionId === 'string'
      && row.pauseOverrideActionId.length > 0
    ))
    && (!row.nextAttemptAt || new Date(row.nextAttemptAt) <= now),
  );
}

function appendBatchDeliveries(tx, batch, deliveries, now) {
  const existingItems = tx.query('batch_items', { batchId: batch.batchId }, {
    orderBy: 'createdAt', direction: 'asc', limit: 1_000,
  });
  const existingDeliveryIds = new Set(existingItems.map(item => item.deliveryId));
  let position = existingItems.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1;
  for (const delivery of deliveries) {
    if (!delivery?.deliveryId || existingDeliveryIds.has(delivery.deliveryId)) continue;
    const itemId = `${batch.batchId}:${String(position).padStart(6, '0')}`;
    tx.put('batch_items', itemId, {
      itemId,
      channelId: batch.channelId,
      batchId: batch.batchId,
      position,
      articleHash: delivery.articleHashes?.[0] ?? null,
      deliveryId: delivery.deliveryId,
      itemState: itemStateFromDelivery(delivery.state),
      createdAt: now,
      updatedAt: now,
    }, { expectedVersion: 0 });
    existingDeliveryIds.add(delivery.deliveryId);
    position += 1;
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

export const deliveryTransitions = TRANSITIONS;
