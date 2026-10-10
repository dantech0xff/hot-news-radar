#!/usr/bin/env node
/** Node.js CLI and exact per-channel cron daemon. Importing this module has no side effects. */

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  DEFAULT_OUTPUT_TIMEOUT_MS,
  DeliveryStateMachine,
  FileCache,
  LocalFileDeliveryStore,
  MemoryCache,
  PrefixedCache,
  RedisCache,
  assertDeliveryStore,
  buildOutputTopology,
  normalizeSendResult,
  opaqueId,
  projectSelectionStats,
} from '../core/index.js';
import {
  buildEngine as defaultBuildEngine,
  deriveLocalForceIdentifiers,
  listUnresolvedTargets,
  runChannels as defaultRunChannels,
  sanitizeRuntimeError,
} from '../channels/runner.js';
import { defineChannels as defaultDefineChannels, validateChannels as defaultValidateChannels } from '../channels/definitions.js';

const FAILURE_STATUSES = new Set(['partial', 'ambiguous', 'failed', 'error']);
const CONTROL_COMMANDS = new Set([
  'pause',
  'resume',
  'retry-generation',
  'retry-output',
  'restore-topology',
  'confirm-delivered',
  'abandon',
  'retry-maintenance',
]);
const OUTPUT_COMMANDS = new Set([
  'run', 'drip', 'cron', 'daemon',
  'retry-generation', 'retry-output', 'retry-maintenance',
]);
const CONTROL_FAILURE_STATES = new Set([
  'ambiguous', 'failed', 'generation_exhausted', 'needs_reconciliation',
  'output_exhausted', 'output_manual_retry_required', 'dead_letter', 'blocked_topology',
]);
const LOCAL_FORCE_ACTIONS_TABLE = 'local_force_actions';

export function createCache(runtimeEnv = process.env) {
  switch (envValue(runtimeEnv, 'CACHE_TYPE', 'file').toLowerCase()) {
    case 'redis': return new RedisCache(envValue(runtimeEnv, 'REDIS_URL', 'redis://localhost:6379'));
    case 'memory': return new MemoryCache();
    case 'file': return new FileCache(envValue(runtimeEnv, 'CACHE_PATH', '.cache/news.json'));
    default: throw new Error(`Unsupported CACHE_TYPE: ${runtimeEnv.CACHE_TYPE}`);
  }
}

export function createDeliveryStore(runtimeEnv = process.env) {
  const type = envValue(runtimeEnv, 'DELIVERY_STORE_TYPE', 'file').toLowerCase();
  if (type !== 'file') {
    throw new Error(`Unsupported DELIVERY_STORE_TYPE: ${type}; local runtimes require the owned file delivery store`);
  }
  return new LocalFileDeliveryStore(envValue(runtimeEnv, 'DELIVERY_STORE_PATH', '.cache/delivery-state.json'));
}

