import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvText } from '../../scripts/deploy/env-text.mjs';
import { parseMasterKey } from '../../src/app/secrets/vault.js';
import {
  FAKE,
  FAKE_SECRETS,
  appDomain,
  createFakePlatform,
  deployEnv,
  dokployOpenApi,
  isCreate,
  isMutating,
  runScript,
  seedApplication,
  seedProject,
  showsAddress,
} from './helpers/fake-platform.js';

const indexOf = (calls, predicate) => calls.findIndex(predicate);
const appIdByName = (platform, name) => [...platform.dokploy.applications.values()].find(app => app.name === name)?.applicationId;
const mainApp = platform => [...platform.dokploy.applications.values()].find(app => app.name === 'content-radar');
const dokployCalls = (calls, target) => calls.filter(call => call.service === 'dokploy' && call.target === target);
const mutations = calls => calls.filter(isMutating).map(call => call.target);
const recordView = ({ id, type, name, content, proxied }) => ({ id, type, name, content, proxied });
const DESIRED_DOMAIN = Object.freeze({ path: '/', port: 3000, https: true, certificateType: 'none', domainType: 'application', stripPath: false });
const DNS_COMMENT = 'Content Radar on Dokploy Traefik (scripts/deploy/dokploy-cloudflare.mjs)';

