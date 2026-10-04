/**
 * Channel runner — iterates channels, runs due ones sequentially
 * Each channel creates its own ContentRadar instance with namespaced cache
 */

import {
  ContentRadar,
  PrefixedCache,
  createScoringMiddleware,
  createSemanticDedupMiddleware,
  createTechRelevanceMiddleware,
  opaqueId,
  sanitizeError,
} from '../core/index.js';

const TRIGGER_TYPES = new Set(['scheduled', 'manual', 'force']);
// A radar scan reads posts from the last two days: a quiet weekend publishes fewer posts per
// day than one-post-per-run drains, and the delivery ledger already stops any repost.
const RADAR_SOURCE_WINDOW_HOURS = 48;
const CRON_LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const DAY_OF_WEEK_FIELD = 4;
const DELIVERY_RECOVERY_ACTIONS = Object.freeze({
  pending_generation: ['abandon'],
  generation_retry_pending: ['retry-generation', 'abandon'],
  manual_generation_retry_pending: ['abandon'],
  generation_exhausted: ['retry-generation', 'abandon'],
  ready: ['abandon'],
  partial_retryable: ['abandon'],
  output_manual_retry_required: ['abandon'],
  output_exhausted: ['abandon'],
  needs_reconciliation: ['abandon'],
  blocked_topology: ['restore-topology', 'abandon'],
});
const OUTPUT_RECOVERY_ACTIONS = Object.freeze({
  needs_reconciliation: ['confirm-delivered', 'retry-output'],
  manual_retry_required: ['retry-output'],
  exhausted: ['retry-output'],
});
let legacyTriggerWarningEmitted = false;

/** Derive the only force identifiers allowed across the engine boundary. */
export async function deriveLocalForceIdentifiers(channelId, rawIdempotencyKey) {
  const targetChannelId = requiredBoundedString(channelId, 'Force channel id', 128);
  const key = requiredVisibleAscii(rawIdempotencyKey, 'Force idempotency key', 200);
  return {
    idempotencyKey: await opaqueId('local-force-idempotency', targetChannelId, key),
    requestId: await opaqueId('local-force-request', targetChannelId, key),
  };
}

/** Redact local runtime errors while retaining ordinary operational messages. */
export function sanitizeRuntimeError(value) {
  return sanitizeError(value)
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[redacted]')
    .replace(/\b((?:provider|upstream|remote|http|api)\s+(?:response\s+)?body|response\s+(?:body|payload)|body)\s*[:=]\s*[\s\S]*/gi, '$1=[redacted]');
}