/**
 * Injectable CLI entry point.
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), runtimeEnv = process.env, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const processLike = dependencies.process ?? process;
  const clock = dependencies.clock ?? (() => new Date());
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';

  if (command === 'help' || argv.includes('--help')) {
    logger.log(helpText());
    return 0;
  }
  if (!['run', 'drip', 'cron', 'daemon', 'preview', 'status', ...CONTROL_COMMANDS].includes(command)) {
    logger.error(`Unknown command: ${sanitizeRuntimeError(command)}`);
    logger.log(helpText());
    return 1;
  }

  try {
    await (dependencies.loadEnvironment ?? loadEnvironment)();
  } catch (error) {
    logger.error(`Unable to load environment: ${sanitizeRuntimeError(error)}`);
    return 1;
  }

  const parsed = parseArguments(argv.slice(command === argv[0] ? 1 : 0));
  if (parsed.error) {
    logger.error(sanitizeRuntimeError(parsed.error));
    return 1;
  }
  if (parsed.force) {
    if (!parsed.channelId) return fail(logger, '--force requires --channel <id>');
    if (!parsed.idempotencyKey) return fail(logger, '--force requires --idempotency-key <key>');
    parsed.operatorId = parsed.operatorId?.trim() || envValue(runtimeEnv, 'OPERATOR_KEY_ID', '').trim();
    if (!parsed.operatorId) return fail(logger, '--force requires --operator-id <key-id> or OPERATOR_KEY_ID');
    if (!parsed.reason?.trim()) return fail(logger, '--force requires --reason <reason>');
    if (!parsed.confirmDuplicateRisk) return fail(logger, '--force requires --confirm-duplicate-risk');
  }
  if (command === 'status' && !parsed.channelId) return fail(logger, 'status requires --channel <id>');
  const controlError = validateControlArguments(command, parsed);
  if (controlError) return fail(logger, controlError);

  const outputCapable = OUTPUT_COMMANDS.has(command);
  const cacheType = envValue(runtimeEnv, 'CACHE_TYPE', 'file').toLowerCase();
  const deliveryStoreType = envValue(runtimeEnv, 'DELIVERY_STORE_TYPE', 'file').toLowerCase();
  if (outputCapable && cacheType === 'memory') {
    return fail(logger, 'CACHE_TYPE=memory is not allowed for output-capable commands');
  }
  if (deliveryStoreType !== 'file') {
    return fail(logger, `DELIVERY_STORE_TYPE=${deliveryStoreType} is unsupported; use file`);
  }

  const defineChannels = dependencies.defineChannels ?? defaultDefineChannels;
  const validateChannels = dependencies.validateChannels ?? defaultValidateChannels;
  let allChannels;
  if (command === 'status') {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(parsed.channelId)) {
      return fail(logger, 'status requires a stable channel id');
    }
    allChannels = [{ id: parsed.channelId, mode: 'status' }];
  } else {
    try {
      allChannels = defineChannels(runtimeEnv);
      validateChannels(allChannels);
    } catch (error) {
      return fail(logger, `Invalid channel configuration: ${sanitizeRuntimeError(error)}`);
    }
    if (allChannels.length === 0) {
      return fail(logger, 'No channels configured. Check output and AI credentials.');
    }
  }

  const channels = resolveChannels(allChannels, parsed.channelId);
  if (!channels) {
    return fail(logger, `Channel "${parsed.channelId}" not found. Available: ${allChannels.map(ch => ch.id).join(', ')}`);
  }

  const makeCache = dependencies.createCache ?? createCache;
  const makeStore = dependencies.createDeliveryStore ?? createDeliveryStore;
  let cache;
  let deliveryStore;
  let resourcesTransferred = false;
  try {
    cache = command === 'status' ? null : makeCache(runtimeEnv);
    deliveryStore = makeStore(runtimeEnv);
    if (outputCapable && typeof cache.peek === 'function') await cache.peek('__news_runtime_preflight__');
    if (outputCapable && cache.capabilities?.persistent !== true) {
      throw new Error('Output-capable commands require a persistent cache');
    }
    assertDeliveryStore(deliveryStore);
    await deliveryStore.initialize({ readOnly: command === 'preview' || command === 'status' });

    logger.log(`📡 ${channels.length} channel(s): ${channels.map(ch => ch.id).join(', ')}`);
    if (channels[0]?.ai) logger.log(`🤖 AI: ${channels[0].ai.name}`);

    if (command === 'preview') {
      const result = await preview(channels[0], {
        cache,
        deliveryStore,
        buildEngine: dependencies.buildEngine ?? defaultBuildEngine,
        clock,
        logger,
      });
      return FAILURE_STATUSES.has(result.status) ? 1 : 0;
    }

    if (command === 'status') {
      const unresolved = await listUnresolvedTargets(deliveryStore, channels[0].id, {
        limit: parsed.limit ?? 50,
        offset: parsed.offset ?? 0,
      });
      if (!unresolved.channel && unresolved.page.total === 0) {
        return fail(logger, 'Channel state was not found');
      }
      logger.log(`Recovery targets: ${JSON.stringify(unresolved, null, 2)}`);
      return 0;
    }

    if (CONTROL_COMMANDS.has(command)) {
      const result = await (dependencies.executeRecoveryControl ?? executeRecoveryControl)(channels[0], {
        ...parsed,
        action: command,
        operatorId: parsed.operatorId || envValue(runtimeEnv, 'OPERATOR_KEY_ID', 'local-cli'),
      }, {
        cache,
        deliveryStore,
        clock,
        machineFactory: dependencies.machineFactory,
      });
      logger.log(`Recovery result: ${JSON.stringify(result, null, 2)}`);
      return CONTROL_FAILURE_STATES.has(result.status) ? 1 : 0;
    }

    if (command === 'cron' || command === 'daemon') {
      const cron = dependencies.cron ?? await loadCron();
      registerCronJobs(channels, {
        cron,
        cache,
        deliveryStore,
        runChannels: dependencies.runChannels ?? defaultRunChannels,
        clock,
        logger,
        processLike,
      });
      resourcesTransferred = true;
      return 0;
    }

    const results = parsed.force
      ? await executeLocalForce(channels[0], parsed, {
        cache,
        deliveryStore,
        clock,
        runChannels: dependencies.runChannels ?? defaultRunChannels,
      })
      : await (dependencies.runChannels ?? defaultRunChannels)(channels, {
        cache,
        deliveryStore,
        now: clock(),
        clock,
        triggerType: 'manual',
      });
    logger.log(`📊 Results: ${JSON.stringify(results, null, 2)}`);
    return results.some(result => FAILURE_STATUSES.has(result.status)) ? 1 : 0;
  } catch (error) {
    logger.error(`Runtime failed: ${sanitizeRuntimeError(error)}`);
    return 1;
  } finally {
    if (!resourcesTransferred) await closeResources({ cache, deliveryStore, logger });
  }
}

function parseArguments(args) {
  const result = {
    force: false,
    confirmDuplicateRisk: false,
    confirmPausedMutation: false,
    channelId: null,
    idempotencyKey: null,
    expectedVersion: null,
    reason: null,
    deliveryId: null,
    outputKey: null,
    outboxId: null,
    messageId: null,
    operatorId: null,
    limit: null,
    offset: null,
  };
  const valueFlags = new Map([
    ['--channel', 'channelId'],
    ['--idempotency-key', 'idempotencyKey'],
    ['--expected-version', 'expectedVersion'],
    ['--reason', 'reason'],
    ['--delivery-id', 'deliveryId'],
    ['--output-key', 'outputKey'],
    ['--outbox-id', 'outboxId'],
    ['--message-id', 'messageId'],
    ['--operator-id', 'operatorId'],
    ['--limit', 'limit'],
    ['--offset', 'offset'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--force') result.force = true;
    else if (arg === '--confirm-duplicate-risk') result.confirmDuplicateRisk = true;
    else if (arg === '--confirm-paused-mutation') result.confirmPausedMutation = true;
    else if (valueFlags.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a value` };
      result[valueFlags.get(arg)] = value;
    } else return { error: `Unknown option: ${arg}` };
  }
  if (result.idempotencyKey && (result.idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(result.idempotencyKey))) {
    return { error: '--idempotency-key must contain 1-200 visible ASCII characters' };
  }
  if (result.expectedVersion !== null) {
    if (!/^\d+$/.test(result.expectedVersion) || !Number.isSafeInteger(Number(result.expectedVersion)) || Number(result.expectedVersion) < 1) {
      return { error: '--expected-version must be a positive safe integer' };
    }
    result.expectedVersion = Number(result.expectedVersion);
  }
  for (const [field, flag, minimum, maximum] of [
    ['limit', '--limit', 1, 100],
    ['offset', '--offset', 0, 100_000],
  ]) {
    if (result[field] === null) continue;
    if (!/^\d+$/.test(result[field])
      || !Number.isSafeInteger(Number(result[field]))
      || Number(result[field]) < minimum
      || Number(result[field]) > maximum) {
      return { error: `${flag} must be a safe integer between ${minimum} and ${maximum}` };
    }
    result[field] = Number(result[field]);
  }
  for (const [field, flag, maximum] of [
    ['channelId', '--channel', 128],
    ['deliveryId', '--delivery-id', 500],
    ['outputKey', '--output-key', 500],
    ['outboxId', '--outbox-id', 500],
    ['messageId', '--message-id', 200],
    ['operatorId', '--operator-id', 100],
  ]) {
    if (result[field] && result[field].length > maximum) return { error: `${flag} exceeds ${maximum} characters` };
  }
  if (result.reason && result.reason.length > 500) return { error: '--reason exceeds 500 characters' };
  return result;
}

function validateControlArguments(command, parsed) {
  if (!CONTROL_COMMANDS.has(command)) return null;
  if (!parsed.channelId) return `${command} requires --channel <id>`;
  if (!parsed.idempotencyKey) return `${command} requires --idempotency-key <key>`;
  if (parsed.expectedVersion === null) return `${command} requires --expected-version <version>`;
  if (!parsed.reason?.trim()) return `${command} requires --reason <reason>`;
  if (['retry-generation', 'retry-output', 'restore-topology', 'confirm-delivered', 'abandon'].includes(command) && !parsed.deliveryId) {
    return `${command} requires --delivery-id <id>`;
  }
  if (['retry-output', 'confirm-delivered'].includes(command) && !parsed.outputKey) {
    return `${command} requires --output-key <key>`;
  }
  if (command === 'retry-maintenance' && !parsed.outboxId) {
    return 'retry-maintenance requires --outbox-id <id>';
  }
  return null;
}

function resolveChannels(channels, channelId) {
  if (!channelId) return channels;
  const selected = channels.filter(channel => channel.id === channelId);
  return selected.length === 1 ? selected : null;
}

async function executeLocalForce(channel, action, {
  cache,
  deliveryStore,
  clock,
  runChannels,
}) {
  const actorKeyId = requiredText(action.operatorId, 'Force actor key id', 100);
  const reason = requiredText(action.reason, 'Force reason', 500);
  const identifiers = await deriveLocalForceIdentifiers(channel.id, action.idempotencyKey);
  const actionId = await opaqueId('local-force-action', channel.id, action.idempotencyKey);
  const reasonHash = await opaqueId('local-force-reason', reason);
  const duplicateRiskAcknowledgementHash = await opaqueId(
    'local-force-duplicate-risk-acknowledgement',
    action.confirmDuplicateRisk === true,
  );
  const payloadFingerprint = await opaqueId(
    'local-force-payload',
    channel.id,
    identifiers.requestId,
    identifiers.idempotencyKey,
    actorKeyId,
    reasonHash,
    duplicateRiskAcknowledgementHash,
  );
  const requestedAt = normalizeInstant(clock(), 'Force request time');
  const audit = await deliveryStore.transact(tx => {
    const existing = tx.get(LOCAL_FORCE_ACTIONS_TABLE, actionId);
    if (existing) {
      if (existing.payload_fingerprint !== payloadFingerprint) {
        throw new Error('Idempotency key conflicts with a different force payload');
      }
      return existing;
    }
    return tx.put(LOCAL_FORCE_ACTIONS_TABLE, actionId, {
      kind: 'local_force_action',
      action_id: actionId,
      target_channel_id: channel.id,
      target_request_id: identifiers.requestId,
      engine_idempotency_id: identifiers.idempotencyKey,
      actor_key_id: actorKeyId,
      reason_hash: reasonHash,
      duplicate_risk_acknowledgement_hash: duplicateRiskAcknowledgementHash,
      payload_fingerprint: payloadFingerprint,
      status: 'accepted',
      result: null,
      requested_at: requestedAt.toISOString(),
      completed_at: null,
    }, { expectedVersion: 0 });
  });
  if (audit.status === 'completed') return audit.result;

  const results = projectForceRunResults(await runChannels([channel], {
    cache,
    deliveryStore,
    now: requestedAt,
    clock,
    triggerType: 'force',
    ...identifiers,
  }));
  const completedAt = normalizeInstant(clock(), 'Force completion time').toISOString();
  const completed = await deliveryStore.transact(tx => {
    const current = tx.get(LOCAL_FORCE_ACTIONS_TABLE, actionId);
    if (!current || current.payload_fingerprint !== payloadFingerprint) {
      throw new Error('Force audit is missing or conflicts with the request');
    }
    if (current.status === 'completed') return current;
    return tx.put(LOCAL_FORCE_ACTIONS_TABLE, actionId, {
      ...current,
      status: 'completed',
      result: results,
      completed_at: completedAt,
    }, { expectedVersion: current.version });
  });
  return completed.result;
}

function projectForceRunResults(results) {
  if (!Array.isArray(results)) throw new Error('Force runner returned an invalid result');
  return results.slice(0, 10).map(result => ({
    channelId: boundedText(result?.channelId, 128) || 'unknown',
    status: boundedText(result?.status, 80) || 'error',
    ...(result?.reason ? { reason: boundedText(sanitizeRuntimeError(result.reason), 200) } : {}),
    ...(result?.error ? { error: boundedText(sanitizeRuntimeError(result.error), 500) } : {}),
    ...(result?.deliveryId ? { deliveryId: boundedText(result.deliveryId, 500) } : {}),
    ...(result?.stats && typeof result.stats === 'object' ? { stats: projectRuntimeStats(result.stats) } : {}),
  }));
}

function projectRuntimeStats(stats) {
  const projected = {};
  for (const key of ['sources', 'articles', 'outputs', 'durationMs', 'remaining', 'blocked']) {
    if (Number.isFinite(stats[key])) projected[key] = stats[key];
  }
  if (typeof stats.mode === 'string') projected.mode = boundedText(stats.mode, 20);
  if (typeof stats.ai === 'string') projected.ai = boundedText(stats.ai, 100);
  const selection = projectSelectionStats(stats.selection);
  if (selection) projected.selection = selection;
  return projected;
}

function requiredText(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function boundedText(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

function normalizeInstant(value, label) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`${label} is invalid`);
  return instant;
}

/**
 * Mode-aware read-only preview: one dry run that fetches and summarizes but
 * never claims, sends, or writes delivery state. Shared with the app runtime.
 * @returns {Promise<object>} The engine's dry-run result.
 */