function assertNoSecrets(text, extra = []) {
  for (const secret of [...FAKE_SECRETS, ...extra]) {
    assert.equal(text.includes(secret), false, 'a secret value was printed or written');
  }
  assert.equal(showsAddress(text), false, 'the origin address was printed or written');
}

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'content-radar-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('deploy creates everything in a safe order, and a second run creates nothing', async () => {
  const platform = createFakePlatform();
  const first = await runScript(['deploy'], { platform });
  assert.equal(first.code, 0, first.output);

  const { calls } = first;
  const mainId = appIdByName(platform, 'content-radar');
  const accessApp = indexOf(calls, call => call.service === 'cloudflare' && call.method === 'POST' && call.target.endsWith('/access/apps'));
  const policies = calls.filter(call => call.method === 'POST' && call.target.endsWith('/access/policies'));
  const appCreate = indexOf(calls, call => call.target === 'application.create' && call.body.name === 'content-radar');
  const appDeploy = indexOf(calls, call => call.target === 'application.deploy' && call.body.applicationId === mainId);
  const domainCreate = indexOf(calls, call => call.target === 'domain.create');
  const dns = indexOf(calls, call => call.method === 'POST' && call.target.endsWith('/dns_records'));

  // (a) Access before (b) the app; the app is deployed before (c) Traefik routes the hostname to it; (d) DNS last.
  assert.equal(policies.length, 2);
  assert.ok(accessApp > -1 && accessApp < appCreate, 'the Access application exists before the Dokploy app');
  assert.ok(appDeploy > -1 && appDeploy < domainCreate, 'the app is deployed before its Traefik domain exists');
  assert.ok(domainCreate < dns, 'DNS comes after the Traefik domain');
  assert.equal(calls.findLastIndex(isMutating), dns, 'the DNS record is the last change');

  // Access: the email policy, the service token policy, both attached to the app.
  const [allow, service] = platform.cloudflare.policies;
  assert.deepEqual(allow.include, [{ email: { email: FAKE.operatorEmail } }, { email: { email: FAKE.viewerEmail } }]);
  assert.equal(allow.decision, 'allow');
  assert.deepEqual(service.include, [{ service_token: { token_id: FAKE.serviceTokenId } }]);
  assert.equal(service.decision, 'non_identity');
  const [app] = platform.cloudflare.accessApps;
  assert.equal(app.type, 'self_hosted');
  assert.deepEqual(app.destinations, [{ type: 'public', uri: FAKE.hostname }]);
  assert.deepEqual(app.policies.map(policy => policy.id), [allow.id, service.id]);
  assert.equal(platform.cloudflare.identityProviders[0].type, 'onetimepin');

  // Dokploy: source, build, volume, and one HTTPS Traefik domain for the hostname; never a published port.
  const main = platform.dokploy.applications.get(mainId);
  assert.equal(main.customGitUrl, 'https://github.com/dantech0xff/hot-news-radar.git');
  assert.equal(main.customGitBranch, 'master');
  assert.equal(main.buildType, 'dockerfile');
  assert.equal(main.dockerfile, 'Dockerfile');
  assert.equal(main.dockerContextPath, '.');
  assert.equal(main.createEnvFile, false);
  assert.deepEqual(main.mounts.map(({ type, volumeName, mountPath }) => ({ type, volumeName, mountPath })),
    [{ type: 'volume', volumeName: 'content-radar-data', mountPath: '/data' }]);
  assert.deepEqual(calls[domainCreate].body, { host: FAKE.hostname, ...DESIRED_DOMAIN, applicationId: mainId });
  assert.equal(main.domains.length, 1);
  assert.deepEqual(main.ports, []);
  assert.equal(platform.dokploy.applications.size, 1, 'one application: no connector beside the app');

  // DNS: the hostname is a proxied A record to the origin.
  assert.deepEqual(platform.cloudflare.dnsRecords.map(({ type, name, content, proxied, ttl, comment }) => ({ type, name, content, proxied, ttl, comment })),
    [{ type: 'A', name: FAKE.hostname, content: FAKE.originIp, proxied: true, ttl: 1, comment: DNS_COMMENT }]);
  assert.match(first.stdout, /\[create\] Traefik domain https:\/\/radar\.example\.test\/ → port 3000 \(certificateType none: Traefik's default certificate\)/);
  assert.match(first.stdout, /\[create\] DNS: proxied A record radar\.example\.test → <origin-ip> \(ORIGIN_IP\)/);
  assert.match(first.stdout, /Done: https:\/\/radar\.example\.test → Cloudflare Access → Traefik on the VPS → content-radar-x7k2q9:3000/);
  assertNoSecrets(first.output);

  const second = await runScript(['deploy'], { platform });
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(second.calls.filter(isCreate), [], 'a second run creates nothing');
  // Only the app itself is redeployed (to pick up new commits); nothing else changes.
  assert.deepEqual(mutations(second.calls), ['application.deploy']);
  assert.equal(second.calls.find(isMutating).body.applicationId, mainId);
  assert.match(second.stdout, /\[ok\] Traefik domain https:\/\/radar\.example\.test\/ → port 3000/);
  assert.match(second.stdout, /\[ok\] DNS: radar\.example\.test is a proxied A record to <origin-ip>\./);
  assert.equal(main.domains.length, 1);
  assert.equal(platform.cloudflare.dnsRecords.length, 1);
  assertNoSecrets(second.output);
});