/** Project exact recovery targets without exposing content or provider destinations. */
export async function listUnresolvedTargets(deliveryStore, channelId, options = {}) {
  const targetChannelId = requiredBoundedString(channelId, 'Recovery channel id', 128);
  const limit = boundedInteger(options.limit, 50, 1, 100);
  const offset = boundedInteger(options.offset, 0, 0, 100_000);
  const [channel, deliveries, outputs, outbox] = await Promise.all([
    deliveryStore.get('channel_state', targetChannelId),
    deliveryStore.list('deliveries', value => value.channelId === targetChannelId),
    deliveryStore.list('delivery_outputs'),
    deliveryStore.list('maintenance_outbox', value => value.channelId === targetChannelId),
  ]);
  const deliveryIds = new Set(deliveries.map(delivery => delivery.deliveryId));
  const targets = [];
  for (const delivery of deliveries) {
    const allowedActions = DELIVERY_RECOVERY_ACTIONS[delivery.state];
    if (!allowedActions || !Number.isSafeInteger(delivery.version)) continue;
    targets.push({
      kind: 'delivery',
      deliveryId: boundedIdentifier(delivery.deliveryId, 500),
      state: boundedIdentifier(delivery.state, 80),
      expectedVersion: delivery.version,
      allowedActions: [...allowedActions],
    });
  }
  for (const output of outputs) {
    if (!deliveryIds.has(output.deliveryId)) continue;
    const allowedActions = OUTPUT_RECOVERY_ACTIONS[output.state];
    if (!allowedActions || !Number.isSafeInteger(output.version)) continue;
    targets.push({
      kind: 'output',
      deliveryId: boundedIdentifier(output.deliveryId, 500),
      outputKey: boundedIdentifier(output.outputKey, 500),
      state: boundedIdentifier(output.state, 80),
      expectedVersion: output.version,
      allowedActions: [...allowedActions],
    });
  }
  for (const item of outbox) {
    if (item.state !== 'dead_letter' || !Number.isSafeInteger(item.version)) continue;
    targets.push({
      kind: 'outbox',
      outboxId: boundedIdentifier(item.outboxId, 500),
      state: 'dead_letter',
      expectedVersion: item.version,
      allowedActions: ['retry-maintenance'],
    });
  }
  targets.sort((left, right) => recoveryTargetSortKey(left).localeCompare(recoveryTargetSortKey(right)));
  return {
    channel: channel && Number.isSafeInteger(channel.version) ? {
      channelId: targetChannelId,
      state: channel.paused === true ? 'paused' : 'active',
      expectedVersion: channel.version,
      allowedActions: [channel.paused === true ? 'resume' : 'pause'],
    } : null,
    targets: targets.slice(offset, offset + limit),
    page: { limit, offset, total: targets.length },
  };
}

function recoveryTargetSortKey(target) {
  return `${target.kind}:${target.deliveryId ?? ''}:${target.outputKey ?? ''}:${target.outboxId ?? ''}`;
}

function boundedIdentifier(value, maximum) {
  return sanitizeRuntimeError(value).slice(0, maximum);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Recovery pagination must use safe integers');
  return Math.min(maximum, Math.max(minimum, number));
}

/**
 * Check if a cron expression should fire at the given time (UTC)
 * Supports: star, star-slash-N, single integer, comma-separated, ranges
 * @param {string} cronExpr - 5-field cron: "min hour dom month dow"
 * @param {Date} now
 * @returns {boolean}
 */
export function shouldRun(cronExpr, now, timezone = 'UTC') {
  if (!validateCronExpression(cronExpr)) return false;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const fields = cronExpr.trim().split(/\s+/);
  const vals = datePartsInTimezone(now, timezone);

  return fields.every((field, i) => matchField(field, vals[i], CRON_LIMITS[i], i === DAY_OF_WEEK_FIELD));
}

/** Match a single cron field against a value */
function matchField(field, value, limits, dayOfWeek) {
  return field.split(',').some(part => matchCronPart(part, value, limits, dayOfWeek));
}

/** Validate the supported five-field cron syntax without importing Node-only cron code. */
export function validateCronExpression(cronExpr) {
  if (typeof cronExpr !== 'string') return false;
  const fields = cronExpr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field, index) => (
    field.length > 0 && field.split(',').every(part => validateCronPart(part, CRON_LIMITS[index]))
  ));
}

function validateCronPart(part, [minimum, maximum]) {
  const [range, step, extra] = part.split('/');
  if (extra !== undefined || (step !== undefined && !isIntegerInRange(step, 1, maximum - minimum + 1))) return false;
  if (range === '*') return true;
  if (range.includes('-')) {
    const bounds = range.split('-');
    return bounds.length === 2
      && isIntegerInRange(bounds[0], minimum, maximum)
      && isIntegerInRange(bounds[1], minimum, maximum)
      && Number(bounds[0]) <= Number(bounds[1]);
  }
  return step === undefined && isIntegerInRange(range, minimum, maximum);
}

