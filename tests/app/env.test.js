import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

import { DEV_ACCESS_ISSUER } from '../../src/app/auth/access-jwt.js';
import { AppConfigError, loadAppConfig } from '../../src/app/config/env.js';
import { MASTER_KEY } from './helpers/runtime-fixture.js';

const BASE = Object.freeze({
  DATA_DIR: '/var/lib/content-radar',
  APP_MASTER_KEY: MASTER_KEY,
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  ACCESS_AUD: 'aud-tag-1',
  APP_OPERATOR_EMAILS: 'Ops@Example.com',
  PUBLIC_ORIGIN: 'https://radar.example.com',
});

function problemsOf(env) {
  try {
    loadAppConfig(env);
  } catch (error) {
    assert.ok(error instanceof AppConfigError, `expected AppConfigError, got ${error?.name}`);
    return error;
  }
  assert.fail('expected loadAppConfig to throw');
}

test('defaults fill host, port, cache path, and retention', () => {
  const config = loadAppConfig(BASE);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.dataDir, resolve('/var/lib/content-radar'));
  assert.equal(config.cachePath, join(resolve('/var/lib/content-radar'), 'news.json'));
  assert.deepEqual(config.retention, { contentScanDays: 30, runHistoryDays: 180 });
  assert.equal(config.production, false);
  assert.equal(config.buildVersion, null);
  assert.equal(config.alertChatId, null);
  assert.deepEqual(config.access, {
    teamDomain: 'https://team.cloudflareaccess.com',
    issuer: 'https://team.cloudflareaccess.com',
    audience: ['aud-tag-1'],
    certsUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    jwksFile: null,
  });
  assert.equal(config.publicOrigin, 'https://radar.example.com');
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.access) && Object.isFrozen(config.roles.operatorEmails));
});

test('identity lists are trimmed, lowercased, de-duplicated, and service token roles are parsed', () => {
  const config = loadAppConfig({
    ...BASE,
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/',
    ACCESS_AUD: ' aud-1 , aud-2,aud-1 ',
    APP_OPERATOR_EMAILS: 'Ops@Example.com, lead@example.com ,ops@example.com',
    APP_VIEWER_EMAILS: 'Viewer@Example.com',
    APP_SERVICE_TOKEN_ROLES: 'abc123.access:operator, def456.access:viewer',
    HOST: '0.0.0.0',
    PORT: '0',
    CACHE_PATH: '/tmp/cache/news.json',
    CONTENT_SCAN_RETENTION_DAYS: '45',
    RUN_HISTORY_RETENTION_DAYS: '365',
    NEWS_BUILD_VERSION: '2.1.0+abc123',
  });
  assert.equal(config.access.teamDomain, 'https://team.cloudflareaccess.com');
  assert.deepEqual(config.access.audience, ['aud-1', 'aud-2']);
  assert.deepEqual(config.roles.operatorEmails, ['ops@example.com', 'lead@example.com']);
  assert.deepEqual(config.roles.viewerEmails, ['viewer@example.com']);
  assert.deepEqual(config.roles.serviceTokens, [
    { clientId: 'abc123.access', role: 'operator' },
    { clientId: 'def456.access', role: 'viewer' },
  ]);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 0);
  assert.equal(config.cachePath, resolve('/tmp/cache/news.json'));
  assert.deepEqual(config.retention, { contentScanDays: 45, runHistoryDays: 365 });
  assert.equal(config.buildVersion, '2.1.0+abc123');
});

