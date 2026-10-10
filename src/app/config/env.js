/**
 * Environment configuration of the app server (`src/app/server.js`).
 *
 * `loadAppConfig()` validates every variable once at startup and fails fast
 * with one `AppConfigError` listing every problem. Messages name variables and
 * rules only: they never echo a configured value, so secrets cannot leak into
 * logs through a configuration mistake.
 *
 * There is no authentication bypass. The Cloudflare Access JWT is always
 * verified (signature, issuer, audience, expiry); `ACCESS_JWKS_FILE` only
 * changes where the signing keys come from, for development and tests, and is
 * accepted only when `NODE_ENV` is exactly `development` or `test` (an unset,
 * misspelled, or production `NODE_ENV` refuses to start).
 *
 * `SHUTDOWN_WAIT_SECONDS` (default 120) is how long SIGTERM/SIGINT waits for a
 * channel run in flight before closing the HTTP server. A run is never cut
 * short: the database stays open until it finishes. Set the container stop
 * grace period to at least this value plus 15 seconds so the platform does not
 * kill the process in the middle of a send.
 */

import { join, resolve } from 'node:path';

import { DEV_ACCESS_ISSUER } from '../auth/access-jwt.js';
import { ACCESS_ROLES } from '../auth/roles.js';
import { CACHE_FILE_NAME } from '../runtime/create-runtime.js';
import {
  DEFAULT_CONTENT_SCAN_RETENTION_DAYS,
  DEFAULT_RUN_HISTORY_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from '../runtime/retention.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../runtime/scheduler.js';
import { VaultKeyError, parseMasterKey } from '../secrets/vault.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
/** Path of the Access signing keys under the team domain. */
export const ACCESS_CERTS_PATH = '/cdn-cgi/access/certs';
/** The only `NODE_ENV` values under which local Access signing keys (`ACCESS_JWKS_FILE`) are accepted. */
export const LOCAL_ACCESS_KEY_ENVIRONMENTS = Object.freeze(['development', 'test']);
export const DEFAULT_SHUTDOWN_WAIT_SECONDS = DEFAULT_SHUTDOWN_TIMEOUT_MS / 1_000;
export const MAX_SHUTDOWN_WAIT_SECONDS = 3_600;
/** Margin the container stop grace period needs above the shutdown wait (closing the server and the database). */
export const STOP_GRACE_MARGIN_SECONDS = 15;

const MAX_LIST_ENTRIES = 200;
const MAX_AUDIENCE_ENTRIES = 20;
const MAX_EMAIL_LENGTH = 320;
const MAX_TOKEN_ID_LENGTH = 200;
const MAX_HOST_LENGTH = 255;
const MAX_VERSION_LENGTH = 100;
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9.:_-]+$/;
const ALERT_CHAT_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** One or more environment variables are missing or invalid. */
export class AppConfigError extends Error {
  /** @param {string[]} problems One sentence per problem; never contains values. */
  constructor(problems) {
    super(`Invalid app configuration: ${problems.join(' ')}`);
    this.name = 'AppConfigError';
    this.code = 'app_config_invalid';
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * @typedef {object} AccessConfig
 * @property {string} teamDomain Origin of the Access team, e.g. `https://team.cloudflareaccess.com`.
 * @property {string} issuer Expected `iss` claim (the team domain).
 * @property {string[]} audience Accepted Access application AUD tags.
 * @property {string} certsUrl Remote JWKS used in production.
 * @property {string|null} jwksFile Local JWKS (development and tests only).
 */

/**
 * @typedef {object} RoleConfig
 * @property {string[]} operatorEmails Lowercase.
 * @property {string[]} viewerEmails Lowercase.
 * @property {{ clientId: string, role: 'viewer'|'operator' }[]} serviceTokens
 */

/**
 * @typedef {object} AppConfig
 * @property {string|null} nodeEnv
 * @property {boolean} production
 * @property {string} host
 * @property {number} port `0` lets the OS pick a free port (tests).
 * @property {string} dataDir Absolute.
 * @property {string} cachePath Absolute path of the persistent file cache.
 * @property {string} publicOrigin Exact origin mutations must come from.
 * @property {AccessConfig} access
 * @property {RoleConfig} roles
 * @property {{ contentScanDays: number, runHistoryDays: number }} retention
 * @property {number} shutdownWaitMs `SHUTDOWN_WAIT_SECONDS` in milliseconds.
 * @property {string|null} buildVersion `NEWS_BUILD_VERSION`.
 * @property {string} masterKey Non-enumerable: hidden from JSON and `util.inspect`.
 */

/**
 * Validate the app environment.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<AppConfig>} Deeply frozen.
 * @throws {AppConfigError}
 */
export function loadAppConfig(env = process.env) {
  const problems = [];
  const read = name => {
    const value = env?.[name];
    if (value === undefined || value === null) return '';
    return String(value).trim();
  };

  const nodeEnv = read('NODE_ENV') || null;
  const production = nodeEnv === 'production';
  // An explicit allowlist: anything else, including an unset NODE_ENV, counts as a deployment.
  const localAccessKeysAllowed = LOCAL_ACCESS_KEY_ENVIRONMENTS.includes(nodeEnv);

  const host = readHost(read('HOST'), problems);
  const port = readPort(read('PORT'), problems);
  const dataDir = readRequiredPath(read('DATA_DIR'), 'DATA_DIR', problems,
    'DATA_DIR is required: the directory that holds content-radar.db (for example /data in Docker).');
  const cachePath = read('CACHE_PATH')
    ? resolve(read('CACHE_PATH'))
    : (dataDir ? join(dataDir, CACHE_FILE_NAME) : null);
  const cacheType = read('CACHE_TYPE').toLowerCase();
  if (cacheType && cacheType !== 'file') {
    problems.push('CACHE_TYPE must be "file" or unset: the app keeps a persistent file cache at CACHE_PATH, and memory or redis caches are not allowed on output paths.');
  }

  const masterKey = read('APP_MASTER_KEY');
  try {
    parseMasterKey(masterKey);
  } catch (error) {
    if (!(error instanceof VaultKeyError)) throw error;
    problems.push(`${error.message}.`);
  }

  const jwksFile = read('ACCESS_JWKS_FILE') || null;
  if (jwksFile && !localAccessKeysAllowed) {
    problems.push('ACCESS_JWKS_FILE (local development signing keys) is accepted only when NODE_ENV is exactly "development" or "test"; set NODE_ENV=development for a local run, or remove ACCESS_JWKS_FILE and set ACCESS_TEAM_DOMAIN so tokens are verified against the Cloudflare Access team keys.');
  }
  // Development keys (ACCESS_JWKS_FILE) default to the dev issuer; the issuer is still verified.
  const teamDomain = readHttpsOrigin(read('ACCESS_TEAM_DOMAIN') || (jwksFile && localAccessKeysAllowed ? DEV_ACCESS_ISSUER : ''), problems);
  const audience = readAudience(read('ACCESS_AUD'), problems);

  const operatorEmails = readEmails(read('APP_OPERATOR_EMAILS'), 'APP_OPERATOR_EMAILS', problems);
  const viewerEmails = readEmails(read('APP_VIEWER_EMAILS'), 'APP_VIEWER_EMAILS', problems);
  const serviceTokens = readServiceTokenRoles(read('APP_SERVICE_TOKEN_ROLES'), problems);
  if (operatorEmails.length === 0 && viewerEmails.length === 0 && serviceTokens.length === 0) {
    problems.push('Map at least one identity with APP_OPERATOR_EMAILS, APP_VIEWER_EMAILS, or APP_SERVICE_TOKEN_ROLES; otherwise nobody can use the dashboard.');
  }

  const publicOrigin = readPublicOrigin(read('PUBLIC_ORIGIN'), problems);
  const contentScanDays = readDays(read('CONTENT_SCAN_RETENTION_DAYS'), 'CONTENT_SCAN_RETENTION_DAYS',
    DEFAULT_CONTENT_SCAN_RETENTION_DAYS, problems);
  const runHistoryDays = readDays(read('RUN_HISTORY_RETENTION_DAYS'), 'RUN_HISTORY_RETENTION_DAYS',
    DEFAULT_RUN_HISTORY_RETENTION_DAYS, problems);
  const shutdownWaitSeconds = readShutdownWait(read('SHUTDOWN_WAIT_SECONDS'), problems);
  const alertChatId = readAlertChatId(read('ALERT_TELEGRAM_CHAT_ID'), problems);

  const buildVersion = read('NEWS_BUILD_VERSION') || null;
  if (buildVersion && (buildVersion.length > MAX_VERSION_LENGTH || !VISIBLE_ASCII.test(buildVersion))) {
    problems.push(`NEWS_BUILD_VERSION must be at most ${MAX_VERSION_LENGTH} visible ASCII characters.`);
  }

  if (problems.length > 0) throw new AppConfigError(problems);

  const config = {
    nodeEnv,
    production,
    host,
    port,
    dataDir,
    cachePath,
    publicOrigin,
    access: {
      teamDomain,
      issuer: teamDomain,
      audience,
      certsUrl: `${teamDomain}${ACCESS_CERTS_PATH}`,
      jwksFile: jwksFile ? resolve(jwksFile) : null,
    },
    roles: { operatorEmails, viewerEmails, serviceTokens },
    retention: { contentScanDays, runHistoryDays },
    shutdownWaitMs: shutdownWaitSeconds * 1_000,
    alertChatId,
    buildVersion,
  };
  // Kept off the enumerable surface so logging or serializing the config never prints the key.
  Object.defineProperty(config, 'masterKey', { value: masterKey, enumerable: false });
  return deepFreeze(config);
}

function readHost(value, problems) {
  if (!value) return DEFAULT_HOST;
  if (value.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(value)) {
    problems.push('HOST must be a hostname or IP address, for example 127.0.0.1 or 0.0.0.0.');
    return DEFAULT_HOST;
  }
  return value;
}

function readPort(value, problems) {
  if (!value) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    problems.push('PORT must be an integer between 0 and 65535.');
    return DEFAULT_PORT;
  }
  return Number(value);
}

function readRequiredPath(value, name, problems, message) {
  if (!value) {
    problems.push(message);
    return null;
  }
  if (/[\u0000-\u001f]/.test(value)) {
    problems.push(`${name} must be a filesystem path without control characters.`);
    return null;
  }
  return resolve(value);
}

function readHttpsOrigin(value, problems) {
  const message = 'ACCESS_TEAM_DOMAIN must be the https origin of the Cloudflare Access team, for example https://<team>.cloudflareaccess.com; it is required unless ACCESS_JWKS_FILE is used with NODE_ENV=development or test.';
  const origin = parseOrigin(value, ['https:']);
  if (!origin) problems.push(message);
  return origin;
}

function readPublicOrigin(value, problems) {
  const origin = parseOrigin(value, ['https:', 'http:']);
  if (!origin) {
    problems.push('PUBLIC_ORIGIN is required and must be the exact http(s) origin the dashboard is served from, without a path, for example https://radar.example.com.');
  }
  return origin;
}

// An origin with an optional trailing slash: no credentials, path, query, or fragment.
function parseOrigin(value, protocols) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  if (value.includes('?') || value.includes('#')) return null;
  return url.origin;
}

