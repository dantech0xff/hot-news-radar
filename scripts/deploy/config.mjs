/**
 * Configuration of the Dokploy + Cloudflare deploy script: fixed resource
 * names, the production environment contract of the app container, and
 * validation of the operator's environment variables and flags.
 *
 * Problems name variables and rules only, never values: secrets reach the
 * script through the environment and must never be echoed. Secret settings
 * and the origin address are non-enumerable on the returned config so
 * serializing it cannot leak them.
 */

import { isIPv4 } from 'node:net';

/** Names the script looks resources up by on every run. */
export const NAMES = Object.freeze({
  project: 'content-radar',
  environment: 'production',
  app: 'content-radar',
  volume: 'content-radar-data',
  accessApp: 'Content Radar',
  allowPolicy: 'content-radar-users',
  servicePolicy: 'content-radar-agent-service-token',
  otpProvider: 'One-time PIN',
});

export const DEFAULTS = Object.freeze({
  gitUrl: 'https://github.com/dantech0xff/hot-news-radar.git',
  gitBranch: 'master',
  waitMinutes: 30,
});

/** `deployment.readLogs` (used when a deployment fails) arrived in v0.29.5. */
export const MIN_DOKPLOY_VERSION = Object.freeze([0, 29, 5]);
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const APP_PORT = 3000;
export const DATA_MOUNT_PATH = '/data';
/** Mirrors `DEFAULT_SHUTDOWN_WAIT_SECONDS` / `STOP_GRACE_MARGIN_SECONDS` in `src/app/config/env.js`. */
export const SHUTDOWN_WAIT_SECONDS = 120;
export const STOP_GRACE_MARGIN_SECONDS = 15;
export const STOP_GRACE_SECONDS = SHUTDOWN_WAIT_SECONDS + STOP_GRACE_MARGIN_SECONDS;
/** Docker Swarm durations are nanoseconds. */
export const NANOSECONDS_PER_SECOND = 1_000_000_000;

