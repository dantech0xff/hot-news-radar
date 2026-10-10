#!/usr/bin/env node
/**
 * Process lifecycle of the Content Radar app: one Node process serving the
 * dashboard API and UI and running the channel scheduler on SQLite.
 * Importing this module does not read the environment, open the database, or
 * listen; `node src/app/server.js` does (loading `.env` first when dotenv is
 * installed).
 *
 * Startup order (fail fast, nothing listens before the database and the
 * master key are known good):
 *   validate env → load Access signing keys → open DB →
 *   backup before a delivery-store upgrade → init SQLiteDeliveryStore →
 *   app migrations (backup first) → vault key check → create runtime →
 *   seed `telegram-main` (paused) → listen → start the runtime (lease).
 * Listening before the lease keeps `/healthz` alive while a previous
 * instance's lease expires.
 *
 * Shutdown (SIGTERM/SIGINT or `close()`): stop the runtime (no new runs or
 * ticks; waits up to `SHUTDOWN_WAIT_SECONDS` for the run in flight) → end
 * event streams and close the HTTP server → wait, without a limit, until
 * nothing is in flight (the lease stays renewed meanwhile, then is released)
 * → close the database. A run is never cut short and the database is never
 * closed under it: past the wait the process keeps running until the run has
 * committed, then exits on its own (no `process.exit()`). The container stop
 * grace period must exceed the wait by at least 15 seconds; a kill in the
 * middle of a send leaves that output to be reconciled as ambiguous.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

import { sanitizeRuntimeError } from '../channels/runner.js';
import { FileCache } from '../core/caches.js';
import { SQLiteDeliveryStore } from '../core/sqlite-delivery-store.js';
import { createAccessKeySet, createAccessVerifier, warmUpAccessKeySet } from './auth/access-jwt.js';
import { createRoleResolver } from './auth/roles.js';
import { AppConfigError, STOP_GRACE_MARGIN_SECONDS, loadAppConfig } from './config/env.js';
import { createApp } from './create-app.js';
import { backupBeforeDeliveryStoreUpgrade, runAppMigrations } from './db/app-migrations.js';
import { createNodeSqlStorage } from './db/node-sql-storage.js';
import { closeDatabase, openDatabase } from './db/open-database.js';
import { createRuntime } from './runtime/create-runtime.js';
import { SecretVault, VaultKeyError } from './secrets/vault.js';

/** Time open connections get to finish after the server stops accepting new ones. */
export const SERVER_CLOSE_GRACE_MS = 5_000;

/**
 * Least time each address of a host gets to accept a connection before Node
 * moves on to the next one (`autoSelectFamily`). Node's 250 ms default is
 * shorter than the TCP handshake from the VPS to api.telegram.org (about
 * 260 ms): the attempt was cut short, the IPv6 address that came next failed
 * at once in a container without IPv6, and every send ended in `fetch failed`
 * (ETIMEDOUT) although Telegram was reachable.
 */
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 2_500;

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);
const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

/**
 * @typedef {object} AppServer
 * @property {import('express').Express} app
 * @property {import('node:http').Server} server
 * @property {import('./runtime/create-runtime.js').ContentRadarRuntime} runtime
 * @property {Readonly<import('./config/env.js').AppConfig>} config
 * @property {string} url Base URL the server listens on (actual port).
 * @property {string} version
 * @property {() => Promise<void>} close Idempotent graceful shutdown.
 */

/**
 * Start the app. Dependencies are injection points for tests and E2E; the
 * production process passes none.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{
 *   logger?: Pick<Console, 'log'|'warn'|'error'>,
 *   clock?: () => Date,
 *   keySet?: import('jose').JWTVerifyGetKey,
 *   channelFactories?: object,
 *   cron?: { schedule: Function },
 *   timers?: object,
 *   createCache?: (config: Readonly<import('./config/env.js').AppConfig>, context: { clock: () => Date }) => import('../core/contracts.js').CachePlugin,
 *   ownerId?: string,
 *   leaseTtlMs?: number,
 *   heartbeatMs?: number,
 *   shutdownTimeoutMs?: number,
 *   webDir?: string,
 *   sseHeartbeatMs?: number,
 *   serverCloseGraceMs?: number,
 *   process?: Pick<NodeJS.Process, 'once'|'off'>|null,
 * }} [dependencies]
 *   - `keySet`: Access key resolver replacing the configured JWKS source.
 *   - `channelFactories`: plugin constructors for sources, AI, and output.
 *   - `cron`/`timers`/`clock`: scheduler clock and timer seams.
 *   - `shutdownTimeoutMs`: overrides `SHUTDOWN_WAIT_SECONDS`.
 *   - `process`: where SIGTERM/SIGINT handlers are registered; `null` registers none.
 * @returns {Promise<AppServer>}
 */