function readAudience(value, problems) {
  const entries = splitList(value);
  if (entries.length === 0) {
    problems.push('ACCESS_AUD is required: a comma-separated list of Access application AUD tags.');
    return [];
  }
  if (entries.length > MAX_AUDIENCE_ENTRIES) {
    problems.push(`ACCESS_AUD accepts at most ${MAX_AUDIENCE_ENTRIES} AUD tags.`);
    return [];
  }
  if (entries.some(entry => entry.length > MAX_TOKEN_ID_LENGTH || !VISIBLE_ASCII.test(entry))) {
    problems.push(`Every ACCESS_AUD tag must be 1-${MAX_TOKEN_ID_LENGTH} visible ASCII characters.`);
    return [];
  }
  return [...new Set(entries)];
}

function readEmails(value, name, problems) {
  const entries = splitList(value).map(entry => entry.toLowerCase());
  if (entries.length > MAX_LIST_ENTRIES) {
    problems.push(`${name} accepts at most ${MAX_LIST_ENTRIES} email addresses.`);
    return [];
  }
  const invalid = entries.findIndex(entry => entry.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(entry));
  if (invalid !== -1) {
    problems.push(`${name} entry #${invalid + 1} is not an email address; use a comma-separated list such as ops@example.com,lead@example.com.`);
    return [];
  }
  return [...new Set(entries)];
}

