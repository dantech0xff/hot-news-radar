/**
 * Channel runs for the app runtime. Every run builds the channel fresh from
 * its stored config (so edits apply immediately), runs it through the shared
 * `runChannels()`/`buildEngine()` path the CLI uses (same durable delivery
 * guarantees), and then records the run, per-source health, and library
 * changes. Preview reuses the CLI's read-only preview.
 */

import { randomUUID } from 'node:crypto';

import { preview as cliPreview } from '../../adapters/node.js';
import { buildEngine, createDefaultMiddlewares, runChannels, sanitizeRuntimeError } from '../../channels/runner.js';
import { AIPlugin } from '../../core/contracts.js';
import { projectSelectionStats } from '../../core/delivery.js';
import { DEFAULT_CHANNEL_FACTORIES, buildChannelFromConfig } from '../channels/build-channel.js';
import { RUN_STATUSES } from '../db/run-repository.js';
import { ContentRecorder } from './content-recorder.js';
import { isCutoverPending } from './cutover-guard.js';
import { NOT_BEFORE_LABEL, createNotBeforeMiddleware } from './not-before.js';

/** Library reject reason for each selection stage, by stage name. */
const REJECT_REASON_BY_STAGE = Object.freeze({
  [NOT_BEFORE_LABEL]: 'before_cutoff',
  'tech-relevance': 'not_tech',
  scoring: 'low_score',
  'semantic-dedup': 'duplicate',
});
const MAX_RECORDED_ITEMS = 50;
// Below the run repository's 64 KB stats limit.
const MAX_STATS_BYTES = 48 * 1024;
const MAX_PREVIEW_CONTENT = 64 * 1024;
const MAX_PREVIEW_ITEMS = 20;
const SILENT_LOGGER = Object.freeze({ log() {}, warn() {}, error() {} });

/**
 * Counts AI generation calls and the token usage providers report, across
 * every engine and recovery path that uses the wrapped plugin. A call that
 * has not returned usable text when `snapshot()` is taken (thrown, timed out,
 * or empty) counts as failed.
 */
export class AIUsageMeter {
  constructor() {
    this.attempted = 0;
    this.succeeded = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.usageReported = false;
  }

  /**
   * @param {import('../../core/contracts.js').AIPlugin} ai
   * @returns {import('../../core/contracts.js').AIPlugin}
   */
  wrap(ai) {
    return new MeteredAI(ai, this);
  }

  /** @returns {{ attempted: number, succeeded: number, failed: number, inputTokens: number|null, outputTokens: number|null }} */
  snapshot() {
    return {
      attempted: this.attempted,
      succeeded: this.succeeded,
      failed: Math.max(0, this.attempted - this.succeeded),
      inputTokens: this.usageReported ? this.inputTokens : null,
      outputTokens: this.usageReported ? this.outputTokens : null,
    };
  }

  _record(result) {
    if (!result || typeof result.text !== 'string' || result.text.trim() === '') return;
    this.succeeded += 1;
    const input = tokenCount(result.usage?.input);
    const output = tokenCount(result.usage?.output);
    if (input === null && output === null) return;
    this.usageReported = true;
    this.inputTokens += input ?? 0;
    this.outputTokens += output ?? 0;
  }
}

class MeteredAI extends AIPlugin {
  constructor(inner, meter) {
    super();
    if (typeof inner?.summarize !== 'function') throw new TypeError('AIUsageMeter can only wrap an AI plugin');
    this._inner = inner;
    this._meter = meter;
  }

  get id() { return this._inner.id; }
  get name() { return this._inner.name; }

  async summarize(articles, options) {
    this._meter.attempted += 1;
    const result = await this._inner.summarize(articles, options);
    this._meter._record(result);
    return result;
  }
}

/**
 * Build runtime channels from stored records, resolving credentials through
 * the vault-backed credential repository at build time.
 * @param {{
 *   credentials: { resolvePlaintext: (id: string, options: { kind: string }) => string },
 *   factories?: Partial<typeof DEFAULT_CHANNEL_FACTORIES>,
 * }} options
 * @returns {(record: object, options?: { meter?: AIUsageMeter }) => Promise<import('../channels/build-channel.js').RuntimeChannel>}
 */