export async function startServer(env = process.env, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const clock = dependencies.clock ?? (() => new Date());
  const signals = dependencies.process === undefined ? process : dependencies.process;

  const config = loadAppConfig(env);
  const shutdownWaitMs = dependencies.shutdownTimeoutMs ?? config.shutdownWaitMs;
  const version = config.buildVersion ?? await readPackageVersion();
  const keySet = dependencies.keySet ?? await createAccessKeySet(config.access);
  const verifier = createAccessVerifier({
    issuer: config.access.issuer,
    audience: config.access.audience,
    keySet,
    clock,
  });
  const roles = createRoleResolver(config.roles);

  let db = null;
  let runtime = null;
  let server = null;
  let closeEventStreams = () => {};
  let app;
  try {
    db = openDatabase({ dataDir: config.dataDir });
    const deliveryBackup = await backupBeforeDeliveryStoreUpgrade({ db, dataDir: config.dataDir, now: clock() });
    if (deliveryBackup.backupPath) logger.log?.(`[App] Backed up the database before the delivery store upgrade: ${deliveryBackup.backupPath}`);
    const storage = createNodeSqlStorage(db);
    const deliveryStore = new SQLiteDeliveryStore(storage);
    await deliveryStore.initialize();
    const migration = runAppMigrations({ db, dataDir: config.dataDir, now: clock() });
    if (migration.applied.length > 0) {
      logger.log?.(`[App] Applied app schema migrations v${migration.fromVersion} → v${migration.toVersion}${migration.backupPath ? ` (backup: ${migration.backupPath})` : ''}`);
    }
    const vault = new SecretVault({ storage, masterKey: config.masterKey, clock });
    vault.initialize();

    const cache = (dependencies.createCache ?? createFileCache)(config, { clock });
    runtime = await createRuntime({
      db,
      dataDir: config.dataDir,
      vault,
      deliveryStore,
      cache,
      cron: dependencies.cron,
      clock,
      logger,
      ownerId: dependencies.ownerId,
      channelFactories: dependencies.channelFactories,
      timers: dependencies.timers,
      leaseTtlMs: dependencies.leaseTtlMs,
      heartbeatMs: dependencies.heartbeatMs,
      shutdownTimeoutMs: shutdownWaitMs,
      contentScanRetentionDays: config.retention.contentScanDays,
      runHistoryRetentionDays: config.retention.runHistoryDays,
      alertChatId: config.alertChatId,
    });
    const seed = await runtime.seedDefaultChannels();
    if (seed.seeded) logger.log?.(`[App] Seeded ${seed.channelIds.join(', ')} (paused until an operator resumes it)`);

    ({ app, closeEventStreams } = createApp({
      runtime,
      verifier,
      roles,
      publicOrigin: config.publicOrigin,
      version,
      webDir: dependencies.webDir,
      logger,
      clock,
      sseHeartbeatMs: dependencies.sseHeartbeatMs,
    }));
    server = await listen(app, config.host, config.port);
    // Not awaited: startup must not depend on reaching Cloudflare.
    warmUpAccessKeySet(keySet, { logger }).catch(() => {});
    const { leased } = await runtime.start();
    logger.log?.(`[App] Listening on ${baseUrl(server)} (public origin ${config.publicOrigin}; Access keys from ${config.access.jwksFile ? 'the local ACCESS_JWKS_FILE' : config.access.certsUrl})`);
    logger.log?.(`[App] On SIGTERM a run in flight is awaited (shutdown wait ${describeSeconds(shutdownWaitMs)}, SHUTDOWN_WAIT_SECONDS); give the container a stop grace period of at least ${describeSeconds(shutdownWaitMs + STOP_GRACE_MARGIN_SECONDS * 1_000)}`);
    if (!leased) logger.log?.('[App] Another instance holds the runtime lease; scheduling starts once it expires or is released');
  } catch (error) {
    await shutdown({ runtime, server, closeEventStreams, db, logger, graceMs: 0, shutdownWaitMs });
    throw error;
  }

  let closing = null;
  const onSignal = signal => {
    logger.log?.(`[App] ${signal} received; shutting down`);
    close().catch(error => logger.error?.(`[App] Shutdown failed: ${sanitizeRuntimeError(error)}`));
  };
  function close() {
    if (!closing) {
      for (const signal of SHUTDOWN_SIGNALS) signals?.off?.(signal, onSignal);
      closing = shutdown({
        runtime,
        server,
        closeEventStreams,
        db,
        logger,
        graceMs: dependencies.serverCloseGraceMs ?? SERVER_CLOSE_GRACE_MS,
        shutdownWaitMs,
      });
    }
    return closing;
  }
  for (const signal of SHUTDOWN_SIGNALS) signals?.once?.(signal, onSignal);

  return Object.freeze({ app, server, runtime, config, url: baseUrl(server), version, close });
}