export async function preview(channel, { cache, deliveryStore, buildEngine, clock, logger }) {
  logger.log(`👀 Preview: ${channel.id} (${channel.mode})`);
  const engine = buildEngine(channel, { cache, deliveryStore, clock });
  const result = channel.mode === 'drip'
    ? await engine.runDrip({ dryRun: true, force: false })
    : await engine.run({ dryRun: true, force: false });
  if (result.content) logger.log(result.content);
  else if (result.articles) logger.log(JSON.stringify(result.articles, null, 2));
  if (result.stats) logger.log(`📊 ${JSON.stringify(result.stats, null, 2)}`);
  return result;
}

/** Execute one exact, versioned operator recovery action against local durable state. */
export async function executeRecoveryControl(channel, action, {
  cache,
  deliveryStore,
  clock = () => new Date(),
  machineFactory,
} = {}) {
  const createMachine = machineFactory ?? (options => new DeliveryStateMachine(options));
  const machine = createMachine({ store: deliveryStore, channelId: channel.id, clock });
  const common = {
    action: action.action,
    idempotencyKey: action.idempotencyKey,
    expectedVersion: action.expectedVersion,
    operatorId: action.operatorId,
    reason: action.reason.trim(),
  };

  if (action.action === 'pause' || action.action === 'resume') {
    const operatorActionId = await opaqueId('operator-action', channel.id, action.idempotencyKey);
    if (action.action === 'resume' && !await deliveryStore.get('operator_actions', operatorActionId)) {
      await machine.recoverStaleAttempts();
    }
    const result = await machine.setPaused(action.action === 'pause', common);
    return projectRecoveryResult(result);
  }

  const retrying = ['retry-generation', 'retry-output'].includes(action.action);
  const requestId = retrying
    ? await opaqueId('local-operator-request', channel.id, action.action, action.idempotencyKey)
    : null;
  const coreAction = {
    ...common,
    ...(action.deliveryId && { deliveryId: action.deliveryId }),
    ...(action.outputKey && { outputKey: action.outputKey }),
    ...(action.outboxId && { outboxId: action.outboxId }),
    ...(action.messageId && { messageId: action.messageId }),
    ...(requestId && { requestId }),
    confirmPausedMutation: action.confirmPausedMutation === true,
    duplicateRiskAccepted: action.confirmDuplicateRisk === true,
  };
  const operatorActionId = await opaqueId('operator-action', channel.id, action.idempotencyKey);
  if (await deliveryStore.get('operator_actions', operatorActionId)) {
    return projectRecoveryResult(await machine.reconcile(coreAction));
  }
  let configuredOutput = null;
  let targetDelivery = null;
  let prefixedCache = null;
  if (['retry-generation', 'restore-topology', 'abandon'].includes(action.action)) {
    targetDelivery = await machine.getDelivery(action.deliveryId);
    if (!targetDelivery || targetDelivery.channelId !== channel.id) throw new Error('Recovery delivery target was not found');
  }
  if (['retry-output', 'confirm-delivered'].includes(action.action)) {
    targetDelivery = await machine.getDelivery(action.deliveryId);
    if (!targetDelivery || targetDelivery.channelId !== channel.id) throw new Error('Recovery output target was not found');
    const target = await machine.getOutput(action.deliveryId, action.outputKey);
    if (!target) throw new Error('Recovery output target was not found');
    if (action.action === 'retry-output') {
      const outputs = channel.outputs ?? [channel.output];
      configuredOutput = outputs[target.ordinal];
      if (!configuredOutput) throw new Error('Output topology changed before operator retry');
    }
  }
  if (retrying) {
    const topology = await buildOutputTopology(channel.outputs ?? [channel.output]);
    if (targetDelivery.topologyFingerprint !== topology.fingerprint || targetDelivery.state === 'blocked_topology') {
      throw new Error('Output topology changed before operator retry');
    }
  }
  if (action.action === 'restore-topology') {
    const topology = await buildOutputTopology(channel.outputs ?? [channel.output]);
    if (targetDelivery.topologyFingerprint !== topology.fingerprint) {
      throw new Error('Configured output topology has not been restored');
    }
    coreAction.topologyFingerprint = topology.fingerprint;
  }
  if (action.action === 'retry-maintenance') {
    const target = (await machine.listOutbox(value => value.outboxId === action.outboxId))[0];
    if (!target) throw new Error('Recovery maintenance target was not found');
    prefixedCache = new PrefixedCache(cache, `news:${channel.id}`);
  }
  if (action.action === 'retry-generation' && typeof channel.ai?.summarize !== 'function') {
    throw new Error('Configured AI provider is unavailable for generation retry');
  }
  const result = await machine.reconcile(coreAction);
  if (result.replayed || result.status !== 'claimed') return projectRecoveryResult(result);

  if (action.action === 'retry-generation') {
    try {
      const timeoutMs = attemptBoundedTimeoutMs(
        result.attempt,
        channel.generationTimeoutMs ?? channel.options?.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
        clock,
        'Generation retry',
      );
      // Mirror the engine's summarize options so a retried generation uses the channel's prompt.
      const generated = await withOperationTimeout(signal => channel.ai.summarize(result.articles, {
        language: channel.prompt?.language || 'vi',
        style: channel.prompt?.style,
        audience: channel.prompt?.audience,
        platform: channel.prompt?.platform,
        ...(channel.prompt?.customSystemPrompt && { customSystemPrompt: channel.prompt.customSystemPrompt }),
        deliveryMode: result.delivery.mode,
        signal,
      }), timeoutMs, 'Generation retry');
      const delivery = await machine.commitGeneration(result.attempt.attemptId, { content: generated.text });
      return projectRecoveryResult({ status: delivery.state, delivery });
    } catch (error) {
      const delivery = await machine.failGeneration(result.attempt.attemptId, error, { retryDisposition: 'never' });
      return projectRecoveryResult({ status: delivery.state, delivery });
    }
  }

  if (action.action === 'retry-output') {
    if (configuredOutput.id !== result.output.providerId) {
      throw new Error('Output topology changed during operator retry');
    }
    let normalized;
    try {
      const timeoutMs = attemptBoundedTimeoutMs(
        result.attempt,
        channel.outputTimeoutMs ?? channel.options?.outputTimeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS,
        clock,
        'Output retry',
      );
      normalized = normalizeSendResult(await withOperationTimeout(signal => configuredOutput.send(
        targetDelivery.singleMutation === true ? result.content : fitToOutput(result.content, configuredOutput),
        {
          articles: targetDelivery.articleSnapshot,
          article: targetDelivery.mode === 'drip' ? targetDelivery.articleSnapshot[0] : undefined,
          deliveryId: targetDelivery.deliveryId,
          attemptId: result.attempt.attemptId,
          singleMutation: targetDelivery.singleMutation === true,
          signal,
        },
      ), timeoutMs, 'Output retry'), { now: new Date(clock()).getTime() });
    } catch (error) {
      normalized = normalizeSendResult(null, { error, now: new Date(clock()).getTime() });
    }
    const committed = await machine.commitOutput(result.attempt.attemptId, normalized);
    return projectRecoveryResult({ status: committed.delivery.state, delivery: committed.delivery });
  }

  if (action.action === 'retry-maintenance') {
    try {
      await prefixedCache.set(
        result.outbox.targetKey,
        result.outbox.targetValue,
        result.outbox.kind === 'legacy_digest' ? 30 * 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000,
      );
      const outbox = await machine.commitMaintenance(result.outbox.outboxId, { success: true });
      return projectRecoveryResult({ status: outbox.state, outbox });
    } catch (error) {
      const outbox = await machine.commitMaintenance(result.outbox.outboxId, { success: false, error });
      return projectRecoveryResult({ status: outbox.state, outbox });
    }
  }

  return projectRecoveryResult(result);
}