export function createChannelBuilder({ credentials, factories = {} }) {
  if (typeof credentials?.resolvePlaintext !== 'function') {
    throw new TypeError('createChannelBuilder requires a credential repository');
  }
  const base = { ...DEFAULT_CHANNEL_FACTORIES, ...factories };
  return (record, { meter } = {}) => buildChannelFromConfig(record, {
    resolveCredential: (credentialId, { kind }) => credentials.resolvePlaintext(credentialId, { kind }),
    factories: {
      ...base,
      createAI: config => {
        const ai = base.createAI(config);
        return meter ? meter.wrap(ai) : ai;
      },
    },
  });
}

/**
 * The app's selection chain: the `notBefore` cutover filter ahead of the
 * default chain (tech gate → scoring → semantic dedup). With a recorder,
 * every stage is wrapped to record what it drops.
 * @param {{ notBefore?: string|null, maxArticles?: number }} channel
 * @param {{ recorder?: ContentRecorder }} [options]
 * @returns {Array<(articles: object[]) => object[]|Promise<object[]>>}
 */
export function createAppMiddlewares(channel, { recorder } = {}) {
  const stages = [createNotBeforeMiddleware(channel.notBefore ?? null), ...createDefaultMiddlewares(channel)];
  if (!recorder) return stages;
  return recorder.wrapStages(stages.map(middleware => ({ middleware, reason: rejectReasonFor(middleware) })));
}

function rejectReasonFor(middleware) {
  let name = middleware.label;
  if (name === undefined) {
    try {
      name = JSON.parse(middleware.selectionKey)[0];
    } catch {
      name = undefined;
    }
  }
  const reason = REJECT_REASON_BY_STAGE[name];
  if (!reason) throw new Error(`Selection stage "${String(name)}" has no library reject reason`);
  return reason;
}

/**
 * @typedef {object} RunOutcome
 * @property {string|null} runId `null` when the run was skipped before it was recorded.
 * @property {string} channelId
 * @property {string} status Run status, or `skipped`.
 * @property {string|null} reason
 * @property {boolean} recorded Whether an `app_runs` row exists for it.
 * @property {import('../db/run-repository.js').RunRecord|null} run
 */

export class ChannelRunExecutor {
  /**
   * @param {{
   *   channels: import('../channels/channel-repository.js').ChannelRepository,
   *   buildChannel: ReturnType<typeof createChannelBuilder>,
   *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
   *   cache: import('../../core/contracts.js').CachePlugin,
   *   runs: import('../db/run-repository.js').RunRepository,
   *   content: import('../db/content-repository.js').ContentRepository,
   *   contentSync: import('./content-sync.js').ContentSync,
   *   pauseChannel: (channelId: string, context: { operatorId: string, reason: string }) => Promise<unknown>,
   *   events: import('./events.js').RuntimeEvents,
   *   clock?: () => Date,
   *   logger?: Pick<Console, 'log'|'warn'|'error'>,
   *   alerts?: import('./alerts.js').BlockedChannelAlerts|null,
   * }} options
   */
  constructor({
    channels, buildChannel, deliveryStore, cache, runs, content, contentSync, pauseChannel, events,
    clock = () => new Date(), logger = console, alerts = null,
  }) {
    this._channels = channels;
    this._buildChannel = buildChannel;
    this._store = deliveryStore;
    this._cache = cache;
    this._runs = runs;
    this._content = content;
    this._contentSync = contentSync;
    this._pauseChannel = pauseChannel;
    this._events = events;
    this._clock = clock;
    this._logger = logger;
    this._alerts = alerts;
  }