/**
 * Raise the process-wide per-address connection attempt timeout, which every
 * outbound connection uses (fetch included), to at least
 * {@link MIN_CONNECT_ATTEMPT_TIMEOUT_MS}. A larger value set with
 * `--network-family-autoselection-attempt-timeout` is kept.
 * @param {Pick<typeof net, 'getDefaultAutoSelectFamilyAttemptTimeout'|'setDefaultAutoSelectFamilyAttemptTimeout'>} [netApi]
 * @returns {number} The timeout in effect, in milliseconds.
 */
export function raiseConnectAttemptTimeout(netApi = net) {
  if (netApi.getDefaultAutoSelectFamilyAttemptTimeout() < MIN_CONNECT_ATTEMPT_TIMEOUT_MS) {
    netApi.setDefaultAutoSelectFamilyAttemptTimeout(MIN_CONNECT_ATTEMPT_TIMEOUT_MS);
  }
  return netApi.getDefaultAutoSelectFamilyAttemptTimeout();
}

/**
 * Describe a startup failure for the console without leaking values.
 * @param {unknown} error
 * @returns {string}
 */
export function describeStartupError(error) {
  if (error instanceof AppConfigError || error instanceof VaultKeyError) return error.message;
  return sanitizeRuntimeError(error);
}

function createFileCache(config, { clock }) {
  return new FileCache(config.cachePath, { now: () => clock().getTime() });
}

async function shutdown({ runtime, server, closeEventStreams, db, logger, graceMs, shutdownWaitMs }) {
  const failures = [];
  let overran = false;
  if (runtime) {
    try {
      ({ timedOut: overran } = await runtime.stop());
      if (overran) {
        logger.warn?.(`[App] A run is still in flight after the ${describeSeconds(shutdownWaitMs)} shutdown wait. `
          + 'The database, cache, and runtime lease stay open until it finishes, then the process exits. '
          + 'Killing the process before then (or sending the signal again) leaves an output being sent to be reconciled as ambiguous on the next start.');
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    closeEventStreams();
    await closeServer(server, graceMs);
  } catch (error) {
    failures.push(error);
  }
  // Never close the database under a run that still has to commit.
  let drained = true;
  if (runtime) {
    try {
      await runtime.drain();
      if (overran) logger.log?.('[App] The run in flight has finished; closing the database');
    } catch (error) {
      drained = false;
      failures.push(error);
    }
  }
  if (drained) {
    try {
      closeDatabase(db);
    } catch (error) {
      failures.push(error);
    }
  } else {
    logger.error?.('[App] Left the database open: work in flight could not be confirmed finished');
  }
  if (failures.length > 0) {
    logger.error?.(`[App] Shutdown problems: ${failures.map(error => sanitizeRuntimeError(error)).join('; ')}`);
  }
}

function describeSeconds(ms) {
  return `${Math.ceil(ms / 1_000)} s`;
}

function listen(app, host, port) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server, graceMs) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    force.unref?.();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function baseUrl(server) {
  const address = server.address();
  if (!address || typeof address === 'string') return String(address ?? '');
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function readPackageVersion() {
  try {
    const { version } = JSON.parse(await readFile(PACKAGE_JSON_URL, 'utf8'));
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
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

const isExecutable = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isExecutable) {
  await loadEnvironment();
  raiseConnectAttemptTimeout();
  try {
    await startServer();
  } catch (error) {
    console.error(`[App] Startup failed: ${describeStartupError(error)}`);
    process.exitCode = 1;
  }
}