test('APP_MASTER_KEY is generated once, reused afterwards, and never printed or written', async t => {
  const platform = createFakePlatform();
  const stateDir = await tempDir(t);
  const generatedBytes = Buffer.alloc(32, 7);
  const expectedKey = generatedBytes.toString('base64');
  let randomCalls = 0;
  const first = await runScript(['deploy'], {
    platform,
    stateDir,
    randomBytes: size => {
      randomCalls += 1;
      assert.equal(size, 32);
      return Buffer.from(generatedBytes);
    },
  });
  assert.equal(first.code, 0, first.output);
  assert.equal(randomCalls, 1);
  const mainId = appIdByName(platform, 'content-radar');
  const [save] = dokployCalls(first.calls, 'application.saveEnvironment').filter(call => call.body.applicationId === mainId);
  const env = parseEnvText(save.body.env).values;
  assert.equal(env.get('APP_MASTER_KEY'), expectedKey);
  assert.equal(parseMasterKey(expectedKey).length, 32);
  assert.equal(save.body.createEnvFile, false, 'the environment never lands in the build context');
  assert.deepEqual(Object.fromEntries([...env].filter(([key]) => key !== 'APP_MASTER_KEY')), {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    DATA_DIR: '/data',
    CACHE_PATH: '/data/news.json',
    ACCESS_TEAM_DOMAIN: `https://${FAKE.authDomain}`,
    ACCESS_AUD: platform.cloudflare.accessApps[0].aud,
    APP_OPERATOR_EMAILS: FAKE.operatorEmail,
    APP_VIEWER_EMAILS: FAKE.viewerEmail,
    APP_SERVICE_TOKEN_ROLES: `${FAKE.clientId}:operator`,
    PUBLIC_ORIGIN: `https://${FAKE.hostname}`,
    SHUTDOWN_WAIT_SECONDS: '120',
  });

  assert.match(first.stderr, /new APP_MASTER_KEY was generated.*password manager/);
  assertNoSecrets(first.output, [expectedKey]);
  // The state cache keeps resource IDs only: no secret, and not the address the DNS record points to.
  const state = await readFile(join(stateDir, 'state.json'), 'utf8');
  assertNoSecrets(state, [expectedKey]);
  const ids = JSON.parse(state);
  assert.equal(ids.dokploy.app.applicationId, mainId);
  assert.equal(ids.dokploy.domainId, platform.dokploy.applications.get(mainId).domains[0].domainId);
  assert.deepEqual(ids.dns, { recordId: platform.cloudflare.dnsRecords[0].id, type: 'A', proxied: true });
  assert.equal((await stat(join(stateDir, 'state.json'))).mode & 0o777, 0o600);

  // A later run with a changed viewer list rewrites the environment with the same key.
  const second = await runScript(['deploy'], {
    platform,
    stateDir,
    env: deployEnv({ APP_VIEWER_EMAILS: 'viewer@example.test,lead@example.test' }),
    randomBytes: () => assert.fail('an existing APP_MASTER_KEY must be reused'),
  });
  assert.equal(second.code, 0, second.output);
  const [resave] = dokployCalls(second.calls, 'application.saveEnvironment');
  const resaved = parseEnvText(resave.body.env).values;
  assert.equal(resaved.get('APP_MASTER_KEY'), expectedKey);
  assert.equal(resaved.get('APP_VIEWER_EMAILS'), 'viewer@example.test,lead@example.test');
  assert.match(second.stdout, /APP_MASTER_KEY is already set on the application and is reused/);
  assertNoSecrets(second.output, [expectedKey]);
});

test('an existing app keeps its master key and unmanaged variables', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  const existingKey = Buffer.alloc(32, 42).toString('base64');
  seedApplication(platform, {
    name: 'content-radar',
    appName: 'content-radar',
    environmentId,
    env: `APP_MASTER_KEY=${existingKey}\nCONTENT_SCAN_RETENTION_DAYS=60\n# comment\nNODE_ENV=development`,
  });
  const result = await runScript(['deploy'], { platform, randomBytes: () => assert.fail('must not generate a key') });
  assert.equal(result.code, 0, result.output);
  const [save] = dokployCalls(result.calls, 'application.saveEnvironment');
  const env = parseEnvText(save.body.env).values;
  assert.equal(env.get('APP_MASTER_KEY'), existingKey);
  assert.equal(env.get('CONTENT_SCAN_RETENTION_DAYS'), '60');
  assert.equal(env.get('NODE_ENV'), 'production');
  assert.match(result.stdout, /Keeping variables the deploy does not manage: CONTENT_SCAN_RETENTION_DAYS/);
  assert.deepEqual(result.calls.filter(call => call.target === 'application.create'), []);
  assertNoSecrets(result.output, [existingKey]);
});

test('an invalid existing master key stops the deploy instead of being replaced', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  seedApplication(platform, { name: 'content-radar', appName: 'content-radar', environmentId, env: 'APP_MASTER_KEY=not-a-valid-key-0123456789' });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /APP_MASTER_KEY set on the application is invalid/);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.equal(result.output.includes('not-a-valid-key-0123456789'), false);
});

