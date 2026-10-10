/**
 * Composition root of the app runtime: the one service the API layer calls.
 * It runs Telegram channels stored in SQLite with the same delivery
 * guarantees as the CLI (sequential outputs, durable state machine, ambiguous
 * outputs never resent automatically, read-only preview, tech gate, story
 * dedup, daily limit) and serves the dashboard's operational, library, and
 * statistics data.
 *
 * Safety invariants:
 * - Every channel is paused in the delivery store before its config row is
 *   written (create and seed), so no path creates an unpaused channel.
 * - Resume is refused unless the channel builds with all its credentials.
 * - A cutover channel (`cutoverRequired`, the seeded `telegram-main`) cannot
 *   resume, run, or retry an output until its `notBefore` is set.
 * - Runs, and every control except pause, need the single-instance runtime
 *   lease; pause is always allowed because it only stops delivery.
 * - Output paths use a persistent file cache, never `MemoryCache`.
 *
 * Expected start-up order (API layer): open the database and run migrations,
 * `await createRuntime(...)`, `seedDefaultChannels()`, start listening, then
 * `start()`; on SIGTERM call `stop()`, then close the database only after
 * `drain()` settles (a run in flight is never cut short).
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { FileCache } from '../../core/caches.js';
import { assertDeliveryStore } from '../../core/delivery-store.js';
import { SQLiteDeliveryStore } from '../../core/sqlite-delivery-store.js';
import { ChannelConflictError, ChannelNotFoundError, ChannelRepository } from '../channels/channel-repository.js';
import { validateChannelConfig } from '../channels/config-schema.js';
import { seedDefaultChannels as seedChannels } from '../channels/seed.js';
import { requireActor } from '../channels/validation.js';
import { ContentRepository } from '../db/content-repository.js';
import { createNodeSqlStorage } from '../db/node-sql-storage.js';
import { resolveDataDir } from '../db/open-database.js';
import { RunRepository } from '../db/run-repository.js';
import { RuntimeLease } from '../db/runtime-lease.js';
import { StatsRepository } from '../db/stats-repository.js';
import { CredentialRepository } from '../secrets/credential-repository.js';
import { ChannelStatusReader } from './channel-status.js';
import { BlockedChannelAlerts } from './alerts.js';
import { ContentSync } from './content-sync.js';
import { ChannelControls, NEW_CHANNEL_PAUSE_REASON, SYSTEM_OPERATOR_ID } from './controls.js';
import { assertCutoverReady } from './cutover-guard.js';
import { RuntimeError } from './errors.js';
import { RuntimeEvents } from './events.js';
import {
  DEFAULT_CONTENT_SCAN_RETENTION_DAYS,
  DEFAULT_RUN_HISTORY_RETENTION_DAYS,
  RetentionJob,
} from './retention.js';
import { ChannelRunExecutor, createChannelBuilder, previewStoredChannel } from './run-channel.js';
import { RuntimeScheduler } from './scheduler.js';

/** @typedef {Awaited<ReturnType<typeof createRuntime>>} ContentRadarRuntime */

/** File cache name inside the data directory; keys stay under the `news:<channelId>` prefix. */
export const CACHE_FILE_NAME = 'news.json';