  /**
   * Run one channel now. Scheduled runs of a disabled or paused channel are
   * skipped without a run record; manual runs of a paused channel are recorded
   * as skipped. A channel found without delivery state is paused first, so no
   * path can start delivering for a channel that was never paused. A cutover
   * channel whose `notBefore` is unset (cleared after it was resumed) is
   * skipped without a run record and logged.
   * @param {{
   *   channelId: string,
   *   triggerType: 'scheduled'|'manual',
   *   requestedAt?: Date,
   *   runId?: string,
   *   triggeredBy?: string|null,
   * }} request
   * @returns {Promise<RunOutcome>}
   */
  async execute({ channelId, triggerType, requestedAt = this._clock(), runId = randomUUID(), triggeredBy = null }) {
    const record = this._channels.get(channelId);
    if (!record) return skipped(channelId, 'channel_not_found');
    if (triggerType === 'scheduled' && !record.enabled) return skipped(channelId, 'channel_disabled');
    const state = await this._store.get('channel_state', channelId);
    if (!state) {
      await this._pauseChannel(channelId, {
        operatorId: 'system',
        reason: 'Channel had no delivery state; paused until an operator resumes it',
      });
      this._logger.warn?.(`[Runtime] ${channelId}: no delivery state found; paused before running`);
      return skipped(channelId, 'channel_state_missing');
    }
    if (state.paused === true && triggerType === 'scheduled') return skipped(channelId, 'channel_paused');
    if (isCutoverPending(record)) {
      this._logger.warn?.(`[Runtime] ${channelId}: ${triggerType} run skipped; set notBefore (the cutover instant) before this channel delivers`);
      return skipped(channelId, 'cutover_required');
    }

    const startedAt = this._clock();
    this._runs.start({
      id: runId,
      channelId,
      triggerType,
      startedAt,
      stats: { requestedAt: requestedAt.toISOString(), triggeredBy },
    });
    this._events.emit('run.started', { runId, channelId, triggerType });

    let summary;
    try {
      summary = state.paused === true
        ? { status: 'skipped', reason: 'channel_paused', stats: { reason: 'channel_paused' } }
        : await this._runChannel(record, { runId, triggerType, requestedAt });
    } catch (error) {
      summary = { status: 'error', reason: null, error: sanitizeRuntimeError(error), stats: {} };
    }

    let run = null;
    try {
      run = this._runs.finish(runId, {
        status: summary.status,
        finishedAt: this._clock(),
        stats: boundStats({ reason: summary.reason ?? null, ...summary.stats, requestedAt: requestedAt.toISOString(), triggeredBy }),
        aiInputTokens: summary.aiInputTokens ?? null,
        aiOutputTokens: summary.aiOutputTokens ?? null,
        outputsTotal: summary.outputs?.total ?? null,
        outputsSucceeded: summary.outputs?.succeeded ?? null,
        outputsFailed: summary.outputs?.failed ?? null,
        error: summary.error ?? null,
        sourceHealth: summary.sourceHealth ?? [],
      });
    } catch (error) {
      this._logger.error?.(`[Runtime] ${channelId}: could not record run ${runId}: ${sanitizeRuntimeError(error)}`);
    }
    this._events.emit('run.finished', {
      runId,
      channelId,
      triggerType,
      status: summary.status,
      reason: summary.reason ?? null,
    });
    return { runId, channelId, status: summary.status, reason: summary.reason ?? null, recorded: true, run };
  }

  async _runChannel(record, { runId, triggerType, requestedAt }) {
    const meter = new AIUsageMeter();
    let channel;
    try {
      channel = await this._buildChannel(record, { meter });
    } catch (error) {
      return { status: 'error', reason: 'channel_build_failed', error: sanitizeRuntimeError(error), stats: { mode: record.mode } };
    }

    const recorder = new ContentRecorder({
      channelId: record.id,
      runId,
      sources: channel.sources,
      clock: this._clock,
      logger: this._logger,
    });
    let raw = null;
    const engineFactory = (ch, dependencies) => {
      const engine = buildEngine(ch, { ...dependencies, middlewares: createAppMiddlewares(ch, { recorder }) });
      // Radar scans skip already-delivered stories before the stage chain; record them as duplicates.
      engine.configure({ onCoveredStoriesExcluded: articles => recorder.observeExcluded(articles, 'duplicate') });
      // A channel blocked by an ambiguous send the engine could not confirm needs a person; tell them once.
      if (this._alerts?.enabled) engine.configure({ onChannelBlocked: block => this._alerts.channelBlocked(ch, block) });
      // Keep the engine's full result: runChannels() projects away source health and outputs.
      return {
        run: async options => (raw = await engine.run(options)),
        runDrip: async options => (raw = await engine.runDrip(options)),
      };
    };

    let results;
    try {
      results = await runChannels([channel], {
        cache: this._cache,
        deliveryStore: this._store,
        now: requestedAt,
        clock: this._clock,
        triggerType,
        engineFactory,
        logger: this._logger,
      });
    } finally {
      this._recordObservations(record.id, recorder);
      await this._contentSync.syncQuietly(record.id, { runId });
    }
    return summarizeRun({ result: results[0] ?? null, raw, meter, mode: channel.mode });
  }