function projectRecoveryResult(result) {
  const delivery = result.delivery;
  const channel = result.channel;
  const outbox = result.outbox;
  return {
    status: String(result.status ?? 'failed').slice(0, 80),
    ...(delivery ? {
      deliveryId: delivery.deliveryId,
      deliveryState: delivery.state,
      version: delivery.version,
    } : {}),
    ...(channel ? {
      channelId: channel.channelId,
      paused: channel.paused === true,
      version: channel.version,
    } : {}),
    ...(outbox ? {
      outboxId: outbox.outboxId,
      outboxState: outbox.state,
      version: outbox.version,
    } : {}),
    replayed: result.replayed === true,
  };
}

function fitToOutput(content, output) {
  const maxLength = output.maxLength ?? Infinity;
  if (content.length <= maxLength) return content;
  const truncated = content.substring(0, Math.max(0, maxLength - 50));
  const lastBreak = truncated.lastIndexOf('\n\n');
  return (lastBreak > content.length * 0.5 ? truncated.substring(0, lastBreak) : truncated) + '\n\n[...]';
}

function attemptBoundedTimeoutMs(attempt, preferredTimeoutMs, clock, label) {
  const preferred = Number(preferredTimeoutMs);
  if (!Number.isSafeInteger(preferred) || preferred <= 0) {
    throw new Error(`${label} timeout must be a positive safe integer`);
  }
  const startedAt = Date.parse(attempt?.startedAt);
  const deadlineAt = Date.parse(attempt?.deadlineAt);
  const nowValue = clock();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= startedAt) {
    throw new Error(`${label} attempt lease is invalid`);
  }
  if (!Number.isFinite(now.getTime())) throw new Error(`${label} clock is invalid`);
  const leaseMs = deadlineAt - startedAt;
  const remainingMs = deadlineAt - now.getTime();
  const strictCeiling = Math.floor(Math.min(leaseMs, remainingMs) - 1);
  if (strictCeiling < 1) throw new Error(`${label} attempt lease expired before the provider call`);
  return Math.min(preferred, Math.max(1, Math.floor(leaseMs - 100)), strictCeiling);
}

