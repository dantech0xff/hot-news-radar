import test from 'node:test';
import assert from 'node:assert/strict';

import { readDeployConfig } from '../../scripts/deploy/config.mjs';
import { USAGE } from '../../scripts/deploy/dokploy-cloudflare.mjs';
import { analyzeDokployContract } from '../../scripts/deploy/dokploy-contract.mjs';
import { readApplication } from '../../scripts/deploy/dokploy-steps.mjs';
import { githubWebhookTarget } from '../../scripts/deploy/github-source.mjs';
import { REDACTED, Redactor } from '../../scripts/deploy/redaction.mjs';
import {
  FAKE,
  FAKE_SECRETS,
  createFakePlatform,
  deployEnv,
  dokployOpenApi,
  githubProvider,
  isMutating,
  runScript,
  webhookBypassApp,
} from './helpers/fake-platform.js';

const MASTER = ['deploy', '--git-branch', 'master'];
const WEBHOOK_WARNING = /\[warn\] No Cloudflare Access application with a Bypass policy covers dokploy\.example\.test\/api\/deploy\/github/;
const githubEnv = (overrides = {}) => deployEnv({ DOKPLOY_SOURCE: 'github', ...overrides });
const mainApp = platform => [...platform.dokploy.applications.values()].find(app => app.name === 'content-radar');
const mutations = calls => calls.filter(isMutating).map(call => call.target);
const sourceOf = app => Object.fromEntries(['sourceType', 'githubId', 'owner', 'repository', 'branch', 'buildPath', 'triggerType', 'autoDeploy'].map(key => [key, app[key]]));

function assertNoSecrets(result) {
  for (const secret of FAKE_SECRETS) assert.equal(result.output.includes(secret), false, 'a secret value was printed');
}

// The live state before the switch: deployed from the public Git URL, with the webhook bypass in Access.
async function deployedFromGit() {
  const platform = createFakePlatform();
  platform.cloudflare.accessApps.push(webhookBypassApp());
  const result = await runScript(['deploy'], { platform });
  assert.equal(result.code, 0, result.output);
  assert.equal(mainApp(platform).sourceType, 'git');
  return platform;
}