function matchCronPart(part, value, [minimum], dayOfWeek) {
  const [range, rawStep] = part.split('/');
  const step = rawStep === undefined ? 1 : Number(rawStep);
  // `7` is a second name for Sunday (0) in the day-of-week field only; a bare
  // 7 in any other field must not match 0 (minute 0, midnight).
  const normalizedValue = dayOfWeek && value === 0 && range === '7' ? 7 : value;
  if (range === '*') return (normalizedValue - minimum) % step === 0;
  if (range.includes('-')) {
    const [low, high] = range.split('-').map(Number);
    return normalizedValue >= low && normalizedValue <= high && (normalizedValue - low) % step === 0;
  }
  return normalizedValue === Number(range);
}

function isIntegerInRange(value, minimum, maximum) {
  return /^\d+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function datePartsInTimezone(now, timezone) {
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return [NaN, NaN, NaN, NaN, NaN];
  }
  const parts = Object.fromEntries(formatted.map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), weekdays[parts.weekday]];
}

/**
 * The default article selection chain every channel engine uses: the tech
 * relevance gate, then scoring (top `maxArticles`), then semantic dedup.
 * Exported so callers that supply their own chain to `buildEngine()` can
 * extend it instead of re-creating it.
 * @param {{ maxArticles?: number }} ch - ChannelConfig
 * @returns {Array<(articles: object[]) => object[]|Promise<object[]>>}
 */
export function createDefaultMiddlewares(ch) {
  return [
    createTechRelevanceMiddleware(),
    createScoringMiddleware({ maxArticles: ch.maxArticles || 12 }),
    createSemanticDedupMiddleware(),
  ];
}

/**
 * Build a ContentRadar instance for a single channel
 * Shared by runner, and adapters for /preview, /queue endpoints
 * @param {Object} ch - ChannelConfig
 * @param {import('../core/contracts.js').CachePlugin|{
 *   cache: import('../core/contracts.js').CachePlugin,
 *   deliveryStore?: object,
 *   clock?: () => Date,
 *   middlewares?: Array<(articles: object[]) => object[]|Promise<object[]>>,
 * }} cacheOrDependencies - raw cache (will be prefixed), or the dependencies
 *   object. `middlewares` replaces the default selection chain from
 *   `createDefaultMiddlewares(ch)`; leave it out to keep the default.
 * @returns {ContentRadar}
 */
export function buildEngine(ch, cacheOrDependencies, additionalDependencies = {}) {
  const dependencies = cacheOrDependencies?.cache
    ? cacheOrDependencies
    : { ...additionalDependencies, cache: cacheOrDependencies };
  const { cache, deliveryStore, clock, middlewares } = dependencies;
  const chain = middlewares === undefined ? createDefaultMiddlewares(ch) : middlewares;
  if (!Array.isArray(chain) || chain.some(middleware => typeof middleware !== 'function')) {
    throw new TypeError('buildEngine middlewares must be an array of functions');
  }
  const prefixed = new PrefixedCache(cache, `news:${ch.id}`);
  const engine = new ContentRadar();
  for (const src of ch.sources) engine.addSource(src);
  if (ch.ai) engine.useAI(ch.ai);
  engine.addOutput(ch.output);
  engine.useCache(prefixed);
  if (deliveryStore) engine.useDeliveryStore(deliveryStore);
  for (const middleware of chain) engine.use(middleware);
  engine.configure({
    maxArticlesPerSource: ch.maxArticlesPerSource || 3,
    concurrency: ch.concurrency || 5,
    ...(ch.mode === 'drip' && { sourceWindowHours: RADAR_SOURCE_WINDOW_HOURS }),
    ...ch.prompt,
    channelId: ch.id,
    timezone: ch.timezone || 'UTC',
    ...(clock && { clock }),
  });
  return engine;
}

/**
 * Run all channels whose schedule matches `now`
 * @param {Array} channels - ChannelConfig[]
 * @param {Object} opts
 * @param {import('../core/contracts.js').CachePlugin} opts.cache
 * @param {Date} [opts.now]
 * @param {'scheduled'|'manual'|'force'} [opts.triggerType]
 * @param {boolean} [opts.force] - Legacy compatibility only
 * @returns {Promise<Array<{ channelId: string, status: string, error?: string }>>}
 */