async function withOperationTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function registerCronJobs(channels, { cron, cache, deliveryStore, runChannels, clock, logger, processLike }) {
  const tasks = [];
  const activeRuns = new Set();
  let accepting = true;
  let closing;
  logger.log(`⏰ Registering ${channels.length} exact channel schedule(s)`);
  for (const channel of channels) {
    const task = cron.schedule(channel.schedule, async () => {
      if (!accepting) return [{ channelId: channel.id, status: 'skipped', reason: 'shutting_down' }];
      const execution = (async () => {
        try {
          const results = await runChannels([channel], {
            cache,
            deliveryStore,
            now: clock(),
            clock,
            triggerType: 'scheduled',
          });
          if (results.some(result => FAILURE_STATUSES.has(result.status))) processLike.exitCode = 1;
          return results;
        } catch (error) {
          processLike.exitCode = 1;
          const sanitized = sanitizeRuntimeError(error);
          logger.error(`[Cron] ${channel.id}: ${sanitized}`);
          return [{ channelId: channel.id, status: 'error', error: sanitized }];
        }
      })();
      activeRuns.add(execution);
      try { return await execution; }
      finally { activeRuns.delete(execution); }
    }, { timezone: channel.timezone || 'UTC' });
    tasks.push(task);
    logger.log(`   ${channel.id}: ${channel.schedule} (${channel.timezone || 'UTC'}, ${channel.mode})`);
  }

  const quit = async () => {
    if (closing) return closing;
    closing = (async () => {
      accepting = false;
      for (const task of tasks) task.stop?.();
      await Promise.allSettled([...activeRuns]);
      await closeResources({ cache, deliveryStore, logger });
      logger.log('🛑 Bye');
    })();
    return closing;
  };
  processLike.once?.('SIGINT', quit);
  processLike.once?.('SIGTERM', quit);
  return tasks;
}