test('the app is set to stop-first with a /healthz health check and a stop grace period before it deploys', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const update = indexOf(result.calls, call => call.target === 'application.update' && call.body.applicationId === mainId);
  const deploy = indexOf(result.calls, call => call.target === 'application.deploy' && call.body.applicationId === mainId);
  assert.ok(update > -1 && update < deploy);
  const { body } = result.calls[update];
  assert.equal(body.replicas, 1);
  assert.deepEqual(body.updateConfigSwarm, { Parallelism: 1, Order: 'stop-first' });
  assert.deepEqual(body.healthCheckSwarm, {
    Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"],
    Interval: 30_000_000_000,
    Timeout: 5_000_000_000,
    StartPeriod: 30_000_000_000,
    Retries: 3,
  });
  assert.equal(body.stopGracePeriodSwarm, 135_000_000_000);
  // The settings are read back before the deploy.
  const readBack = indexOf(result.calls, (call, index) => index > update && call.target === 'application.one' && call.query.applicationId === mainId);
  assert.ok(readBack > update && readBack < deploy);
});

test('without a stop grace field or StartPeriod the deploy leaves them out and warns loudly', async () => {
  const platform = createFakePlatform({ openApi: dokployOpenApi({ stopGrace: false, startPeriod: false }) });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const { body } = result.calls.find(call => call.target === 'application.update' && call.body.applicationId === mainId);
  assert.equal('stopGracePeriodSwarm' in body, false);
  assert.equal('StartPeriod' in body.healthCheckSwarm, false);
  assert.match(result.stderr, /!!! This Dokploy instance has no Swarm stop grace period setting/);
  assert.match(result.stderr, /application\.update has no Swarm stop grace period field/);
});

test('a stop grace value the instance rejects is dropped with a loud warning, keeping stop-first', async () => {
  const platform = createFakePlatform({ rejectStopGrace: true });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  const mainId = appIdByName(platform, 'content-radar');
  const updates = result.calls.filter(call => call.target === 'application.update' && call.body.applicationId === mainId);
  assert.equal(updates.length, 2);
  assert.equal('stopGracePeriodSwarm' in updates[1].body, false);
  assert.deepEqual(updates[1].body.updateConfigSwarm, { Parallelism: 1, Order: 'stop-first' });
  assert.match(result.stderr, /!!! Dokploy rejected stopGracePeriodSwarm \(.*Expected bigint, received number\)/);
  assert.equal(platform.dokploy.applications.get(mainId).updateConfigSwarm.Order, 'stop-first');
  assert.equal(result.stderr.includes('did not keep stopGracePeriodSwarm'), false, 'warned once');
});