  _recordObservations(channelId, recorder) {
    try {
      this._content.recordScanObservations(recorder.observations());
    } catch (error) {
      this._logger.warn?.(`[Library] ${channelId}: could not record scanned articles: ${sanitizeRuntimeError(error)}`);
    }
  }
}

/**
 * Read-only preview of a stored channel through the CLI preview path. Never
 * sends and never writes delivery state, runs, or library rows.
 * @param {object} record Channel record.
 * @param {{
 *   buildChannel: ReturnType<typeof createChannelBuilder>,
 *   cache: import('../../core/contracts.js').CachePlugin,
 *   deliveryStore: import('../../core/delivery-store.js').DeliveryStore,
 *   clock?: () => Date,
 * }} dependencies
 * @returns {Promise<object>} Bounded projection of the dry-run result.
 */
export async function previewStoredChannel(record, { buildChannel, cache, deliveryStore, clock = () => new Date() }) {
  const meter = new AIUsageMeter();
  const channel = await buildChannel(record, { meter });
  const result = await cliPreview(channel, {
    cache,
    deliveryStore,
    clock,
    logger: SILENT_LOGGER,
    buildEngine: (ch, dependencies) => buildEngine(ch, { ...dependencies, middlewares: createAppMiddlewares(ch) }),
  });
  return projectPreview(result, { channelId: record.id, mode: channel.mode, meter });
}

function summarizeRun({ result, raw, meter, mode }) {
  const usage = meter.snapshot();
  const generation = { attempted: usage.attempted, succeeded: usage.succeeded, failed: usage.failed };
  if (!result) {
    // The schedule no longer matched when the run started.
    return { status: 'skipped', reason: 'not_due', stats: { mode, generation } };
  }
  const outputResults = collectOutputResults(raw);
  const outputs = {
    total: outputResults.length,
    succeeded: outputResults.filter(entry => entry.success).length,
    failed: outputResults.filter(entry => !entry.success).length,
  };
  const reason = result.reason ? bounded(sanitizeRuntimeError(result.reason), 200) : null;
  const errorSource = result.error ?? raw?.error ?? raw?.scanError ?? null;
  const fetched = Boolean(raw?.stats?.selection);
  return {
    status: RUN_STATUSES.includes(result.status) && result.status !== 'running' ? result.status : 'failed',
    reason,
    error: errorSource ? bounded(sanitizeRuntimeError(errorSource), 500) : null,
    aiInputTokens: usage.inputTokens,
    aiOutputTokens: usage.outputTokens,
    outputs,
    sourceHealth: fetched ? projectSourceHealth(raw.sourceHealth) : [],
    stats: {
      mode: typeof raw?.mode === 'string' ? raw.mode : mode,
      reason,
      publishingDay: typeof raw?.publishingDay === 'string' ? raw.publishingDay : null,
      deliveryId: typeof raw?.deliveryId === 'string' ? raw.deliveryId : null,
      deliveryState: typeof raw?.deliveryState === 'string' ? raw.deliveryState : null,
      articles: countOrNull(raw?.stats?.articles),
      remaining: countOrNull(raw?.stats?.remaining),
      blocked: countOrNull(raw?.stats?.blocked),
      engineDurationMs: countOrNull(raw?.stats?.durationMs),
      selection: projectSelectionStats(raw?.stats?.selection),
      sourceHealth: fetched ? summarizeSourceHealth(raw.sourceHealth) : null,
      generation,
      outputs,
      outputResults: outputResults.slice(0, MAX_RECORDED_ITEMS),
      items: projectItems(raw?.articles),
      scanError: raw?.scanError ? bounded(sanitizeRuntimeError(raw.scanError), 300) : null,
    },
  };
}