export async function runChannels(channels, options = {}) {
  const {
    cache,
    deliveryStore,
    now = new Date(),
    force = false,
    idempotencyKey,
    requestId,
    engineFactory = buildEngine,
    logger = console,
    clock,
  } = options;
  const triggerType = resolveTriggerType(options, logger);
  if (options.triggerType !== undefined && force) {
    throw new Error('force option cannot be combined with explicit triggerType; use triggerType "force"');
  }
  const forced = triggerType === 'force';
  let suppliedForceIdentifiers = null;
  if (forced) {
    if (!idempotencyKey) throw new Error('Force requires an idempotency key');
    suppliedForceIdentifiers = requestId === undefined
      ? null
      : validateOpaqueForceIdentifiers({ idempotencyKey, requestId });
  }
  const results = [];

  for (const ch of channels) {
    if (triggerType === 'scheduled' && !shouldRun(ch.schedule, now, ch.timezone || 'UTC')) continue;

    logger.log(`[Runner] ▶ ${ch.id} (${ch.mode})`);
    const start = Date.now();

    try {
      const engine = engineFactory(ch, { cache, deliveryStore, clock });
      const forceIdentifiers = forced
        ? suppliedForceIdentifiers ?? await deriveLocalForceIdentifiers(ch.id, idempotencyKey)
        : null;
      const runOptions = {
        force: forced,
        ...(forceIdentifiers ?? {}),
        requestedAt: now,
      };
      const result = ch.mode === 'drip'
        ? await engine.runDrip({
          batchSize: ch.batchSize || 5,
          delayMs: ch.delayMs ?? 0,
          ...(ch.dailyLimit !== undefined && { dailyLimit: ch.dailyLimit }),
          ...runOptions,
        })
        : await engine.run(runOptions);

      const ms = Date.now() - start;
      logger.log(`[Runner] ✓ ${ch.id} — ${result.status} (${ms}ms)`);
      results.push({
        channelId: ch.id,
        status: result.status,
        ...(result.reason && { reason: sanitizeRuntimeError(result.reason) }),
        ...(result.deliveryId && { deliveryId: result.deliveryId }),
        ...(result.stats && { stats: result.stats }),
      });
    } catch (err) {
      const error = sanitizeRuntimeError(err);
      logger.log(`[Runner] ✗ ${ch.id} — ${error}`);
      results.push({ channelId: ch.id, status: 'error', error });
    }
  }

  return results;
}

function validateOpaqueForceIdentifiers({ idempotencyKey, requestId }) {
  const opaquePattern = /^[a-f0-9]{64}$/;
  if (!opaquePattern.test(String(idempotencyKey)) || !opaquePattern.test(String(requestId))) {
    throw new Error('Force engine identifiers must be opaque SHA-256 values');
  }
  return { idempotencyKey: String(idempotencyKey), requestId: String(requestId) };
}

function requiredBoundedString(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function requiredVisibleAscii(value, label, maximum) {
  const text = String(value ?? '');
  if (!text || text.length > maximum || !/^[\x21-\x7e]+$/.test(text)) {
    throw new Error(`${label} must contain 1-${maximum} visible ASCII characters`);
  }
  return text;
}

function resolveTriggerType(options, logger) {
  if (options.triggerType !== undefined) {
    if (!TRIGGER_TYPES.has(options.triggerType)) {
      throw new Error(`Invalid triggerType: ${options.triggerType}`);
    }
    return options.triggerType;
  }
  if (!legacyTriggerWarningEmitted) {
    logger.warn?.('[Runner] Deprecated: pass triggerType explicitly; legacy force maps to force/manual scheduling semantics');
    legacyTriggerWarningEmitted = true;
  }
  return options.force === true ? 'force' : 'scheduled';
}