test('a start-first setting that does not stick stops the deploy before anything is deployed', async () => {
  const platform = createFakePlatform({
    onRequest(call, fake) {
      // Simulate an instance that silently drops updateConfigSwarm.
      if (call.target === 'application.update' && call.body?.updateConfigSwarm) delete call.body.updateConfigSwarm;
      void fake;
    },
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not keep updateConfigSwarm/);
  assert.equal(result.calls.some(call => call.target === 'application.deploy'), false);
});

test('a Traefik domain that differs is updated with every setting, and a dry run only plans it', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  const [domain] = mainApp(platform).domains;
  Object.assign(domain, {
    host: 'Radar.Example.Test', path: '/app', port: 80, https: false, certificateType: 'letsencrypt', domainType: null, stripPath: true, enabled: false,
  });
  const drifted = structuredClone(domain);

  const dry = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(dry.code, 0, dry.output);
  assert.deepEqual(dry.calls.filter(isMutating), [], 'a dry run sends no change');
  assert.match(dry.stdout, /\[plan update\] Traefik domain https:\/\/radar\.example\.test\/ → port 3000 \(certificateType none: Traefik's default certificate\) \(was different in: path, port, https, certificateType, domainType, stripPath, enabled\)/);
  assert.match(dry.stdout, /#2 POST dokploy domain\.update \{"domainId":"domain-\d+","host":"radar\.example\.test","path":"\/","port":3000,"https":true,"certificateType":"none","domainType":"application","stripPath":false,"enabled":true\}/);
  assert.match(dry.stdout, /2 change\(s\) planned; nothing was sent/);
  assert.deepEqual(domain, drifted);

  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  // Dokploy applies a domain change to Traefik at once: no second deploy.
  assert.deepEqual(mutations(result.calls), ['application.deploy', 'domain.update']);
  assert.deepEqual(result.calls.find(call => call.target === 'domain.update').body, {
    domainId: domain.domainId, host: FAKE.hostname, ...DESIRED_DOMAIN, enabled: true,
  });
  assert.deepEqual(mainApp(platform).domains.map(({ host, path, port, https, certificateType, domainType, stripPath, enabled }) => ({ host, path, port, https, certificateType, domainType, stripPath, enabled })),
    [{ host: FAKE.hostname, ...DESIRED_DOMAIN, enabled: true }]);

  const again = await runScript(['deploy'], { platform });
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(mutations(again.calls), ['application.deploy']);
});

test('domains for other hostnames are kept with a warning; several for the hostname stop the deploy', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  // Dokploy's generated hostnames embed the server address in dashed form.
  const generated = `content-radar-x7k2q9-${FAKE.originIp.replaceAll('.', '-')}.traefik.me`;
  seedApplication(platform, {
    name: 'content-radar', appName: 'content-radar', environmentId, domains: [appDomain({ domainId: 'domain-generated', host: generated, https: false })],
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stderr, /\[warn\] Application "content-radar" also has Traefik domains for other hostnames \(content-radar-x7k2q9-<origin-ip>\.traefik\.me\); the deploy keeps them\./);
  assert.deepEqual(mainApp(platform).domains.map(domain => domain.host), [generated, FAKE.hostname]);
  assert.equal(result.calls.some(call => call.target === 'domain.delete'), false);
  assertNoSecrets(result.output);

  mainApp(platform).domains.push(appDomain({ domainId: 'domain-duplicate', port: 8080 }));
  const duplicate = await runScript(['deploy'], { platform });
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /\[blocker\] Application "content-radar" has 2 Traefik domains for radar\.example\.test; keep one in Dokploy\./);
  assert.match(duplicate.stderr, /The deploy did not start/);
  assert.deepEqual(duplicate.calls.filter(isMutating), []);
});

test('a published port stops the deploy before any change', async () => {
  const platform = createFakePlatform();
  const environmentId = seedProject(platform);
  seedApplication(platform, { name: 'content-radar', appName: 'content-radar', environmentId, ports: [{ portId: 'p1', publishedPort: 3000, targetPort: 3000 }] });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] Application "content-radar" has published port 3000 → 3000, which serves the app on the VPS beside Traefik; remove it in Dokploy\./);
  assert.deepEqual(result.calls.filter(isMutating), []);
});