function readServiceTokenRoles(value, problems) {
  const entries = splitList(value);
  if (entries.length > MAX_LIST_ENTRIES) {
    problems.push(`APP_SERVICE_TOKEN_ROLES accepts at most ${MAX_LIST_ENTRIES} entries.`);
    return [];
  }
  const roles = new Map();
  for (const [index, entry] of entries.entries()) {
    const parts = entry.split(':').map(part => part.trim());
    const [clientId, role] = parts;
    if (parts.length !== 2 || !clientId || clientId.length > MAX_TOKEN_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)
      || !ACCESS_ROLES.includes(role)) {
      problems.push(`APP_SERVICE_TOKEN_ROLES entry #${index + 1} must look like <client-id>:operator or <client-id>:viewer.`);
      return [];
    }
    if (roles.has(clientId) && roles.get(clientId) !== role) {
      problems.push(`APP_SERVICE_TOKEN_ROLES entry #${index + 1} maps a client id that already has a different role.`);
      return [];
    }
    roles.set(clientId, role);
  }
  return [...roles].map(([clientId, role]) => ({ clientId, role }));
}

function readDays(value, name, defaultValue, problems) {
  if (!value) return defaultValue;
  const days = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
    problems.push(`${name} must be an integer number of days between 1 and ${MAX_RETENTION_DAYS}.`);
    return defaultValue;
  }
  return days;
}

function readShutdownWait(value, problems) {
  if (!value) return DEFAULT_SHUTDOWN_WAIT_SECONDS;
  const seconds = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SHUTDOWN_WAIT_SECONDS) {
    problems.push(`SHUTDOWN_WAIT_SECONDS must be an integer number of seconds between 1 and ${MAX_SHUTDOWN_WAIT_SECONDS}.`);
    return DEFAULT_SHUTDOWN_WAIT_SECONDS;
  }
  return seconds;
}

function readAlertChatId(value, problems) {
  if (!value) return null;
  if (!ALERT_CHAT_PATTERN.test(value)) {
    problems.push('ALERT_TELEGRAM_CHAT_ID must be a numeric Telegram chat id or an @username.');
    return null;
  }
  return value;
}

function splitList(value) {
  if (!value) return [];
  return value.split(',').map(entry => entry.trim()).filter(Boolean);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
}