test('switching the live app from the public Git URL to the GitHub App tracks master and changes nothing else', async () => {
  const platform = await deployedFromGit();
  const before = structuredClone(mainApp(platform));

  const dry = await runScript([...MASTER, '--dry-run'], { platform, env: githubEnv() });
  assert.equal(dry.code, 0, dry.output);
  assert.deepEqual(dry.calls.filter(isMutating), [], 'a dry run sends no change');
  assert.match(dry.stdout, /#1 POST dokploy application\.saveGithubProvider \{"applicationId":"[^"]+","githubId":"github-provider-0001","owner":"dantech0xff","repository":"hot-news-radar","branch":"master","buildPath":"\/","triggerType":"push","watchPaths":null,"enableSubmodules":false\}/);
  assert.match(dry.stdout, /#2 POST dokploy application\.deploy/);
  assert.match(dry.stdout, /2 change\(s\) planned; nothing was sent/);
  assert.equal(mainApp(platform).sourceType, 'git');

  const result = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(result.code, 0, result.output);
  // Only the source changes, then the app deploys from it: environment, master key, volume, Swarm, Access, the Traefik domain, and DNS stay.
  assert.deepEqual(mutations(result.calls), ['application.saveGithubProvider', 'application.deploy']);
  const [save] = result.calls.filter(call => call.target === 'application.saveGithubProvider');
  assert.deepEqual(save.body, {
    applicationId: before.applicationId,
    githubId: FAKE.githubId,
    owner: 'dantech0xff',
    repository: 'hot-news-radar',
    branch: 'master',
    buildPath: '/',
    triggerType: 'push',
    watchPaths: null,
    enableSubmodules: false,
  });
  const after = mainApp(platform);
  assert.deepEqual(sourceOf(after), {
    sourceType: 'github', githubId: FAKE.githubId, owner: 'dantech0xff', repository: 'hot-news-radar',
    branch: 'master', buildPath: '/', triggerType: 'push', autoDeploy: true,
  });
  assert.equal(after.env, before.env);
  assert.deepEqual(after.mounts, before.mounts);
  assert.match(result.stdout, /Deploying radar\.example\.test \(branch master, GitHub App source\)/);
  assert.match(result.stdout, /\[update\] Source → GitHub dantech0xff\/hot-news-radar branch master through the provider "Dokploy-2026-10-01-g7i5b9" \(was: git, branch master\)/);
  assert.match(result.stdout, /\[ok\] Auto deploy is on: Dokploy deploys every push to master/);
  assertNoSecrets(dry);
  assertNoSecrets(result);

  const again = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(mutations(again.calls), ['application.deploy'], 'a re-run only redeploys, as in git mode');
  assert.match(again.stdout, /\[ok\] Source: GitHub dantech0xff\/hot-news-radar branch master through the provider "Dokploy-2026-10-01-g7i5b9"\./);
  assertNoSecrets(again);
});

test('an app already on the GitHub source is saved again when any part drifts, never silently when the branch moves', async () => {
  const platform = await deployedFromGit();
  assert.equal((await runScript(MASTER, { platform, env: githubEnv() })).code, 0);
  const onMaster = sourceOf(mainApp(platform));

  // Without --git-branch the default branch (master) applies, so nothing moves.
  const kept = await runScript(['deploy'], { platform, env: githubEnv() });
  assert.equal(kept.code, 0, kept.output);
  assert.equal(mainApp(platform).branch, 'master');
  assert.doesNotMatch(kept.stderr, /The source moves from branch/);

  // An explicit other branch moves the source, with a warning saying which pushes deploy now.
  const moved = await runScript(['deploy', '--git-branch', 'feat/dokploy-dashboard'], { platform, env: githubEnv() });
  assert.equal(moved.code, 0, moved.output);
  assert.match(moved.stderr, /\[warn\] The source moves from branch master to feat\/dokploy-dashboard: from then on only pushes to feat\/dokploy-dashboard deploy\. To keep master, pass --git-branch master\./);
  assert.match(moved.stdout, /\(was: github, branch master\)/);
  assert.equal(mainApp(platform).branch, 'feat/dokploy-dashboard');
  const back = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(back.code, 0, back.output);
  assert.deepEqual(sourceOf(mainApp(platform)), onMaster);

  for (const drift of [{ triggerType: 'tag' }, { githubId: 'github-provider-removed' }, { buildPath: '/web' }, { owner: 'DanTech0xFF' }]) {
    Object.assign(mainApp(platform), drift);
    const result = await runScript(MASTER, { platform, env: githubEnv() });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(mutations(result.calls), ['application.saveGithubProvider', 'application.deploy'], JSON.stringify(drift));
    assert.equal(result.stderr.includes('The source moves'), false, 'the branch did not move');
    assert.deepEqual(sourceOf(mainApp(platform)), onMaster);
    assertNoSecrets(result);
  }

  // Watch paths set in the Dokploy UI are kept, but the output no longer claims that every push deploys.
  mainApp(platform).watchPaths = ['docs/**'];
  const watched = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(watched.code, 0, watched.output);
  assert.deepEqual(mutations(watched.calls), ['application.deploy']);
  assert.match(watched.stderr, /\[warn\] Watch paths are set on the application \(1\): Dokploy deploys only the pushes that change matching files\./);
  assertNoSecrets(moved);
  assertNoSecrets(watched);
});

test('a failed GitHub build never shows the clone token in the printed log', async () => {
  const token = `ghs_${'A1b2C3d4'.repeat(5)}`;
  const platform = createFakePlatform({
    failDeploymentOf: 'content-radar',
    deploymentLog: [
      `Cloning https://oauth2:${token}@github.com/dantech0xff/hot-news-radar.git`,
      `remote: Invalid username or token ${token}`,
      'Error: the build failed',
    ].join('\n'),
  });
  platform.cloudflare.accessApps.push(webhookBypassApp());
  const result = await runScript(MASTER, { platform, env: githubEnv(), randomBytes: () => Buffer.alloc(32, 5) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cloning https:\/\/\[REDACTED\]@github\.com\/dantech0xff\/hot-news-radar\.git/);
  assert.match(result.stderr, /remote: Invalid username or token \[REDACTED\]/);
  assert.match(result.stderr, /Error: the build failed/);
  assert.equal(result.output.includes(token), false);
  assertNoSecrets(result);
});

test('reading an application registers its webhook token and GitHub App secrets with the redactor', async () => {
  const redactor = new Redactor();
  const app = {
    applicationId: 'application-1',
    appName: 'content-radar-x7k2q9',
    refreshToken: FAKE.refreshToken,
    github: { githubClientSecret: FAKE.githubClientSecret, githubWebhookSecret: FAKE.githubWebhookSecret, githubPrivateKey: FAKE.githubPrivateKey },
  };
  await readApplication({ dokploy: { query: async () => app }, redactor }, 'application-1', 'content-radar');
  for (const secret of [FAKE.refreshToken, FAKE.githubClientSecret, FAKE.githubWebhookSecret, FAKE.githubPrivateKey]) {
    assert.equal(redactor.redact(`before ${secret} after`), `before ${REDACTED} after`);
  }
  // An application without a GitHub source or webhook token has nothing to register.
  await assert.doesNotReject(readApplication({ dokploy: { query: async () => ({ ...app, refreshToken: null, github: null }) }, redactor: new Redactor() }, 'application-1', 'content-radar'));
});

test('auto deploy is turned back on when it is off, once', async () => {
  const platform = await deployedFromGit();
  mainApp(platform).autoDeploy = false;
  const result = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(result.code, 0, result.output);
  const updates = result.calls.filter(call => call.target === 'application.update' && 'autoDeploy' in call.body);
  assert.deepEqual(updates.map(call => call.body), [{ applicationId: mainApp(platform).applicationId, autoDeploy: true }]);
  assert.match(result.stdout, /\[update\] Auto deploy → on \(Dokploy deploys every push to master\)/);
  assert.equal(mainApp(platform).autoDeploy, true);

  const again = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(mutations(again.calls), ['application.deploy']);
});

test('a first deploy in GitHub mode sets the GitHub source instead of the Git URL; its dry run sends nothing', async () => {
  const platform = createFakePlatform();
  platform.cloudflare.accessApps.push(webhookBypassApp());
  const dry = await runScript([...MASTER, '--dry-run'], { platform, env: githubEnv() });
  assert.equal(dry.code, 0, dry.output);
  assert.deepEqual(dry.calls.filter(isMutating), [], 'no mutating call is sent');
  const planned = [...dry.stdout.matchAll(/^ {4}#\d+ POST dokploy (\S+)/gm)].map(([, target]) => target);
  assert.deepEqual(planned.slice(0, 4), ['project.create', 'application.create', 'application.saveGithubProvider', 'application.saveBuildType']);
  assert.equal(planned.includes('application.saveGitProvider'), false);
  assert.match(dry.stdout, /\[info\] A new application has auto deploy on by default/);
  assert.equal(platform.dokploy.applications.size, 0);

  const real = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(real.code, 0, real.output);
  assert.deepEqual(sourceOf(mainApp(platform)), {
    sourceType: 'github', githubId: FAKE.githubId, owner: 'dantech0xff', repository: 'hot-news-radar',
    branch: 'master', buildPath: '/', triggerType: 'push', autoDeploy: true,
  });
  const save = real.calls.findIndex(call => call.target === 'application.saveGithubProvider');
  const deploy = real.calls.findIndex(call => call.target === 'application.deploy' && call.body.applicationId === mainApp(platform).applicationId);
  assert.ok(save > -1 && save < deploy, 'the source is set before the first deploy');
  assert.equal(real.calls.some(call => call.target === 'application.saveGitProvider'), false);
  assert.equal(real.calls.some(call => call.target === 'application.update' && 'autoDeploy' in call.body), false, 'auto deploy is on by default');
  assertNoSecrets(dry);
  assertNoSecrets(real);
});

test('the provider is the only one or the one DOKPLOY_GITHUB_PROVIDER names; none, several, or an unknown name block', async () => {
  const platform = createFakePlatform();
  platform.cloudflare.accessApps.push(webhookBypassApp());
  const single = await runScript(['preflight'], { platform, env: githubEnv() });
  assert.equal(single.code, 0, single.output);
  assert.match(single.stdout, /\[ok\] GitHub provider "Dokploy-2026-10-01-g7i5b9" \(githubId github-provider-0001\) can see dantech0xff\/hot-news-radar\./);
  assert.match(single.stdout, /every procedure and field the deploy uses \(18 procedures\)/);

  platform.dokploy.githubProviders = [githubProvider({ githubId: 'github-old', name: 'Dokploy-2026-09-01-old', repositories: [] }), githubProvider()];
  const several = await runScript(['preflight'], { platform, env: githubEnv() });
  assert.equal(several.code, 1);
  assert.match(several.stderr, /\[blocker\] Dokploy has 2 GitHub providers \("Dokploy-2026-09-01-old", "Dokploy-2026-10-01-g7i5b9"\); set DOKPLOY_GITHUB_PROVIDER to the name of the one to use\./);
  assert.equal(several.calls.some(call => call.target === 'github.getGithubRepositories'), false);

  const named = await runScript(['preflight'], { platform, env: githubEnv({ DOKPLOY_GITHUB_PROVIDER: 'Dokploy-2026-10-01-g7i5b9' }) });
  assert.equal(named.code, 0, named.output);
  assert.deepEqual(named.calls.filter(call => call.target === 'github.getGithubRepositories').map(call => call.query), [{ githubId: FAKE.githubId }]);

  const unknown = await runScript(['preflight'], { platform, env: githubEnv({ DOKPLOY_GITHUB_PROVIDER: 'Dokploy-typo' }) });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /\[blocker\] No Dokploy GitHub provider has the name set in DOKPLOY_GITHUB_PROVIDER; the providers are "Dokploy-2026-09-01-old", "Dokploy-2026-10-01-g7i5b9"\./);
  assert.equal(unknown.output.includes('Dokploy-typo'), false, 'the configured value is not echoed');

  platform.dokploy.githubProviders = [githubProvider({ githubId: 'github-a' }), githubProvider({ githubId: 'github-b' })];
  const duplicate = await runScript(['preflight'], { platform, env: githubEnv({ DOKPLOY_GITHUB_PROVIDER: FAKE.githubProviderName }) });
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /\[blocker\] 2 Dokploy GitHub providers have the name set in DOKPLOY_GITHUB_PROVIDER/);

  platform.dokploy.githubProviders = [];
  const none = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /\[blocker\] Dokploy lists no GitHub provider for the user of DOKPLOY_API_KEY\. If the GitHub App already exists, check that this user created it/);
  assert.match(none.stderr, /The deploy did not start/);

  for (const result of [single, several, named, unknown, duplicate, none]) {
    assert.deepEqual(result.calls.filter(isMutating), []);
    assertNoSecrets(result);
  }
});

test('a repository the provider cannot see blocks the deploy; a differently cased URL is saved as GitHub spells it', async () => {
  // The same name under another owner, and another repository of the same owner: both owner and name must match.
  const platform = createFakePlatform({
    githubProviders: [githubProvider({ repositories: ['someone-else/hot-news-radar', 'dantech0xff/another-repository'] })],
  });
  platform.cloudflare.accessApps.push(webhookBypassApp());
  const hidden = await runScript(MASTER, { platform, env: githubEnv() });
  assert.equal(hidden.code, 1);
  assert.match(hidden.stderr, /\[blocker\] The GitHub provider "Dokploy-2026-10-01-g7i5b9" cannot see dantech0xff\/hot-news-radar \(it sees 2 repositories\)\. Give its GitHub App access to that repository/);
  assert.match(hidden.stderr, /The deploy did not start/);
  assert.deepEqual(hidden.calls.filter(isMutating), []);
  assertNoSecrets(hidden);

  // Dokploy matches push webhooks on the exact owner and repository text, so GitHub's spelling is saved.
  platform.dokploy.githubProviders = [githubProvider({ repositories: ['DanTech0xFF/Hot-News-Radar'] })];
  const cased = await runScript([...MASTER, '--git-url', 'https://github.com/dantech0xff/hot-news-radar'], { platform, env: githubEnv() });
  assert.equal(cased.code, 0, cased.output);
  const [save] = cased.calls.filter(call => call.target === 'application.saveGithubProvider');
  assert.deepEqual([save.body.owner, save.body.repository], ['DanTech0xFF', 'Hot-News-Radar']);
});

test('preflight warns, without blocking, when GitHub push webhooks would stop at Access', async () => {
  const platform = createFakePlatform();
  const missing = await runScript(['preflight'], { platform, env: githubEnv() });
  assert.equal(missing.code, 0, missing.output);
  assert.match(missing.stderr, WEBHOOK_WARNING);
  assert.match(missing.stdout, /No blockers \(1 warning\)/);

  const at = uri => ({ domain: uri, destinations: [{ type: 'public', uri }] });
  const cases = [
    [webhookBypassApp(), true],
    [webhookBypassApp(at('dokploy.example.test/api/deploy')), true],
    [webhookBypassApp(at('dokploy.example.test/api/deploy/*')), true],
    [webhookBypassApp(at('*.example.test/api/deploy/github')), true],
    [webhookBypassApp({ policies: [{ id: 'policy-emails', name: 'emails', decision: 'allow' }] }), false],
    [webhookBypassApp(at('dokploy.example.test/api/deploy/githubx')), false],
    [webhookBypassApp(at('radar.example.test/api/deploy/github')), false],
  ];
  for (const [app, bypassed] of cases) {
    platform.cloudflare.accessApps = [app];
    const result = await runScript(['preflight'], { platform, env: githubEnv() });
    assert.equal(result.code, 0, result.output);
    assert.equal(WEBHOOK_WARNING.test(result.stderr), !bypassed, `${app.domain} with ${app.policies[0].decision}`);
    if (bypassed) {
      assert.match(result.stdout, /\[ok\] Access application "Dokploy GitHub webhook" has a Bypass policy for dokploy\.example\.test\/api\/deploy\/github, so GitHub push webhooks can reach Dokploy\./);
    }
  }

  // When the list leaves out the policy decisions, the application itself is read to find them.
  platform.cloudflare.accessApps = [webhookBypassApp()];
  const fetch = platform.fetch;
  platform.fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/access/apps') || url.searchParams.has('domain')) return response;
    const payload = await response.json();
    payload.result = payload.result.map(app => ({ ...app, policies: app.policies.map(({ id }) => ({ id })) }));
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const detailed = await runScript(['preflight'], { platform, env: githubEnv() });
  assert.equal(detailed.code, 0, detailed.output);
  assert.equal(WEBHOOK_WARNING.test(detailed.stderr), false);
  assert.ok(detailed.calls.some(call => call.method === 'GET' && call.target.endsWith('/access/apps/access-app-github-webhook')));

  // A failed lookup is a warning too; the Access check of the app itself still runs.
  platform.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/access/apps') && !url.searchParams.has('domain')) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null }), { status: 403 });
    }
    return fetch(input, init);
  };
  const failed = await runScript(['preflight'], { platform, env: githubEnv() });
  assert.equal(failed.code, 0, failed.output);
  assert.match(failed.stderr, /\[warn\] Cannot check whether GitHub push webhooks get through Access to dokploy\.example\.test\/api\/deploy\/github: .*HTTP 403/);
  assertNoSecrets(failed);

  // Git mode checks nothing about GitHub.
  platform.fetch = fetch;
  const git = await runScript(['preflight'], { platform });
  assert.equal(git.code, 0, git.output);
  assert.equal(git.calls.some(call => call.target.startsWith('github.')), false);
  assert.equal(git.output.includes('GitHub'), false);
});