test('missing required variables are all reported at once', () => {
  const error = problemsOf({});
  const text = error.problems.join('\n');
  for (const name of ['DATA_DIR', 'APP_MASTER_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'PUBLIC_ORIGIN', 'APP_OPERATOR_EMAILS']) {
    assert.match(text, new RegExp(name), name);
  }
  assert.equal(error.code, 'app_config_invalid');
});

test('invalid values are rejected without echoing them', () => {
  const secretLookingKey = 'not-a-valid-master-key-super-secret-value';
  const error = problemsOf({
    ...BASE,
    APP_MASTER_KEY: secretLookingKey,
    ACCESS_TEAM_DOMAIN: 'http://team.cloudflareaccess.com/path?x=leaky-query-value',
    PUBLIC_ORIGIN: 'https://radar.example.com/app',
    APP_OPERATOR_EMAILS: 'ops@example.com,leaky-not-an-email',
    APP_SERVICE_TOKEN_ROLES: 'leaky-client.access:admin',
    PORT: '70000',
    HOST: 'bad host',
    CONTENT_SCAN_RETENTION_DAYS: '0',
    RUN_HISTORY_RETENTION_DAYS: 'forever',
    NEWS_BUILD_VERSION: 'has spaces',
  });
  const text = error.message;
  for (const name of [
    'APP_MASTER_KEY', 'ACCESS_TEAM_DOMAIN', 'PUBLIC_ORIGIN', 'APP_OPERATOR_EMAILS entry #2', 'APP_SERVICE_TOKEN_ROLES entry #1',
    'PORT', 'HOST', 'CONTENT_SCAN_RETENTION_DAYS', 'RUN_HISTORY_RETENTION_DAYS', 'NEWS_BUILD_VERSION',
  ]) {
    assert.ok(text.includes(name), `${name} reported`);
  }
  for (const leaked of [secretLookingKey, 'leaky-query-value', 'leaky-not-an-email', 'leaky-client', 'forever', 'has spaces']) {
    assert.equal(text.includes(leaked), false, `${leaked} must not be echoed`);
  }
});

test('ACCESS_JWKS_FILE is accepted only when NODE_ENV is exactly development or test', () => {
  for (const nodeEnv of [undefined, '', 'production', 'prod', 'Production', 'staging', 'Development', 'testing']) {
    const refused = problemsOf({ ...BASE, NODE_ENV: nodeEnv, ACCESS_JWKS_FILE: '/tmp/dev-jwks.json' });
    assert.ok(refused.problems.some(problem => problem.startsWith('ACCESS_JWKS_FILE')), `NODE_ENV=${nodeEnv}`);
    assert.match(refused.message, /NODE_ENV is exactly "development" or "test"/);
  }

  for (const nodeEnv of ['development', 'test', ' test ']) {
    const local = loadAppConfig({ ...BASE, NODE_ENV: nodeEnv, ACCESS_JWKS_FILE: 'dev/jwks.json' });
    assert.equal(local.access.jwksFile, resolve('dev/jwks.json'), `NODE_ENV=${nodeEnv}`);
    assert.equal(local.access.issuer, 'https://team.cloudflareaccess.com', 'the issuer is still verified');
  }

  const production = loadAppConfig({ ...BASE, NODE_ENV: 'production' });
  assert.equal(production.production, true);
  assert.equal(production.access.jwksFile, null);
});

test('with ACCESS_JWKS_FILE under development or test the issuer defaults to the dev issuer; anywhere else the team domain is required', () => {
  const { ACCESS_TEAM_DOMAIN: _omit, ...withoutTeam } = BASE;
  for (const nodeEnv of ['development', 'test']) {
    const local = loadAppConfig({ ...withoutTeam, NODE_ENV: nodeEnv, ACCESS_JWKS_FILE: 'dev/jwks.json' });
    assert.equal(local.access.issuer, DEV_ACCESS_ISSUER);
  }
  assert.match(problemsOf(withoutTeam).message, /ACCESS_TEAM_DOMAIN/);
  for (const nodeEnv of [undefined, 'production', 'prod']) {
    const refused = problemsOf({ ...withoutTeam, NODE_ENV: nodeEnv, ACCESS_JWKS_FILE: 'dev/jwks.json' });
    assert.ok(refused.problems.some(problem => problem.startsWith('ACCESS_TEAM_DOMAIN')), `NODE_ENV=${nodeEnv}`);
    assert.ok(refused.problems.some(problem => problem.startsWith('ACCESS_JWKS_FILE')), `NODE_ENV=${nodeEnv}`);
  }
});

test('SHUTDOWN_WAIT_SECONDS defaults to 120 seconds and is bounded', () => {
  assert.equal(loadAppConfig(BASE).shutdownWaitMs, 120_000);
  assert.equal(loadAppConfig({ ...BASE, SHUTDOWN_WAIT_SECONDS: '300' }).shutdownWaitMs, 300_000);
  assert.equal(loadAppConfig({ ...BASE, SHUTDOWN_WAIT_SECONDS: '1' }).shutdownWaitMs, 1_000);
  assert.equal(loadAppConfig({ ...BASE, SHUTDOWN_WAIT_SECONDS: '3600' }).shutdownWaitMs, 3_600_000);
  for (const invalid of ['0', '3601', '1.5', '-5', 'two minutes', '120s']) {
    const error = problemsOf({ ...BASE, SHUTDOWN_WAIT_SECONDS: invalid });
    assert.ok(error.problems.some(problem => problem.startsWith('SHUTDOWN_WAIT_SECONDS')), invalid);
  }
  assert.equal(problemsOf({ ...BASE, SHUTDOWN_WAIT_SECONDS: 'two minutes' }).message.includes('two minutes'), false);
});

test('only the persistent file cache is allowed', () => {
  assert.match(problemsOf({ ...BASE, CACHE_TYPE: 'memory' }).message, /CACHE_TYPE/);
  assert.match(problemsOf({ ...BASE, CACHE_TYPE: 'redis' }).message, /not allowed on output paths/);
  assert.equal(loadAppConfig({ ...BASE, CACHE_TYPE: 'FILE' }).cachePath.endsWith('news.json'), true);
});

test('at least one identity must be mapped to a role', () => {
  const { APP_OPERATOR_EMAILS: _omit, ...withoutRoles } = BASE;
  assert.match(problemsOf(withoutRoles).message, /Map at least one identity/);
  assert.equal(loadAppConfig({ ...withoutRoles, APP_SERVICE_TOKEN_ROLES: 'agent.access:operator' }).roles.serviceTokens.length, 1);
});

test('a client id mapped to two different roles is rejected', () => {
  assert.match(problemsOf({ ...BASE, APP_SERVICE_TOKEN_ROLES: 'a.access:operator,a.access:viewer' }).message, /different role/);
});

test('the master key never appears when the config is serialized or inspected', () => {
  const config = loadAppConfig(BASE);
  assert.equal(config.masterKey, MASTER_KEY);
  assert.equal(JSON.stringify(config).includes(MASTER_KEY), false);
  assert.equal(inspect(config, { depth: 10 }).includes(MASTER_KEY), false);
  assert.equal(Object.keys(config).includes('masterKey'), false);
});

test('ALERT_TELEGRAM_CHAT_ID accepts a numeric chat id or an @username and refuses anything else without echoing it', () => {
  for (const accepted of ['123456789', '-1001234567890', '@ops_alerts']) {
    assert.equal(loadAppConfig({ ...BASE, ALERT_TELEGRAM_CHAT_ID: accepted }).alertChatId, accepted);
  }

  for (const rejected of ['ops_alerts', '@ab', '12 34', '@ops alerts', 'https://t.me/ops', '1e9']) {
    const error = problemsOf({ ...BASE, ALERT_TELEGRAM_CHAT_ID: rejected });
    assert.ok(error.problems.some(problem => problem.startsWith('ALERT_TELEGRAM_CHAT_ID must be')), rejected);
    assert.equal(error.problems.join(' ').includes(rejected), false, 'a configured value is never echoed');
  }
});