const CACHE_PREFLIGHT_KEY = '__news_runtime_preflight__';
const MAX_OWNER_ID_LENGTH = 200;

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dataDir: string,
 *   vault: import('../secrets/vault.js').SecretVault,
 *   deliveryStore?: import('../../core/delivery-store.js').DeliveryStore,
 *   cache?: import('../../core/contracts.js').CachePlugin,
 *   cron?: { schedule: Function },
 *   clock?: () => Date,
 *   logger?: Pick<Console, 'log'|'warn'|'error'>,
 *   ownerId?: string,
 *   channelFactories?: Partial<typeof import('../channels/build-channel.js').DEFAULT_CHANNEL_FACTORIES>,
 *   timers?: object,
 *   leaseTtlMs?: number,
 *   heartbeatMs?: number,
 *   shutdownTimeoutMs?: number,
 *   contentScanRetentionDays?: number,
 *   runHistoryRetentionDays?: number,
 *   alertChatId?: string|null,
 *   alerts?: BlockedChannelAlerts,
 * }} options
 *   - `db`: migrated app database (`runAppMigrations`) shared with the delivery store.
 *   - `vault`: secret vault holding `APP_MASTER_KEY`; credentials are decrypted only to build channels.
 *   - `deliveryStore`: defaults to `SQLiteDeliveryStore` on `db`; it is initialized here.
 *   - `cache`: defaults to `FileCache(${dataDir}/news.json)`; must be persistent.
 *   - `cron`: node-cron compatible scheduler (defaults to `node-cron`).
 *   - `channelFactories`: plugin constructors for sources/AI/output (tests inject fakes).
 *   - `contentScanRetentionDays` / `runHistoryRetentionDays`: from
 *     `CONTENT_SCAN_RETENTION_DAYS` (default 30) / `RUN_HISTORY_RETENTION_DAYS` (default 180).
 *   - `alertChatId`: `ALERT_TELEGRAM_CHAT_ID`; when set, a channel blocked by an unconfirmed send is reported there.
 *     `alerts` replaces the notifier (tests).
 * @returns {Promise<ContentRadarRuntime>}
 */