test('the webhook target follows DOKPLOY_URL, including a path prefix and an IP address', () => {
  assert.deepEqual(githubWebhookTarget('https://Deploy.Example.Test'), { host: 'deploy.example.test', path: '/api/deploy/github', isIp: false });
  assert.deepEqual(githubWebhookTarget('https://example.test/dokploy'), { host: 'example.test', path: '/dokploy/api/deploy/github', isIp: false });
  assert.equal(githubWebhookTarget('http://203.0.113.10:3000').isIp, true);
  assert.equal(githubWebhookTarget('http://[2001:db8::1]:3000').isIp, true);
});

test('the GitHub procedures and the autoDeploy field are checked only in GitHub mode', async () => {
  const drifted = dokployOpenApi({ omit: ['github.getGithubRepositories', 'application.saveGithubProvider'], removeFields: { 'application.update': ['autoDeploy'] } });
  assert.deepEqual(analyzeDokployContract(drifted).problems, []);
  assert.deepEqual(analyzeDokployContract(drifted, { source: 'github' }).problems, [
    'github.getGithubRepositories is missing (the deploy calls GET /api/github.getGithubRepositories).',
    'application.saveGithubProvider is missing (the deploy calls POST /api/application.saveGithubProvider).',
    'application.update has no field "autoDeploy".',
  ]);

  // Each source checks only what it calls.
  const git = analyzeDokployContract(dokployOpenApi());
  const github = analyzeDokployContract(dokployOpenApi({ omit: ['application.saveGitProvider'] }), { source: 'github' });
  assert.deepEqual(github.problems, []);
  assert.equal(git.procedures.some(procedure => procedure.startsWith('github.') || procedure === 'application.saveGithubProvider'), false);
  assert.equal(github.procedures.includes('application.saveGitProvider'), false);
  assert.equal(github.procedures.length, git.procedures.length + 2);

  // A newly required field is drift; an unknown optional one is left out of the payload.
  const required = analyzeDokployContract(dokployOpenApi({ require: { 'application.saveGithubProvider': ['composeId'] } }), { source: 'github' });
  assert.deepEqual(required.problems, ['application.saveGithubProvider requires "composeId", which the deploy does not send.']);
  const older = analyzeDokployContract(dokployOpenApi({ removeFields: { 'application.saveGithubProvider': ['enableSubmodules'] } }), { source: 'github' });
  assert.ok(older.notes.includes('application.saveGithubProvider has no optional field "enableSubmodules"; it is left out.'));
  assert.deepEqual(older.fit('application.saveGithubProvider', { applicationId: 'a', watchPaths: null, enableSubmodules: false }), { applicationId: 'a', watchPaths: null });

  // Preflight reports them as blockers in GitHub mode only.
  const openApi = dokployOpenApi({ omit: ['application.saveGithubProvider'], removeFields: { 'application.update': ['autoDeploy'] } });
  const gitPreflight = await runScript(['preflight'], { platform: createFakePlatform({ openApi }) });
  assert.equal(gitPreflight.code, 0, gitPreflight.output);
  const githubPreflight = await runScript(['preflight'], { platform: createFakePlatform({ openApi }), env: githubEnv() });
  assert.equal(githubPreflight.code, 1);
  assert.match(githubPreflight.stderr, /\[blocker\] Dokploy API drift: application\.saveGithubProvider is missing/);
  assert.match(githubPreflight.stderr, /\[blocker\] Dokploy API drift: application\.update has no field "autoDeploy"/);
});