/** One task at a time and the old task stops first: never two schedulers on one SQLite file. */
export const SWARM_UPDATE_CONFIG = Object.freeze({ Parallelism: 1, Order: 'stop-first' });
/** Same probe as the Dockerfile HEALTHCHECK: `/healthz` is the only route served without an Access token. */
export const SWARM_HEALTHCHECK = Object.freeze({
  Test: Object.freeze([
    'CMD', 'node', '-e',
    `fetch('http://127.0.0.1:${APP_PORT}/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
  ]),
  Interval: 30 * NANOSECONDS_PER_SECOND,
  Timeout: 5 * NANOSECONDS_PER_SECOND,
  StartPeriod: 30 * NANOSECONDS_PER_SECOND,
  Retries: 3,
});
/**
 * The app's Dokploy domain (its Traefik route) for APP_HOSTNAME, besides the
 * host itself. Cloudflare's proxy terminates the public TLS and connects to
 * the VPS over HTTPS; Traefik answers with its default certificate there (a
 * Cloudflare Origin CA certificate), so the domain asks for none.
 */
export const TRAEFIK_DOMAIN = Object.freeze({
  path: '/',
  port: APP_PORT,
  https: true,
  certificateType: 'none',
  domainType: 'application',
  stripPath: false,
});

/** Environment keys whose values are not secret and may be shown in a dry run. */
export const PUBLIC_ENV_KEYS = Object.freeze(new Set([
  'NODE_ENV', 'HOST', 'PORT', 'DATA_DIR', 'CACHE_PATH', 'PUBLIC_ORIGIN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD',
  'APP_OPERATOR_EMAILS', 'APP_VIEWER_EMAILS',
  'SHUTDOWN_WAIT_SECONDS', 'CONTENT_SCAN_RETENTION_DAYS', 'RUN_HISTORY_RETENTION_DAYS', 'NEWS_BUILD_VERSION',
]));

export const COMMANDS = Object.freeze(['preflight', 'deploy', 'verify']);

/**
 * Where the app's code comes from (`DOKPLOY_SOURCE`): `git` pulls the public
 * `--git-url` whenever the script deploys (no webhook, so a push alone
 * deploys nothing); `github` uses the Dokploy GitHub App provider, whose push
 * webhook deploys every push to `--git-branch`.
 */
export const SOURCES = Object.freeze(['git', 'github']);

const DEPLOY_VARIABLES = Object.freeze([
  'DOKPLOY_URL', 'DOKPLOY_API_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID',
  'APP_HOSTNAME', 'APP_OPERATOR_EMAILS', 'CF_ACCESS_CLIENT_ID', 'ORIGIN_IP',
]);
// Verify reads the DNS record too; `--origin-ip` stands in for ORIGIN_IP.
const VERIFY_VARIABLES = Object.freeze([
  'DOKPLOY_URL', 'DOKPLOY_API_KEY', 'CF_API_TOKEN', 'CF_ZONE_ID', 'APP_HOSTNAME', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET',
]);
/** Flags each command accepts (besides --help). */
const COMMAND_FLAGS = Object.freeze({
  preflight: Object.freeze([]),
  deploy: Object.freeze(['dry-run', 'git-url', 'git-branch', 'wait-minutes']),
  verify: Object.freeze(['redeploy-check', 'origin-ip', 'wait-minutes']),
});

const MAX_EMAILS = 200;
const MAX_EMAIL_LENGTH = 320;
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
// Characters that would change the meaning of an unquoted dotenv value.
const DOTENV_UNSAFE = /[\s#"'`\\]/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/i;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GIT_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const PROVIDER_NAME = /^[^\x00-\x1f\x7f]{1,200}$/;

/**
 * @typedef {object} DeployConfig
 * @property {'preflight'|'deploy'|'verify'} command
 * @property {boolean} dryRun
 * @property {boolean} redeployCheck
 * @property {{ url: string, apiKey: string, behindAccess: boolean }} dokploy `apiKey` is non-enumerable;
 *   `behindAccess` (from `DOKPLOY_BEHIND_ACCESS`) sends the Access service-token headers to the Dokploy API.
 * @property {{ apiToken: string, accountId: string, zoneId: string }} cloudflare `apiToken` is non-enumerable.
 * @property {string} hostname Lowercase FQDN: Cloudflare Access in front, Traefik on the VPS behind.
 * @property {string} originIp IPv4 address of the VPS (`ORIGIN_IP`; for verify, `--origin-ip` wins):
 *   the content of the hostname's proxied A record and the address the origin checks probe.
 *   Non-enumerable, and never printed.
 * @property {string[]} operatorEmails Lowercase, unique.
 * @property {string[]} viewerEmails Lowercase, unique.
 * @property {{ clientId: string, clientSecret: string }} serviceToken `clientSecret` is non-enumerable.
 * @property {{
 *   url: string, branch: string, source: 'git'|'github',
 *   githubProvider: string|null, owner: string|null, repository: string|null,
 * }} git `source` is `DOKPLOY_SOURCE` (see `SOURCES`). With `github`: `githubProvider` is
 *   `DOKPLOY_GITHUB_PROVIDER` (`null`: use the only provider), and `owner`/`repository` are read
 *   from the GitHub `url`; all three are `null` with `git`.
 * @property {number} waitMs How long to wait for one Dokploy build/deployment.
 */

/**
 * Validate the environment and flags for one command.
 * @param {Record<string, string|undefined>} env
 * @param {{ command: string, flags: Record<string, string|boolean|undefined> }} cli
 * @returns {{ config: DeployConfig|null, problems: string[], warnings: string[] }}
 */
export function readDeployConfig(env, { command, flags = {} }) {
  const problems = [];
  const warnings = [];
  if (!COMMANDS.includes(command)) {
    return { config: null, problems: [`Unknown command; use one of: ${COMMANDS.join(', ')}.`], warnings };
  }
  for (const flag of Object.keys(flags)) {
    if (flags[flag] !== undefined && flag !== 'help' && !COMMAND_FLAGS[command].includes(flag)) {
      problems.push(`--${flag} is not an option of the ${command} command.`);
    }
  }

  const read = name => {
    const value = env?.[name];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  // Only verify takes --origin-ip (any other command already reported it above).
  const originIpFlag = command === 'verify' ? stringFlag(flags['origin-ip']) : undefined;
  const required = command !== 'verify' ? DEPLOY_VARIABLES
    : [...VERIFY_VARIABLES, ...(originIpFlag === undefined ? ['ORIGIN_IP'] : [])];
  const missing = required.filter(name => read(name) === '');
  if (missing.length > 0) problems.push(`Missing environment variables: ${missing.join(', ')}.`);
  const dokployBehindAccess = readBooleanFlag(read('DOKPLOY_BEHIND_ACCESS'), 'DOKPLOY_BEHIND_ACCESS', problems);
  if (dokployBehindAccess && read('CF_ACCESS_CLIENT_SECRET') === '') {
    problems.push('DOKPLOY_BEHIND_ACCESS=true needs CF_ACCESS_CLIENT_SECRET: the Dokploy API is reached through Cloudflare Access with the CF_ACCESS_CLIENT_ID service token.');
  } else if (command !== 'verify' && read('CF_ACCESS_CLIENT_SECRET') === '') {
    warnings.push('CF_ACCESS_CLIENT_SECRET is not set: the deploy does not need it unless DOKPLOY_BEHIND_ACCESS=true, but the verify command does.');
  }
  const source = readSource(read('DOKPLOY_SOURCE'), problems);
  const githubProvider = read('DOKPLOY_GITHUB_PROVIDER') || null;
  if (githubProvider !== null && !PROVIDER_NAME.test(githubProvider)) {
    problems.push('DOKPLOY_GITHUB_PROVIDER must be the name of a Dokploy GitHub provider (at most 200 characters, no line breaks or control characters).');
  } else if (githubProvider !== null && source !== 'github') {
    warnings.push('DOKPLOY_GITHUB_PROVIDER is ignored: it applies only with DOKPLOY_SOURCE=github.');
  }

  const dokployUrl = read('DOKPLOY_URL') ? readDokployUrl(read('DOKPLOY_URL'), problems) : null;
  if (dokployUrl?.startsWith('http://') && !isLoopbackUrl(dokployUrl)) {
    warnings.push('DOKPLOY_URL uses plain http: the Dokploy API key travels unencrypted; prefer an https URL.');
  }
  const dokployApiKey = readHeaderSecret(read('DOKPLOY_API_KEY'), 'DOKPLOY_API_KEY', problems);
  const cfApiToken = readHeaderSecret(read('CF_API_TOKEN'), 'CF_API_TOKEN', problems);
  const clientSecret = readHeaderSecret(read('CF_ACCESS_CLIENT_SECRET'), 'CF_ACCESS_CLIENT_SECRET', problems);
  const accountId = readCloudflareId(read('CF_ACCOUNT_ID'), 'CF_ACCOUNT_ID', problems);
  const zoneId = readCloudflareId(read('CF_ZONE_ID'), 'CF_ZONE_ID', problems);
  const hostname = read('APP_HOSTNAME') ? readHostname(read('APP_HOSTNAME'), problems) : '';
  const originIp = readOriginIp(originIpFlag, read('ORIGIN_IP'), problems);
  const operatorEmails = readEmails(read('APP_OPERATOR_EMAILS'), 'APP_OPERATOR_EMAILS', problems);
  const viewerEmails = readEmails(read('APP_VIEWER_EMAILS'), 'APP_VIEWER_EMAILS', problems);
  const clientId = read('CF_ACCESS_CLIENT_ID');
  if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
    problems.push('CF_ACCESS_CLIENT_ID must be a service token client ID (letters, digits, ".", "_" and "-", at most 200 characters).');
  }
  if (command !== 'verify' && read('APP_OPERATOR_EMAILS') && operatorEmails.length === 0 && !problems.some(p => p.startsWith('APP_OPERATOR_EMAILS'))) {
    problems.push('APP_OPERATOR_EMAILS must list at least one email address.');
  }

  const gitUrl = readGitUrl(stringFlag(flags['git-url']) ?? DEFAULTS.gitUrl, problems);
  const githubRepository = source === 'github' ? readGithubRepository(gitUrl, problems) : null;
  const gitBranch = stringFlag(flags['git-branch']) ?? DEFAULTS.gitBranch;
  if (!GIT_BRANCH.test(gitBranch) || gitBranch.includes('..') || gitBranch.startsWith('/') || gitBranch.endsWith('/')) {
    problems.push('--git-branch must be a branch name such as master or feat/my-change.');
  }
  const waitMinutes = readWaitMinutes(stringFlag(flags['wait-minutes']), problems);

  if (problems.length > 0) return { config: null, problems, warnings };

  const config = {
    command,
    dryRun: flags['dry-run'] === true,
    redeployCheck: flags['redeploy-check'] === true,
    dokploy: { url: dokployUrl, behindAccess: dokployBehindAccess },
    cloudflare: { accountId, zoneId },
    hostname,
    operatorEmails,
    viewerEmails,
    serviceToken: { clientId },
    git: {
      url: gitUrl,
      branch: gitBranch,
      source,
      githubProvider: source === 'github' ? githubProvider : null,
      owner: githubRepository?.owner ?? null,
      repository: githubRepository?.repository ?? null,
    },
    waitMs: waitMinutes * 60_000,
  };
  Object.defineProperty(config, 'originIp', { value: originIp, enumerable: false });
  Object.defineProperty(config.dokploy, 'apiKey', { value: dokployApiKey, enumerable: false });
  Object.defineProperty(config.cloudflare, 'apiToken', { value: cfApiToken, enumerable: false });
  Object.defineProperty(config.serviceToken, 'clientSecret', { value: clientSecret, enumerable: false });
  return { config, problems, warnings };
}

/**
 * Environment the app container runs with (see `src/app/config/env.js`).
 * Every key here is owned by the deploy script; other keys already set on the
 * Dokploy application are kept.
 * @param {{
 *   masterKey: string, authDomain: string, aud: string, operatorEmails: string[],
 *   viewerEmails: string[], serviceClientId: string, hostname: string,
 * }} values
 * @returns {Record<string, string>}
 */
export function managedAppEnv({ masterKey, authDomain, aud, operatorEmails, viewerEmails, serviceClientId, hostname }) {
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(APP_PORT),
    DATA_DIR: DATA_MOUNT_PATH,
    CACHE_PATH: `${DATA_MOUNT_PATH}/news.json`,
    APP_MASTER_KEY: masterKey,
    ACCESS_TEAM_DOMAIN: `https://${authDomain}`,
    ACCESS_AUD: aud,
    APP_OPERATOR_EMAILS: operatorEmails.join(','),
    APP_VIEWER_EMAILS: viewerEmails.join(','),
    APP_SERVICE_TOKEN_ROLES: `${serviceClientId}:operator`,
    PUBLIC_ORIGIN: `https://${hostname}`,
    SHUTDOWN_WAIT_SECONDS: String(SHUTDOWN_WAIT_SECONDS),
  };
}

/**
 * Parse a `vMAJOR.MINOR.PATCH[-suffix]` version.
 * @param {unknown} value
 * @returns {number[]|null}
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number} Negative, zero, or positive.
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function stringFlag(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function readSource(value, problems) {
  const source = value === '' ? 'git' : value.toLowerCase();
  if (SOURCES.includes(source)) return source;
  problems.push('DOKPLOY_SOURCE must be git (the public Git URL, the default) or github (the Dokploy GitHub App provider).');
  return 'git';
}

function readBooleanFlag(value, name, problems) {
  if (value === '' || /^(false|0|no)$/i.test(value)) return false;
  if (/^(true|1|yes)$/i.test(value)) return true;
  problems.push(`${name} must be true or false.`);
  return false;
}

function readDokployUrl(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push('DOKPLOY_URL must be the http(s) URL of the Dokploy panel, for example https://dokploy.example.com.');
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    problems.push('DOKPLOY_URL must be an http(s) URL without credentials, query, or fragment.');
    return null;
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -'/api'.length);
  return `${url.origin}${path}`;
}

function isLoopbackUrl(value) {
  const { hostname } = new URL(value);
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

function readHeaderSecret(value, name, problems) {
  if (value && !HEADER_SAFE.test(value)) problems.push(`${name} must contain only visible ASCII characters (no spaces or line breaks).`);
  return value;
}

function readCloudflareId(value, name, problems) {
  if (value && !CLOUDFLARE_ID.test(value)) problems.push(`${name} must be a 32-character hexadecimal Cloudflare ID.`);
  return value.toLowerCase();
}

function readHostname(value, problems) {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || !labels.every(label => HOSTNAME_LABEL.test(label)) || /^\d+$/.test(labels.at(-1))) {
    problems.push('APP_HOSTNAME must be a fully qualified hostname such as radar.example.com (no scheme, port, path, or wildcard).');
    return '';
  }
  return hostname;
}

// The hostname's A record needs an IPv4 address; for verify, `--origin-ip` wins over ORIGIN_IP.
function readOriginIp(flag, value, problems) {
  if (flag !== undefined) {
    if (!isIPv4(flag)) problems.push('--origin-ip must be the IPv4 address of the VPS.');
    return flag;
  }
  if (value && !isIPv4(value)) {
    problems.push('ORIGIN_IP must be the IPv4 address of the VPS that the hostname\'s proxied A record points to.');
  }
  return value;
}

function readEmails(value, name, problems) {
  const entries = [...new Set(value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean))];
  if (entries.length > MAX_EMAILS) {
    problems.push(`${name} accepts at most ${MAX_EMAILS} email addresses.`);
    return [];
  }
  const invalid = entries.findIndex(entry => entry.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(entry) || DOTENV_UNSAFE.test(entry));
  if (invalid !== -1) {
    problems.push(`${name} entry #${invalid + 1} is not a plain email address; use a comma-separated list such as ops@example.com,lead@example.com.`);
    return [];
  }
  return entries;
}

function readGitUrl(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push('--git-url must be a public https Git URL.');
    return value;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    problems.push('--git-url must be a public https Git URL without credentials, query, or fragment.');
  }
  return url.href;
}

// The GitHub provider takes the owner and repository of `https://github.com/<owner>/<repository>[.git]`.
function readGithubRepository(href, problems) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null; // Already reported as an invalid --git-url.
  }
  const [owner = '', name = '', ...rest] = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const repository = name.replace(/\.git$/i, '');
  if (url.host !== 'github.com' || rest.length > 0 || !GITHUB_OWNER.test(owner)
    || !GITHUB_REPOSITORY.test(repository) || repository === '.' || repository === '..') {
    problems.push('DOKPLOY_SOURCE=github needs --git-url to be a GitHub repository URL such as https://github.com/<owner>/<repository>.git.');
    return null;
  }
  return { owner, repository };
}

function readWaitMinutes(value, problems) {
  if (value === undefined) return DEFAULTS.waitMinutes;
  const minutes = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) {
    problems.push('--wait-minutes must be a whole number of minutes between 1 and 240.');
    return DEFAULTS.waitMinutes;
  }
  return minutes;
}