async function closeResources({ cache, deliveryStore, logger }) {
  const errors = [];
  try { if (deliveryStore?.close) await deliveryStore.close(); } catch (error) { errors.push(error); }
  try { if (cache?.disconnect) await cache.disconnect(); } catch (error) { errors.push(error); }
  if (errors.length) logger.error(`Shutdown failed: ${errors.map(sanitizeRuntimeError).join('; ')}`);
}

async function loadCron() {
  try {
    const imported = await import('node-cron');
    return imported.default ?? imported;
  } catch {
    throw new Error('node-cron is required for daemon mode');
  }
}

async function loadEnvironment() {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    // dotenv is optional; process environments remain supported.
  }
}

function envValue(runtimeEnv, key, fallback) {
  return runtimeEnv[key] === undefined || runtimeEnv[key] === '' ? fallback : String(runtimeEnv[key]);
}

function fail(logger, message) {
  logger.error(`❌ ${sanitizeRuntimeError(message)}`);
  return 1;
}

function helpText() {
  return `
📡 Content Radar — Node.js Adapter

  node src/adapters/node.js <command> [options]

  run       Manual run; bypasses cron without forcing delivery
  drip      Alias of run; each channel retains its configured mode
  cron      Daemon using each channel's exact cron and timezone
  daemon    Alias of cron
  preview   Mode-aware read-only preview
  status    Read-only exact unresolved recovery targets for one channel
  pause     Pause one channel at an exact state version
  resume    Resume one channel at an exact state version
  retry-generation  Retry one exhausted/retryable generation
  retry-output      Retry one exact unresolved output
  confirm-delivered Confirm one exact ambiguous output
  restore-topology  Manually restore one config-matched topology blocker
  abandon           Abandon one exact unresolved delivery
  retry-maintenance Retry one exact dead-letter cache mirror
  help      This message

  --channel <id>               Select one channel
  --force                      Explicit force delivery (requires one channel)
  --idempotency-key <key>      Durable force/control replay key
  --operator-id <key-id>       Operator actor key id (or OPERATOR_KEY_ID)
  --confirm-duplicate-risk     Acknowledge possible terminal resend
  --expected-version <number>  Required target version for controls
  --reason <text>              Required bounded operator reason
  --delivery-id <id>           Exact delivery target
  --output-key <key>           Exact output target
  --outbox-id <id>             Exact maintenance target
  --message-id <id>            Optional provider id when confirming
  --confirm-paused-mutation    Authorize an immediate paused retry
  --limit <number>             Status page size (1-100)
  --offset <number>            Status page offset
`;
}

const isExecutable = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutable) {
  process.exitCode = await main();
}