test('config: DOKPLOY_SOURCE and DOKPLOY_GITHUB_PROVIDER are validated without echoing values', () => {
  const git = readDeployConfig(deployEnv(), { command: 'deploy', flags: {} });
  assert.deepEqual(git.config.git, {
    url: 'https://github.com/dantech0xff/hot-news-radar.git', branch: 'master',
    source: 'git', githubProvider: null, owner: null, repository: null,
  });

  const github = readDeployConfig(
    deployEnv({ DOKPLOY_SOURCE: 'GitHub', DOKPLOY_GITHUB_PROVIDER: ' Dokploy-2026-10-01-g7i5b9 ' }),
    { command: 'deploy', flags: { 'git-branch': 'master', 'git-url': 'https://github.com/DanTech0xFF/Hot-News-Radar/' } },
  );
  assert.deepEqual(github.problems, []);
  assert.deepEqual(github.config.git, {
    url: 'https://github.com/DanTech0xFF/Hot-News-Radar/', branch: 'master',
    source: 'github', githubProvider: 'Dokploy-2026-10-01-g7i5b9', owner: 'DanTech0xFF', repository: 'Hot-News-Radar',
  });

  const invalid = readDeployConfig(deployEnv({ DOKPLOY_SOURCE: 'value-that-is-not-a-source', DOKPLOY_GITHUB_PROVIDER: 'two\nlines' }), { command: 'deploy', flags: {} });
  const text = invalid.problems.join(' ');
  assert.match(text, /DOKPLOY_SOURCE must be git \(the public Git URL, the default\) or github/);
  assert.match(text, /DOKPLOY_GITHUB_PROVIDER must be the name of a Dokploy GitHub provider/);
  assert.equal(text.includes('value-that-is-not-a-source'), false);

  for (const url of ['https://gitlab.com/dantech0xff/hot-news-radar.git', 'https://github.com/dantech0xff', 'https://github.com/a/b/c']) {
    const { problems } = readDeployConfig(deployEnv({ DOKPLOY_SOURCE: 'github' }), { command: 'deploy', flags: { 'git-url': url } });
    assert.deepEqual(problems, ['DOKPLOY_SOURCE=github needs --git-url to be a GitHub repository URL such as https://github.com/<owner>/<repository>.git.'], url);
  }
  assert.deepEqual(readDeployConfig(deployEnv(), { command: 'deploy', flags: { 'git-url': 'https://gitlab.com/o/r.git' } }).problems, [], 'git mode takes any public https URL');
  const ignored = readDeployConfig(deployEnv({ DOKPLOY_GITHUB_PROVIDER: FAKE.githubProviderName }), { command: 'deploy', flags: {} });
  assert.match(ignored.warnings.join(' '), /DOKPLOY_GITHUB_PROVIDER is ignored: it applies only with DOKPLOY_SOURCE=github/);
});

test('the help names the GitHub settings and the --git-branch master switch', () => {
  assert.match(USAGE, /pass --git-branch master on every run/);
  assert.match(USAGE, /DOKPLOY_SOURCE=git\|github/);
  assert.match(USAGE, /DOKPLOY_GITHUB_PROVIDER=<name>/);
  assert.match(USAGE, /DOKPLOY_SOURCE=github npm run deploy:dokploy -- --git-branch master/);
});