test('an existing record for the hostname, such as the old tunnel CNAME, is updated in place to the origin', async () => {
  const cname = { id: 'dns-existing', type: 'CNAME', name: FAKE.hostname, content: 'c93bf8ce-0000-4000-8000-000000000000.cfargotunnel.com', proxied: true, ttl: 1 };
  const platform = createFakePlatform({ dnsRecords: [{ ...cname }] });

  const preflight = await runScript(['preflight'], { platform });
  assert.equal(preflight.code, 0, preflight.output);
  assert.match(preflight.stderr, /\[warn\] DNS: radar\.example\.test is CNAME c93bf8ce-0000-4000-8000-000000000000\.cfargotunnel\.com \(proxied\); the deploy updates this record in place to a proxied A record to <origin-ip> \(ORIGIN_IP\), as its last step\./);

  const dry = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(dry.code, 0, dry.output);
  assert.match(dry.stdout, /#\d+ PUT cloudflare \/zones\/[0-9a-f]+\/dns_records\/dns-existing \{"type":"A","name":"radar\.example\.test","content":"<origin-ip>","proxied":true,"ttl":1,"comment":"Content Radar on Dokploy Traefik \(scripts\/deploy\/dokploy-cloudflare\.mjs\)"\}/);
  assert.deepEqual(platform.cloudflare.dnsRecords, [cname]);

  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(call => call.service === 'cloudflare' && isMutating(call) && call.target.includes('/dns_records')).map(call => `${call.method} ${call.target}`),
    [`PUT /zones/${FAKE.zoneId}/dns_records/dns-existing`]);
  assert.deepEqual(platform.cloudflare.dnsRecords.map(recordView), [{ id: 'dns-existing', type: 'A', name: FAKE.hostname, content: FAKE.originIp, proxied: true }]);
  assert.match(result.stdout, /\[update\] DNS: radar\.example\.test CNAME c93bf8ce-0000-4000-8000-000000000000\.cfargotunnel\.com \(proxied\) → proxied A record to <origin-ip> \(ORIGIN_IP\), same record/);
  for (const run of [preflight, dry, result]) assertNoSecrets(run.output);
});

test('an A record to another address, or one without the proxy, is updated in place', async () => {
  for (const drift of [{ content: '198.51.100.7' }, { proxied: false }]) {
    const platform = createFakePlatform();
    assert.equal((await runScript(['deploy'], { platform })).code, 0);
    Object.assign(platform.cloudflare.dnsRecords[0], drift);
    const [{ id }] = platform.cloudflare.dnsRecords;
    const result = await runScript(['deploy'], { platform });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(result.calls.filter(isMutating).map(call => `${call.method} ${call.target}`),
      ['POST application.deploy', `PUT /zones/${FAKE.zoneId}/dns_records/${id}`], JSON.stringify(drift));
    assert.deepEqual(platform.cloudflare.dnsRecords.map(recordView), [{ id, type: 'A', name: FAKE.hostname, content: FAKE.originIp, proxied: true }]);
    assert.equal(result.output.includes('198.51.100.7'), false, 'no address is printed');
    assertNoSecrets(result.output);
  }
});

test('several DNS records for the hostname block the deploy, and none is deleted', async () => {
  const records = [
    { id: 'dns-a', type: 'A', name: FAKE.hostname, content: FAKE.originIp, proxied: true },
    { id: 'dns-aaaa', type: 'AAAA', name: FAKE.hostname, content: '2001:db8::7', proxied: true },
  ];
  const platform = createFakePlatform({ dnsRecords: structuredClone(records) });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] DNS has 2 records for radar\.example\.test \(A <origin-ip> \(proxied\), AAAA <other address> \(proxied\)\)\. The deploy updates one record in place and never deletes any/);
  assert.match(result.stderr, /The deploy did not start/);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.deepEqual(platform.cloudflare.dnsRecords, records);
  assert.equal(result.output.includes('2001:db8::7'), false);
  assertNoSecrets(result.output);
});