export async function createRuntime({
  db,
  dataDir,
  vault,
  deliveryStore,
  cache,
  cron,
  clock = () => new Date(),
  logger = console,
  ownerId = defaultOwnerId(),
  channelFactories = {},
  timers,
  leaseTtlMs,
  heartbeatMs,
  shutdownTimeoutMs,
  contentScanRetentionDays = DEFAULT_CONTENT_SCAN_RETENTION_DAYS,
  runHistoryRetentionDays = DEFAULT_RUN_HISTORY_RETENTION_DAYS,
  alertChatId = null,
  alerts = new BlockedChannelAlerts({ chatId: alertChatId, logger }),
} = {}) {
  const storage = createNodeSqlStorage(db);
  const directory = resolveDataDir(dataDir);
  if (typeof clock !== 'function') throw new TypeError('createRuntime clock must be a function');
  if (typeof ownerId !== 'string' || ownerId.trim() === '' || ownerId.length > MAX_OWNER_ID_LENGTH) {
    throw new TypeError(`Runtime owner id must be a non-empty string of at most ${MAX_OWNER_ID_LENGTH} characters`);
  }

  const store = deliveryStore ?? new SQLiteDeliveryStore(storage);
  assertDeliveryStore(store);
  await store.initialize();
  const runtimeCache = cache ?? new FileCache(join(directory, CACHE_FILE_NAME), { now: () => clock().getTime() });
  if (runtimeCache.capabilities?.persistent !== true) {
    throw new TypeError('The runtime cache must be persistent; MemoryCache is not allowed on output paths');
  }
  if (typeof runtimeCache.peek === 'function') await runtimeCache.peek(CACHE_PREFLIGHT_KEY);
  const cronScheduler = cron ?? await loadCron();

  const channels = new ChannelRepository({ storage, clock });
  const credentials = new CredentialRepository({ storage, vault, clock });
  const runs = new RunRepository({ storage });
  const content = new ContentRepository({ storage, clock });
  const stats = new StatsRepository({ storage });
  const lease = new RuntimeLease({ storage, clock });
  const events = new RuntimeEvents({ clock, logger });
  const contentSync = new ContentSync({ deliveryStore: store, contentRepository: content, logger });
  const buildChannel = createChannelBuilder({ credentials, factories: channelFactories });
  const controls = new ChannelControls({ channels, deliveryStore: store, cache: runtimeCache, buildChannel, contentSync, clock });
  const statusReader = new ChannelStatusReader({ deliveryStore: store, runs, clock });

  const pauseChannel = async (channelId, context) => {
    const result = await controls.pauseChannel(channelId, context);
    if (result.status === 'paused') {
      events.emit('control.applied', { channelId, action: 'pause', status: 'paused', replayed: false, system: true });
    }
    return result;
  };
  const executor = new ChannelRunExecutor({
    channels,
    buildChannel,
    deliveryStore: store,
    cache: runtimeCache,
    runs,
    content,
    contentSync,
    pauseChannel,
    events,
    clock,
    logger,
    alerts,
  });
  const retention = new RetentionJob({
    storage,
    deliveryStore: store,
    contentRepository: content,
    runRepository: runs,
    contentSync,
    listChannelIds: () => channels.list().map(channel => channel.id),
    clock,
    logger,
    contentScanDays: contentScanRetentionDays,
    runHistoryDays: runHistoryRetentionDays,
  });
  const scheduler = new RuntimeScheduler({
    lease,
    ownerId,
    cron: cronScheduler,
    getChannel: channelId => channels.get(channelId),
    listChannels: () => channels.list(),
    executeRun: request => executor.execute(request),
    onLeaseAcquired: ({ first, inFlightRunIds }) => {
      if (!first) return;
      const interrupted = runs.interruptStale({ finishedAt: clock(), excludeIds: inFlightRunIds });
      if (interrupted > 0) logger.log?.(`[Runtime] Marked ${interrupted} run(s) left by a previous process as interrupted`);
    },
    maintenance: {
      isDue: () => retention.isDue(),
      execute: options => runMaintenance(options),
    },
    clock,
    logger,
    timers,
    leaseTtlMs,
    heartbeatMs,
    shutdownTimeoutMs,
  });

  // Retention fully syncs every channel before compacting, so a due retention
  // run also covers the start-up full sync.
  async function runMaintenance({ fullSync }) {
    if (retention.isDue()) return { synced: null, retention: await retention.run() };
    let synced = 0;
    if (fullSync) {
      const ids = new Set(channels.list().map(channel => channel.id));
      for (const state of await store.list('channel_state')) if (state?.channelId) ids.add(state.channelId);
      for (const channelId of ids) {
        if (await contentSync.syncQuietly(channelId, { full: true })) synced += 1;
      }
    }
    return { synced, retention: null };
  }

  const previews = new Map();
  let stopped = false;

  function requireChannel(channelId) {
    const record = channels.get(channelId);
    if (!record) throw new ChannelNotFoundError(String(channelId));
    return record;
  }

  function requireActive() {
    if (stopped) throw new RuntimeError('runtime_stopped', 'The runtime is shutting down');
    if (!scheduler.active) {
      throw new RuntimeError('runtime_not_leased', 'This instance does not hold the runtime lease; another instance may be running');
    }
  }

  function runtimeFlags(channelId) {
    const view = scheduler.describe();
    return {
      scheduled: view.scheduledChannels.includes(channelId),
      running: view.running?.channelId === channelId,
      queued: view.queued.some(job => job.channelId === channelId),
    };
  }

  function buildService() {
    return {
      /**
       * Start lease acquisition and scheduling. Resolves after the first
       * lease attempt; when another instance holds the lease, retries continue
       * in the background.
       * @returns {Promise<{ leased: boolean }>}
       */
      start: () => scheduler.start(),

      /**
       * Stop scheduling and wait (bounded) for in-flight work. Work in flight
       * is never cut short: on `timedOut` it keeps running with the lease
       * renewed; `drain()` settles when it is done.
       * @param {{ timeoutMs?: number }} [options]
       * @returns {Promise<{ released: boolean, timedOut: boolean }>}
       */
      stop: options => {
        stopped = true;
        return scheduler.stop(options);
      },

      /**
       * Wait, without a time limit, until no run or control started before
       * (or tracked during) shutdown is in flight; the runtime lease is
       * released by then. Close the database only after this settles. Calls
       * `stop()` first when needed.
       * @returns {Promise<{ released: boolean }>}
       */
      drain: () => {
        stopped = true;
        return scheduler.drain();
      },

      /**
       * Seed `telegram-main` (paused, without credentials) when no channel exists.
       * @returns {Promise<{ seeded: boolean, channelIds: string[] }>}
       */
      async seedDefaultChannels() {
        const result = await seedChannels({ channelRepository: channels, pauseChannel, clock });
        for (const channelId of result.channelIds) {
          scheduler.reloadChannel(channelId);
          events.emit('channel.changed', { channelId, action: 'created', version: channels.get(channelId)?.version ?? null });
        }
        return result;
      },

      /**
       * Runtime liveness for `/api/health`: lease ownership and the work queue.
       * @returns {object}
       */
      getHealth() {
        const view = scheduler.describe();
        let holder = null;
        try {
          holder = lease.current();
        } catch (error) {
          logger.warn?.(`[Runtime] Could not read the runtime lease: ${error?.message ?? 'unknown error'}`);
        }
        return {
          ownerId,
          active: view.active,
          leased: view.leased,
          leaseHolder: holder ? { ownerId: holder.ownerId, expiresAt: holder.expiresAt, heartbeatAt: holder.heartbeatAt } : null,
          running: view.running,
          queued: view.queued.length,
          scheduledChannels: view.scheduledChannels.length,
        };
      },

      /**
       * Subscribe to runtime events (`run.started`, `run.finished`,
       * `control.applied`, `channel.changed`, `credential.changed`).
       * @param {(event: import('./events.js').RuntimeEvent) => unknown} listener
       * @returns {() => void} Unsubscribe.
       */
      onEvent: listener => events.on(listener),

      /** @returns {import('../channels/channel-repository.js').ChannelRecord[]} */
      listChannels: () => channels.list(),

      /**
       * @param {string} channelId
       * @returns {import('../channels/channel-repository.js').ChannelRecord|null}
       */
      getChannel: channelId => channels.get(channelId),

      /**
       * Create a channel. Its delivery state is paused before the config row
       * is written; it stays paused until an operator resumes it.
       * @param {unknown} input Channel config.
       * @param {string} actor Authenticated identity.
       * @returns {Promise<import('../channels/channel-repository.js').ChannelRecord>}
       */
      async createChannel(input, actor) {
        const createdBy = requireActor(actor);
        const config = validateChannelConfig(input);
        if (channels.get(config.id)) throw new ChannelConflictError('channel_exists', config.id);
        await pauseChannel(config.id, { operatorId: SYSTEM_OPERATOR_ID, reason: NEW_CHANNEL_PAUSE_REASON });
        const record = channels.create(input, { actor: createdBy });
        scheduler.reloadChannel(record.id);
        events.emit('channel.changed', { channelId: record.id, action: 'created', version: record.version });
        return record;
      },

      /**
       * Update a channel; `input.version` must be the current config version.
       * The schedule reloads immediately and the next run uses the new config.
       * @param {string} channelId
       * @param {Record<string, unknown> & { version: number }} input
       * @param {string} actor
       * @returns {Promise<import('../channels/channel-repository.js').ChannelRecord>}
       */
      async updateChannel(channelId, input, actor) {
        const updatedBy = requireActor(actor);
        const record = channels.update(channelId, input, { expectedVersion: input?.version, actor: updatedBy });
        scheduler.reloadChannel(record.id);
        events.emit('channel.changed', { channelId: record.id, action: 'updated', version: record.version });
        return record;
      },

      /**
       * Delete a channel's config. Requires the channel to be paused, idle,
       * and free of unresolved deliveries. Delivery state, runs, and library
       * rows are kept.
       * @param {string} channelId
       * @param {string} actor
       * @param {{ expectedVersion?: number }} [options]
       * @returns {Promise<{ channelId: string, deleted: true }>}
       */
      async deleteChannel(channelId, actor, { expectedVersion } = {}) {
        requireActor(actor);
        const record = requireChannel(channelId);
        if (scheduler.isBusy(record.id)) throw new RuntimeError('channel_busy', `Channel "${record.id}" is running or queued`);
        const state = await store.get('channel_state', record.id);
        if (state && state.paused !== true) {
          throw new RuntimeError('channel_not_paused', `Channel "${record.id}" must be paused before it is deleted`);
        }
        if (state && state.mutationState && state.mutationState !== 'free') {
          throw new RuntimeError('channel_busy', `Channel "${record.id}" has an output attempt in flight`);
        }
        const unresolved = await statusReader.unresolved(record.id, { limit: 1 });
        if (unresolved.page.total > 0) {
          throw new RuntimeError('channel_has_unresolved', `Channel "${record.id}" still has ${unresolved.page.total} unresolved item(s)`, {
            details: { unresolved: unresolved.page.total },
          });
        }
        channels.delete(record.id, { expectedVersion });
        scheduler.reloadChannel(record.id);
        events.emit('channel.changed', { channelId: record.id, action: 'deleted', version: null });
        return { channelId: record.id, deleted: true };
      },

      /**
       * Pause a channel's delivery state (system or seed use). Idempotent and
       * valid before the channel's config row exists.
       * @param {string} channelId
       * @param {{ operatorId?: string, reason?: string }} [context]
       */
      pauseChannel,

      /** @returns {import('../secrets/credential-repository.js').CredentialMetadata[]} */
      listCredentials: () => credentials.list(),

      /**
       * @param {string} credentialId
       * @returns {import('../secrets/credential-repository.js').CredentialMetadata|null}
       */
      getCredential: credentialId => credentials.get(credentialId),

      /**
       * @param {{ label: string, kind: string, value: string }} input Write-only value.
       * @param {string} actor
       * @returns {import('../secrets/credential-repository.js').CredentialMetadata} Metadata only.
       */
      createCredential(input, actor) {
        const metadata = credentials.create({ ...input, actor: requireActor(actor) });
        events.emit('credential.changed', { credentialId: metadata.id, action: 'created', kind: metadata.kind });
        return metadata;
      },

      /**
       * @param {string} credentialId
       * @param {{ value: string }} input
       * @param {string} actor
       * @returns {import('../secrets/credential-repository.js').CredentialMetadata} Metadata only.
       */
      replaceCredential(credentialId, input, actor) {
        const metadata = credentials.replace(credentialId, { ...input, actor: requireActor(actor) });
        events.emit('credential.changed', { credentialId: metadata.id, action: 'replaced', kind: metadata.kind });
        return metadata;
      },

      /**
       * Delete an unused credential.
       * @param {string} credentialId
       * @param {string} actor
       * @returns {{ credentialId: string, deleted: true }}
       */
      deleteCredential(credentialId, actor) {
        requireActor(actor);
        credentials.delete(credentialId);
        events.emit('credential.changed', { credentialId, action: 'deleted', kind: null });
        return { credentialId, deleted: true };
      },

      /**
       * Manual trigger: an ordinary run that bypasses the cron schedule (not a
       * force run), queued behind any run in progress. Refused with
       * `cutover_required` while a cutover channel's `notBefore` is unset.
       * @param {string} channelId
       * @param {string} actor
       * @param {{ wait?: boolean }} [options] `wait` resolves with the finished run.
       * @returns {Promise<object>} `{ status: 'queued', runId, position }`, a
       *   `{ status: 'skipped', reason }` when the channel is already running or
       *   queued, or with `wait` the run outcome.
       */
      async runNow(channelId, actor, { wait = false } = {}) {
        const triggeredBy = requireActor(actor);
        const record = requireChannel(channelId);
        if (!record.enabled) throw new RuntimeError('channel_disabled', `Channel "${record.id}" is disabled`);
        assertCutoverReady(record);
        requireActive();
        const queued = scheduler.enqueueRun({
          channelId: record.id,
          runId: randomUUID(),
          triggerType: 'manual',
          requestedAt: clock(),
          triggeredBy,
        });
        if (queued.status !== 'queued') return { status: 'skipped', reason: queued.reason, channelId: record.id };
        if (wait) return queued.done;
        return { status: 'queued', channelId: record.id, runId: queued.runId, position: queued.position };
      },

      /**
       * Read-only preview (same calls as the CLI `preview`): fetches and
       * summarizes, never sends, never writes delivery state, runs, or library
       * rows. Concurrent previews of one channel share a single dry run.
       * @param {string} channelId
       * @returns {Promise<object>}
       */
      async preview(channelId) {
        const record = requireChannel(channelId);
        if (stopped) throw new RuntimeError('runtime_stopped', 'The runtime is shutting down');
        const inFlight = previews.get(record.id);
        if (inFlight) return inFlight;
        const promise = previewStoredChannel(record, { buildChannel, cache: runtimeCache, deliveryStore: store, clock })
          .finally(() => previews.delete(record.id));
        previews.set(record.id, promise);
        return promise;
      },

      /**
       * Apply one operator control through the delivery state machine.
       * @param {string} channelId
       * @param {string} action pause | resume | retry-generation | retry-output |
       *   restore-topology | confirm-delivered | abandon | retry-maintenance
       * @param {import('./controls.js').ControlParams} params
       * @param {string} actor Authenticated identity, recorded as `operatorId`.
       * @returns {Promise<object>}
       */
      async control(channelId, action, params, actor) {
        if (action !== 'pause') requireActive();
        const result = await scheduler.track(controls.execute(channelId, action, params, actor));
        events.emit('control.applied', {
          channelId: result.channelId,
          action,
          status: result.status,
          replayed: result.replayed === true,
        });
        return result;
      },

      /**
       * Operational snapshot: delivery state (`version` = expectedVersion for
       * pause/resume), today's queue counts, last run, unresolved count.
       * @param {string} channelId
       * @returns {Promise<object>}
       */
      async getStatus(channelId) {
        const record = requireChannel(channelId);
        return statusReader.status(record, runtimeFlags(record.id));
      },

      /**
       * Deliveries of one publishing day (default: today in the channel timezone).
       * @param {string} channelId
       * @param {string} [day] YYYY-MM-DD
       * @returns {Promise<import('./channel-status.js').QueueView>}
       */
      async listQueue(channelId, day) {
        return statusReader.queue(requireChannel(channelId), day);
      },

      /**
       * Exact recovery targets with their allowed actions and versions.
       * @param {string} channelId
       * @param {{ limit?: number, offset?: number }} [page]
       */
      async listUnresolved(channelId, page) {
        return statusReader.unresolved(requireChannel(channelId).id, page);
      },

      /**
       * @param {string} channelId
       * @param {{ limit?: number, offset?: number }} [page]
       */
      listRuns: (channelId, page) => runs.list(channelId, page),

      /**
       * @param {string} runId
       * @returns {import('../db/run-repository.js').RunRecord|null} With per-source health.
       */
      getRun: runId => runs.get(runId),

      /**
       * Library listing; see `ContentRepository.list()` for filters.
       * @param {object} [query]
       */
      listContent: query => content.list(query),

      /**
       * @param {string} contentId
       * @returns {import('../db/content-repository.js').ContentItem|null}
       */
      getContent: contentId => content.get(contentId),

      /**
       * Posts per day per channel, source health per day, AI/output failure
       * rates per day, and token usage per day.
       * @param {import('../db/stats-repository.js').StatsQuery} query
       */
      getStats: query => stats.getStats(query),

      /**
       * Run retention now (it otherwise runs at most once a day).
       * @param {{ force?: boolean }} [options]
       */
      runRetention: options => retention.run(options),
    };
  }

  return Object.freeze(buildService());
}

function defaultOwnerId() {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, MAX_OWNER_ID_LENGTH);
}

async function loadCron() {
  const imported = await import('node-cron');
  return imported.default ?? imported;
}