function collectOutputResults(raw) {
  const entries = [];
  const add = (deliveryId, output) => {
    if (!output || typeof output !== 'object') return;
    const messageIds = Array.isArray(output.meta?.successfulMessageIds)
      ? output.meta.successfulMessageIds
      : output.messageId ? [output.messageId] : [];
    entries.push({
      deliveryId: typeof deliveryId === 'string' ? deliveryId : null,
      outputId: bounded(output.id, 100) || null,
      success: output.success === true,
      deliveryState: bounded(output.meta?.deliveryState, 40) || null,
      messageIds: messageIds.slice(0, 10).map(value => bounded(value, 200)),
      error: output.success === true || !output.error ? null : bounded(sanitizeRuntimeError(output.error), 300),
    });
  };
  if (Array.isArray(raw?.outputs)) for (const output of raw.outputs) add(raw.deliveryId, output);
  if (Array.isArray(raw?.articles)) {
    for (const item of raw.articles) {
      if (Array.isArray(item?.outputs)) for (const output of item.outputs) add(item.deliveryId, output);
    }
  }
  return entries;
}

function projectItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_RECORDED_ITEMS).map(item => ({
    deliveryId: typeof item?.deliveryId === 'string' ? item.deliveryId : null,
    title: bounded(item?.article, 200) || null,
    status: bounded(item?.status, 40) || null,
    reason: item?.reason ? bounded(sanitizeRuntimeError(item.reason), 200) : null,
    deliveryState: bounded(item?.deliveryState, 40) || null,
  }));
}

function projectSourceHealth(sourceHealth) {
  if (!Array.isArray(sourceHealth?.diagnostics)) return [];
  return sourceHealth.diagnostics.slice(0, 500).flatMap(diagnostic => {
    const sourceId = bounded(diagnostic?.sourceId, 100);
    if (!sourceId) return [];
    const status = diagnostic.status === 'success' ? 'healthy' : diagnostic.status === 'failed' ? 'failed' : 'empty';
    let errorClass = null;
    if (status === 'failed') errorClass = bounded(diagnostic.failureType, 80) || 'unknown';
    else if (diagnostic.status === 'unknown') errorClass = 'unverified';
    return [{
      sourceId,
      sourceName: bounded(diagnostic.sourceName, 200) || null,
      status,
      articleCount: countOrNull(diagnostic.articleCount) ?? 0,
      errorClass,
    }];
  });
}

function summarizeSourceHealth(sourceHealth) {
  if (!sourceHealth || typeof sourceHealth !== 'object') return null;
  return {
    total: countOrNull(sourceHealth.total),
    healthy: countOrNull(sourceHealth.healthy),
    failed: countOrNull(sourceHealth.failed),
    unknown: countOrNull(sourceHealth.unknown),
    degraded: sourceHealth.degraded === true,
  };
}

function projectPreview(result, { channelId, mode, meter }) {
  const usage = meter.snapshot();
  const fetched = Boolean(result?.stats?.selection);
  return {
    channelId,
    status: bounded(result?.status, 40) || 'failed',
    reason: result?.reason ? bounded(sanitizeRuntimeError(result.reason), 200) : null,
    mode: typeof result?.mode === 'string' ? result.mode : mode,
    publishingDay: typeof result?.publishingDay === 'string' ? result.publishingDay : null,
    content: typeof result?.content === 'string' ? result.content.slice(0, MAX_PREVIEW_CONTENT) : null,
    items: Array.isArray(result?.articles)
      ? result.articles.slice(0, MAX_PREVIEW_ITEMS).map(item => ({
        title: bounded(item?.article, 500) || null,
        hook: typeof item?.hook === 'string' ? item.hook.slice(0, MAX_PREVIEW_CONTENT) : null,
      }))
      : [],
    stats: {
      articles: countOrNull(result?.stats?.articles),
      sources: countOrNull(result?.stats?.sources),
      durationMs: countOrNull(result?.stats?.durationMs),
      selection: projectSelectionStats(result?.stats?.selection),
    },
    sourceHealth: fetched ? summarizeSourceHealth(result.sourceHealth) : null,
    sources: fetched ? projectSourceHealth(result.sourceHealth) : [],
    aiUsage: usage,
  };
}

// Per-item detail is dropped (counts stay) rather than letting an oversized
// stats document fail the run record.
function boundStats(stats) {
  if (Buffer.byteLength(JSON.stringify(stats), 'utf8') <= MAX_STATS_BYTES) return stats;
  return { ...stats, outputResults: [], items: [], detailTruncated: true };
}

function skipped(channelId, reason) {
  return { runId: null, channelId, status: 'skipped', reason, recorded: false, run: null };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bounded(value, maximum) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maximum);
}