test('DNS records that appear during the deploy are read again: several of them stop it before any DNS change', async () => {
  const late = [
    { id: 'dns-late-1', type: 'A', name: FAKE.hostname, content: '198.51.100.7', proxied: true },
    { id: 'dns-late-2', type: 'A', name: FAKE.hostname, content: '198.51.100.8', proxied: true },
  ];
  const platform = createFakePlatform({
    onRequest(call, fake) {
      if (call.target === 'domain.create' && fake.cloudflare.dnsRecords.length === 0) fake.cloudflare.dnsRecords.push(...structuredClone(late));
    },
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The deploy stopped: DNS has 2 records for radar\.example\.test \(A <other address> \(proxied\), A <other address> \(proxied\)\)/);
  assert.deepEqual(result.calls.filter(call => call.target.includes('/dns_records') && isMutating(call)), []);
  assert.deepEqual(platform.cloudflare.dnsRecords, late);
});

test('extra policies on the Access application are kept and reported', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  platform.cloudflare.policies.push({ id: 'policy-bypass', name: 'everyone', decision: 'bypass', include: [{ everyone: {} }] });
  platform.cloudflare.accessApps[0].policies.push({ id: 'policy-bypass', name: 'everyone', decision: 'bypass', precedence: 3 });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.match(result.stderr, /also has 1 other policy: "everyone" \(bypass\)\. The deploy keeps them; review them/);
  assert.equal(result.calls.some(call => call.method === 'PUT' && call.target.includes('/access/apps/')), false);
  assert.equal(platform.cloudflare.accessApps[0].policies.length, 3);
});

test('an Access application for the hostname that is not ours is never modified', async () => {
  const platform = createFakePlatform();
  platform.cloudflare.accessApps.push({
    id: 'foreign-app', aud: 'foreign-aud', name: 'Someone else', type: 'self_hosted', domain: FAKE.hostname,
    destinations: [{ type: 'public', uri: FAKE.hostname }], policies: [],
  });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[blocker\] The Access application "Someone else" covers radar\.example\.test without the content-radar policies/);
  assert.deepEqual(result.calls.filter(isMutating), [], 'preflight stops before any change');

  // Attached by hand under another name, it is used as is.
  platform.cloudflare.policies.push(
    { id: 'p-users', name: 'content-radar-users', decision: 'allow', include: [{ email: { email: FAKE.operatorEmail } }, { email: { email: FAKE.viewerEmail } }] },
    { id: 'p-token', name: 'content-radar-agent-service-token', decision: 'non_identity', include: [{ service_token: { token_id: FAKE.serviceTokenId } }] },
  );
  platform.cloudflare.accessApps[0].policies = [
    { id: 'p-users', name: 'content-radar-users', precedence: 1 },
    { id: 'p-token', name: 'content-radar-agent-service-token', precedence: 2 },
  ];
  const attached = await runScript(['deploy'], { platform });
  assert.equal(attached.code, 0, attached.output);
  assert.equal(attached.calls.some(call => call.target.includes('/access/') && isMutating(call) && !call.target.endsWith('/identity_providers')), false);
  const mainId = appIdByName(platform, 'content-radar');
  assert.equal(parseEnvText(platform.dokploy.applications.get(mainId).env).values.get('ACCESS_AUD'), 'foreign-aud');
});

test('dry run lists the planned changes in order and sends none of them', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutating), [], 'no mutating call is sent');
  const planned = [...result.stdout.matchAll(/^ {4}#(\d+) (POST|PUT|PATCH) (dokploy|cloudflare) (\S+)/gm)]
    .map(([, number, method, service, target]) => ({ number: Number(number), method, service, target }));
  assert.deepEqual(planned.map(entry => entry.number), planned.map((_, index) => index + 1));
  const targets = planned.map(entry => entry.target.replace(/^\/accounts\/[0-9a-f]+/, '').replace(/^\/zones\/[0-9a-f]+/, ''));
  assert.deepEqual(targets, [
    '/access/identity_providers',
    '/access/policies',
    '/access/policies',
    '/access/apps',
    'project.create',
    'application.create',
    'application.saveGitProvider',
    'application.saveBuildType',
    'application.saveEnvironment',
    'mounts.create',
    'application.update',
    'application.deploy',
    'domain.create',
    '/dns_records',
  ]);
  assert.match(result.stdout, /APP_MASTER_KEY=\[REDACTED\]/);
  assert.match(result.stdout, /#13 POST dokploy domain\.create \{"host":"radar\.example\.test","path":"\/","port":3000,"https":true,"certificateType":"none","domainType":"application","stripPath":false,"applicationId":"<new-application-id:content-radar>"\}/);
  assert.match(result.stdout, /#14 POST cloudflare \/zones\/[0-9a-f]+\/dns_records \{"type":"A","name":"radar\.example\.test","content":"<origin-ip>","proxied":true,"ttl":1,"comment":"Content Radar on Dokploy Traefik \(scripts\/deploy\/dokploy-cloudflare\.mjs\)"\}/);
  assert.match(result.stdout, /14 change\(s\) planned; nothing was sent/);
  assertNoSecrets(result.output);
  assert.equal(platform.dokploy.applications.size, 0);
  assert.equal(platform.cloudflare.policies.length, 0);
});

test('dry run against a finished deployment plans only the app deploy', async () => {
  const platform = createFakePlatform();
  assert.equal((await runScript(['deploy'], { platform })).code, 0);
  const result = await runScript(['deploy', '--dry-run'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter(isMutating), []);
  assert.match(result.stdout, /#1 POST dokploy application\.deploy/);
  assert.match(result.stdout, /1 change\(s\) planned; nothing was sent/);
});

test('a failed build prints the redacted deployment log and stops before the domain and DNS', async () => {
  const leakedKey = Buffer.alloc(32, 9).toString('base64');
  const platform = createFakePlatform({
    failDeploymentOf: 'content-radar',
    deploymentLog: [
      'Cloning https://github.com/dantech0xff/hot-news-radar.git',
      `curl -H "x-api-key: ${FAKE.dokployApiKey}" http://localhost:3000`,
      `APP_MASTER_KEY=${leakedKey}`,
      `Authorization: Bearer ${FAKE.cfApiToken}`,
      `Error: cannot reach https://${FAKE.originIp}:443`,
    ].join('\n'),
  });
  const result = await runScript(['deploy'], { platform, randomBytes: () => Buffer.alloc(32, 9) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Last 5 log lines of the content-radar deployment \(redacted\)/);
  assert.match(result.stderr, /Error: cannot reach https:\/\/<origin-ip>:443/);
  assert.match(result.stderr, /ended with status "error"/);
  assertNoSecrets(result.output, [leakedKey]);
  const failedDeploy = result.calls.findIndex(call => call.target === 'application.deploy');
  assert.ok(failedDeploy > -1);
  assert.deepEqual(result.calls.slice(failedDeploy + 1).filter(call => call.service === 'cloudflare'), [], 'nothing touches DNS after a failed build');
  assert.equal(result.calls.some(call => call.target.startsWith('domain.')), false, 'Traefik never routes to a failed build');
});

test('an unknown deployment status stops the wait at once instead of timing out', async () => {
  const platform = createFakePlatform({ deploymentStatus: app => (app?.name === 'content-radar' ? 'success' : undefined) });
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The content-radar deployment ended with status "success"/);
  const polls = result.calls.filter(call => call.target === 'deployment.all').length;
  assert.ok(polls <= 3, `stopped after ${polls} polls`);
});

test('a deployment that never finishes times out with a clear message', async () => {
  const platform = createFakePlatform({ deploymentStatus: app => (app?.name === 'content-radar' ? 'running' : undefined) });
  const result = await runScript(['deploy', '--wait-minutes', '2'], { platform });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The content-radar deployment is still "running" after 2 min; check it in Dokploy, then re-run/);
  assert.deepEqual(result.calls.filter(call => isMutating(call) && (call.target.startsWith('domain.') || call.target.includes('/dns_records'))), []);
});

test('missing variables are named, values are never printed, and the deploy does not start', async () => {
  const platform = createFakePlatform();
  const result = await runScript(['deploy'], { platform, env: deployEnv({ CF_API_TOKEN: '', APP_OPERATOR_EMAILS: undefined }) });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing environment variables: CF_API_TOKEN, APP_OPERATOR_EMAILS/);
  assert.deepEqual(result.calls, []);
  assertNoSecrets(result.output);
});
