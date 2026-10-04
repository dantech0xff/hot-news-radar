/**
 * In-memory fake of the Dokploy and Cloudflare APIs (plus the deployed app)
 * for the deploy script tests. State persists across runs of the script, so
 * a second run sees what the first one created. Every request is recorded.
 * Nothing here touches the network.
 */

import { main } from '../../../scripts/deploy/dokploy-cloudflare.mjs';

export const FAKE = Object.freeze({
  dokployUrl: 'https://dokploy.example.test',
  dokployApiKey: 'dokploy-api-key-SECRET-0001',
  cfApiToken: 'cf-api-token-SECRET-0002',
  accountId: '0123456789abcdef0123456789abcdef',
  zoneId: 'fedcba9876543210fedcba9876543210',
  zoneName: 'example.test',
  hostname: 'radar.example.test',
  authDomain: 'radar-team.cloudflareaccess.com',
  serviceTokenId: '5b0e4c3a-0000-4000-8000-000000000001',
  clientId: '7f3c9a1b2d4e.access',
  clientSecret: 'cf-access-client-secret-SECRET-0003',
  operatorEmail: 'ops@example.test',
  viewerEmail: 'viewer@example.test',
  originIp: '203.0.113.10',
  channelCreatedAt: '2026-10-03T08:00:00.000Z',
  githubId: 'github-provider-0001',
  githubProviderName: 'Dokploy-2026-10-01-g7i5b9',
  githubOwner: 'dantech0xff',
  githubRepository: 'hot-news-radar',
  githubPrivateKey: 'github-app-private-key-SECRET-0005',
  githubWebhookSecret: 'github-app-webhook-secret-SECRET-0006',
  githubClientSecret: 'github-app-client-secret-SECRET-0007',
  refreshToken: 'dokploy-deploy-webhook-token-SECRET-0008',
});

/** Every secret value the script must never print or write. */
export const FAKE_SECRETS = Object.freeze([
  FAKE.dokployApiKey, FAKE.cfApiToken, FAKE.clientSecret,
  FAKE.githubPrivateKey, FAKE.githubWebhookSecret, FAKE.githubClientSecret, FAKE.refreshToken,
]);

/** The app's 401 for a request without an Access JWT (src/app/api/errors.js). */
export const APP_401_JSON = JSON.stringify({ error: 'unauthenticated', message: 'Cần đăng nhập qua Cloudflare Access.' });

/**
 * True when `text` shows the origin address: as is, or dashed as in generated
 * hostnames. The script prints `<origin-ip>` instead.
 * @param {string} text
 * @param {string} [address]
 */
export function showsAddress(text, address = FAKE.originIp) {
  return text.includes(address) || text.includes(address.replaceAll('.', '-'));
}

/**
 * @param {Record<string, string|undefined>} [overrides]
 * @returns {Record<string, string|undefined>}
 */
export function deployEnv(overrides = {}) {
  return {
    DOKPLOY_URL: FAKE.dokployUrl,
    DOKPLOY_API_KEY: FAKE.dokployApiKey,
    CF_API_TOKEN: FAKE.cfApiToken,
    CF_ACCOUNT_ID: FAKE.accountId,
    CF_ZONE_ID: FAKE.zoneId,
    APP_HOSTNAME: FAKE.hostname,
    APP_OPERATOR_EMAILS: FAKE.operatorEmail,
    APP_VIEWER_EMAILS: FAKE.viewerEmail,
    CF_ACCESS_CLIENT_ID: FAKE.clientId,
    CF_ACCESS_CLIENT_SECRET: FAKE.clientSecret,
    ORIGIN_IP: FAKE.originIp,
    ...overrides,
  };
}

/**
 * OpenAPI document shaped like the one Dokploy serves (`settings.getOpenApiDocument`).
 * @param {{ omit?: string[], require?: Record<string, string[]>, removeFields?: Record<string, string[]>, stopGrace?: boolean, startPeriod?: boolean }} [options]
 */
export function dokployOpenApi({ omit = [], require = {}, removeFields = {}, stopGrace = true, startPeriod = true } = {}) {
  const text = { type: 'string' };
  const nullableText = { type: 'string', nullable: true };
  const id = { type: 'string', minLength: 1 };
  const number = { type: 'number' };
  const post = (properties, required) => ({
    post: {
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties, required, additionalProperties: false } } } },
      responses: { 200: { description: 'Successful response' } },
    },
  });
  const get = parameters => ({
    get: {
      parameters: parameters.map(([name, required]) => ({ name, in: 'query', required, schema: { type: 'string' } })),
      responses: { 200: { description: 'Successful response' } },
    },
  });
  const health = { Test: { type: 'array', items: text }, Interval: number, Timeout: number, Retries: number };
  if (startPeriod) health.StartPeriod = number;
  const domainFields = {
    host: { type: 'string', minLength: 1 }, path: nullableText, port: { type: 'number', nullable: true }, https: { type: 'boolean' },
    certificateType: { type: 'string', enum: ['letsencrypt', 'none', 'custom'] }, customCertResolver: nullableText, serviceName: nullableText,
    domainType: { type: 'string', enum: ['compose', 'application', 'preview'], nullable: true }, internalPath: nullableText,
    stripPath: { type: 'boolean' },
  };
  const paths = {
    '/settings.getDokployVersion': get([]),
    '/settings.getOpenApiDocument': get([]),
    '/project.all': get([]),
    '/project.create': post({ name: text, description: nullableText, env: text }, ['name']),
    '/application.create': post({ name: text, appName: text, description: nullableText, environmentId: id, serverId: nullableText }, ['name', 'environmentId']),
    '/application.one': get([['applicationId', true]]),
    '/application.saveGitProvider': post({
      applicationId: id, customGitUrl: nullableText, customGitBranch: nullableText, customGitBuildPath: nullableText,
      customGitSSHKeyId: nullableText, watchPaths: { type: 'array', items: text, nullable: true }, enableSubmodules: { type: 'boolean' },
    }, ['applicationId', 'customGitUrl', 'customGitBranch', 'customGitBuildPath', 'customGitSSHKeyId', 'watchPaths']),
    '/github.githubProviders': get([]),
    '/github.getGithubRepositories': get([['githubId', true]]),
    '/application.saveGithubProvider': post({
      applicationId: id, repository: nullableText, branch: nullableText, owner: nullableText, buildPath: nullableText,
      githubId: nullableText, watchPaths: { type: 'array', items: text, nullable: true }, enableSubmodules: { type: 'boolean' },
      triggerType: { type: 'string', enum: ['push', 'tag'], default: 'push' },
    }, ['applicationId', 'repository', 'branch', 'owner', 'buildPath', 'githubId', 'watchPaths', 'enableSubmodules']),
    '/application.saveBuildType': post({
      applicationId: id, buildType: { type: 'string', enum: ['dockerfile', 'heroku_buildpacks', 'paketo_buildpacks', 'nixpacks', 'static', 'railpack'] },
      dockerfile: nullableText, dockerContextPath: nullableText, dockerBuildStage: nullableText, herokuVersion: nullableText,
      railpackVersion: nullableText, publishDirectory: nullableText, isStaticSpa: { type: 'boolean' },
    }, ['applicationId', 'buildType', 'dockerfile', 'dockerContextPath', 'dockerBuildStage', 'herokuVersion', 'railpackVersion']),
    '/application.saveEnvironment': post({
      applicationId: id, env: nullableText, buildArgs: nullableText, buildSecrets: nullableText, createEnvFile: { type: 'boolean' },
    }, ['applicationId', 'env', 'buildArgs', 'buildSecrets', 'createEnvFile']),
    '/mounts.create': post({
      type: { type: 'string', enum: ['bind', 'volume', 'file'] }, hostPath: nullableText, volumeName: nullableText, content: nullableText,
      mountPath: text, serviceType: { type: 'string', enum: ['application', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'compose'] },
      filePath: nullableText, serviceId: text,
    }, ['type', 'mountPath', 'serviceId']),
    '/domain.byApplicationId': get([['applicationId', true]]),
    '/domain.create': post({ ...domainFields, applicationId: nullableText, composeId: nullableText }, ['host']),
    '/domain.update': post({ ...domainFields, enabled: { type: 'boolean' }, domainId: text }, ['host', 'domainId']),
    '/application.update': post({
      applicationId: id, name: text, replicas: number, command: nullableText, args: { type: 'array', items: text, nullable: true },
      updateConfigSwarm: {
        type: 'object', nullable: true, additionalProperties: false, required: ['Parallelism', 'Order'],
        properties: { Parallelism: number, Delay: number, FailureAction: text, Monitor: number, MaxFailureRatio: number, Order: text },
      },
      healthCheckSwarm: { type: 'object', nullable: true, additionalProperties: false, properties: health },
      ...(stopGrace ? { stopGracePeriodSwarm: { type: 'integer', nullable: true } } : {}),
      autoDeploy: { type: 'boolean' },
    }, ['applicationId']),
    '/application.deploy': post({ applicationId: id, title: text, description: text }, ['applicationId']),
    '/application.redeploy': post({ applicationId: id, title: text, description: text }, ['applicationId']),
    '/deployment.all': get([['applicationId', true]]),
    '/deployment.readLogs': get([['deploymentId', true], ['tail', false]]),
  };
  for (const procedure of omit) delete paths[`/${procedure}`];
  for (const [procedure, fields] of Object.entries(removeFields)) {
    const schema = paths[`/${procedure}`].post.requestBody.content['application/json'].schema;
    for (const field of fields) {
      delete schema.properties[field];
      schema.required = schema.required.filter(name => name !== field);
    }
  }
  for (const [procedure, fields] of Object.entries(require)) {
    const schema = paths[`/${procedure}`].post.requestBody.content['application/json'].schema;
    for (const field of fields) {
      schema.properties[field] = text;
      schema.required.push(field);
    }
  }
  return { openapi: '3.0.3', info: { title: 'Dokploy', version: '1.0.0' }, paths };
}

/**
 * @param {{
 *   dokployVersion?: string,
 *   openApi?: object,
 *   organization?: object|null,
 *   serviceTokens?: object[],
 *   dnsRecords?: object[],
 *   failDeploymentOf?: string,
 *   deploymentStatus?: (application: object) => string|undefined,
 *   deploymentLog?: string,
 *   zoneReadable?: boolean,
 *   rejectStopGrace?: boolean,
 *   githubProviders?: ReturnType<typeof githubProvider>[],
 *   appResponder?: (request: { path: string, headers: Record<string, string>, platform: object }) => Response,
 *   onRequest?: (call: object, platform: object) => void,
 * }} [options] `githubProviders` defaults to one provider that can see this repository.
 */
export function createFakePlatform(options = {}) {
  let counter = 0;
  const nextId = prefix => `${prefix}-${String(++counter).padStart(4, '0')}`;
  const dokploy = {
    version: options.dokployVersion ?? 'v0.30.8',
    openApi: options.openApi ?? dokployOpenApi(),
    projects: [],
    applications: new Map(),
    deployments: [],
    githubProviders: options.githubProviders ?? [githubProvider()],
    failDeploymentOf: options.failDeploymentOf ?? null,
    deploymentLog: options.deploymentLog ?? 'Cloning repository\nBuilding image\nError: build failed',
  };
  const cloudflare = {
    tokenStatus: 'active',
    organization: options.organization === undefined ? { name: 'radar-team', auth_domain: FAKE.authDomain } : options.organization,
    identityProviders: [],
    policies: [],
    serviceTokens: options.serviceTokens ?? [{
      id: FAKE.serviceTokenId, name: 'content-radar-agent', client_id: FAKE.clientId, expires_at: '2027-10-01T00:00:00Z', duration: '8760h',
    }],
    accessApps: [],
    zone: { id: FAKE.zoneId, name: FAKE.zoneName, status: 'active', account: { id: FAKE.accountId } },
    dnsRecords: options.dnsRecords ?? [],
  };
  const app = { channelCreatedAt: FAKE.channelCreatedAt, leaseHolderId: 'a1b2c3d4' };
  const calls = [];
  const platform = { dokploy, cloudflare, app, calls, fetch, nextId };

  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const query = Object.fromEntries(url.searchParams);
    let call;
    if (url.origin === new URL(FAKE.dokployUrl).origin && url.pathname.startsWith('/api/')) {
      call = { service: 'dokploy', method, target: url.pathname.slice('/api/'.length), query, body, headers, redirect: init.redirect };
    } else if (url.origin === 'https://api.cloudflare.com' && url.pathname.startsWith('/client/v4/')) {
      call = { service: 'cloudflare', method, target: url.pathname.slice('/client/v4'.length), query, body, headers, redirect: init.redirect };
    } else if (url.origin === `https://${FAKE.hostname}`) {
      call = { service: 'app', method, target: url.pathname, query, headers, redirect: init.redirect };
    } else {
      throw new Error(`Unexpected request to ${url.origin}`);
    }
    calls.push(call);
    options.onRequest?.(call, platform);
    if (call.service === 'dokploy') {
      if (headers['x-api-key'] !== FAKE.dokployApiKey) return json(401, { message: 'Unauthorized', code: 'UNAUTHORIZED' });
      return handleDokploy(call);
    }
    if (call.service === 'cloudflare') {
      if (headers.authorization !== `Bearer ${FAKE.cfApiToken}`) return cloudflareError(401, 10000, 'Authentication error');
      return handleCloudflare(call);
    }
    return (options.appResponder ?? defaultAppResponder)({ path: url.pathname, headers, platform });
  }

  function handleDokploy({ method, target, query, body }) {
    const application = id => dokploy.applications.get(id);
    switch (`${method} ${target}`) {
      case 'GET settings.getDokployVersion':
        return json(200, dokploy.version);
      case 'GET settings.getOpenApiDocument':
        return json(200, dokploy.openApi);
      case 'GET project.all':
        return json(200, dokploy.projects.map(project => ({
          ...project,
          environments: project.environments.map(environment => ({
            ...environment,
            applications: [...dokploy.applications.values()]
              .filter(entry => entry.environmentId === environment.environmentId)
              .map(entry => ({ applicationId: entry.applicationId, name: entry.name, appName: entry.appName, applicationStatus: 'idle' })),
          })),
        })));
      case 'POST project.create': {
        const project = { projectId: nextId('project'), name: body.name, description: body.description ?? null, environments: [] };
        const environment = { environmentId: nextId('environment'), name: 'production', projectId: project.projectId };
        project.environments.push(environment);
        dokploy.projects.push(project);
        return json(200, { project: { projectId: project.projectId, name: project.name }, environment });
      }
      case 'POST application.create': {
        const environmentExists = dokploy.projects.some(project => project.environments.some(environment => environment.environmentId === body.environmentId));
        if (!environmentExists) return json(404, { message: 'Environment not found', code: 'NOT_FOUND' });
        const created = seedApplication(platform, { name: body.name, appName: body.appName, environmentId: body.environmentId });
        return json(200, structuredClone(created));
      }
      case 'GET application.one': {
        const found = application(query.applicationId);
        if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
        // Like Dokploy, the application comes with its GitHub provider row, GitHub App secrets included.
        const provider = dokploy.githubProviders.find(entry => entry.githubId === found.githubId);
        return json(200, { ...structuredClone(found), github: provider ? githubRow(provider) : null });
      }
      case 'POST application.saveGitProvider':
        return update(body.applicationId, {
          sourceType: 'git', customGitUrl: body.customGitUrl, customGitBranch: body.customGitBranch,
          customGitBuildPath: body.customGitBuildPath, customGitSSHKeyId: body.customGitSSHKeyId, watchPaths: body.watchPaths,
        });
      case 'GET github.githubProviders':
        // Whole provider rows with the GitHub App secrets, in case a version returns them: they must never be printed.
        return json(200, dokploy.githubProviders.map(provider => ({
          ...githubRow(provider),
          gitProvider: { gitProviderId: `git-${provider.githubId}`, name: provider.name, providerType: 'github', createdAt: '2026-10-01T00:00:00.000Z' },
        })));
      case 'GET github.getGithubRepositories': {
        const provider = dokploy.githubProviders.find(entry => entry.githubId === query.githubId);
        if (!provider) return json(404, { message: 'Github Provider not found', code: 'NOT_FOUND' });
        return json(200, provider.repositories.map((fullName, index) => {
          const [login, name] = fullName.split('/');
          return { id: 1000 + index, name, full_name: fullName, private: false, owner: { login }, html_url: `https://github.com/${fullName}` };
        }));
      }
      case 'POST application.saveGithubProvider':
        if (!dokploy.githubProviders.some(entry => entry.githubId === body.githubId)) {
          return json(404, { message: 'Github Provider not found', code: 'NOT_FOUND' });
        }
        return update(body.applicationId, {
          sourceType: 'github', githubId: body.githubId, owner: body.owner, repository: body.repository, branch: body.branch,
          buildPath: body.buildPath, triggerType: body.triggerType ?? 'push', watchPaths: body.watchPaths, enableSubmodules: body.enableSubmodules,
        });
      case 'POST application.saveBuildType':
        return update(body.applicationId, {
          buildType: body.buildType, dockerfile: body.dockerfile, dockerContextPath: body.dockerContextPath, dockerBuildStage: body.dockerBuildStage,
        });
      case 'POST application.saveEnvironment':
        return update(body.applicationId, { env: body.env, buildArgs: body.buildArgs, buildSecrets: body.buildSecrets, createEnvFile: body.createEnvFile });
      case 'POST mounts.create': {
        const found = application(body.serviceId);
        if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
        found.mounts.push({ mountId: nextId('mount'), type: body.type, volumeName: body.volumeName, mountPath: body.mountPath, serviceType: body.serviceType });
        return json(200, true);
      }
      case 'GET domain.byApplicationId': {
        const found = application(query.applicationId);
        if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
        return json(200, structuredClone(found.domains));
      }
      case 'POST domain.create': {
        const found = application(body.applicationId);
        if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
        const domain = appDomain({ domainId: nextId('domain'), ...body });
        found.domains.push(domain);
        return json(200, structuredClone(domain));
      }
      case 'POST domain.update': {
        const domain = [...dokploy.applications.values()].flatMap(entry => entry.domains).find(entry => entry.domainId === body.domainId);
        if (!domain) return json(404, { message: 'Domain not found', code: 'NOT_FOUND' });
        Object.assign(domain, body);
        return json(200, structuredClone(domain));
      }
      case 'POST application.update': {
        const { applicationId, ...fields } = body;
        if (options.rejectStopGrace && 'stopGracePeriodSwarm' in fields) {
          return json(400, { message: 'Input validation failed', code: 'BAD_REQUEST', issues: [{ path: ['stopGracePeriodSwarm'], message: 'Expected bigint, received number' }] });
        }
        return update(applicationId, structuredClone(fields));
      }
      case 'POST application.deploy':
      case 'POST application.redeploy': {
        const found = application(body.applicationId);
        if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
        dokploy.deployments.unshift({
          deploymentId: nextId('deployment'),
          applicationId: found.applicationId,
          status: 'running',
          kind: target,
          createdAt: new Date().toISOString(),
        });
        return json(200, true);
      }
      case 'GET deployment.all': {
        const list = dokploy.deployments.filter(deployment => deployment.applicationId === query.applicationId);
        for (const deployment of list) {
          if (deployment.status === 'running') {
            const owner = application(deployment.applicationId);
            deployment.status = options.deploymentStatus?.(owner) ?? (owner?.name === dokploy.failDeploymentOf ? 'error' : 'done');
            // A finished app deployment means a new process, with a new runtime lease holder.
            if (deployment.status === 'done' && owner?.name === 'content-radar') app.leaseHolderId = nextId('holder');
          }
        }
        return json(200, list.map(({ kind, ...view }) => view));
      }
      case 'GET deployment.readLogs':
        return json(200, dokploy.deploymentLog);
      default:
        return json(404, { message: `No procedure ${target}`, code: 'NOT_FOUND' });
    }
  }

  function githubRow(provider) {
    return {
      githubId: provider.githubId,
      githubAppName: `https://github.com/apps/${provider.name.toLowerCase()}`,
      githubPrivateKey: FAKE.githubPrivateKey,
      githubWebhookSecret: FAKE.githubWebhookSecret,
      githubClientSecret: FAKE.githubClientSecret,
      gitProviderId: `git-${provider.githubId}`,
    };
  }

  function update(applicationId, fields) {
    const found = dokploy.applications.get(applicationId);
    if (!found) return json(404, { message: 'Application not found', code: 'NOT_FOUND' });
    Object.assign(found, fields);
    return json(200, true);
  }

  function handleCloudflare({ method, target, query, body }) {
    const account = `/accounts/${FAKE.accountId}`;
    const route = `${method} ${target}`;
    let match;
    if (route === `GET ${account}/tokens/verify`) return ok({ id: 'token-0001', status: cloudflare.tokenStatus });
    if (route === `GET ${account}/access/organizations`) {
      return cloudflare.organization ? ok(cloudflare.organization) : cloudflareError(404, 12130, 'access.api.error.not_found');
    }
    if (route === `GET ${account}/access/identity_providers`) return ok(cloudflare.identityProviders);
    if (route === `POST ${account}/access/identity_providers`) return ok(push(cloudflare.identityProviders, { id: nextId('idp'), ...body }));
    if (route === `GET ${account}/access/policies`) return ok(cloudflare.policies);
    if (route === `POST ${account}/access/policies`) return ok(push(cloudflare.policies, { id: nextId('policy'), reusable: true, ...body }));
    if ((match = new RegExp(`^${account}/access/policies/([^/]+)$`).exec(target))) {
      const index = cloudflare.policies.findIndex(policy => policy.id === match[1]);
      if (index === -1) return cloudflareError(404, 12130, 'policy not found');
      if (method === 'GET') return ok(cloudflare.policies[index]);
      if (method === 'PUT') {
        cloudflare.policies[index] = { id: match[1], reusable: true, ...body };
        return ok(cloudflare.policies[index]);
      }
    }
    if (route === `GET ${account}/access/service_tokens`) return ok(cloudflare.serviceTokens);
    if (route === `GET ${account}/access/apps`) return ok(cloudflare.accessApps);
    if (route === `POST ${account}/access/apps`) {
      return ok(push(cloudflare.accessApps, { id: nextId('access-app'), aud: `aud${'0'.repeat(56)}${String(counter).padStart(4, '0')}`, ...body, policies: attachPolicies(body.policies) }));
    }
    if ((match = new RegExp(`^${account}/access/apps/([^/]+)$`).exec(target))) {
      const index = cloudflare.accessApps.findIndex(entry => entry.id === match[1]);
      if (index === -1) return cloudflareError(404, 12130, 'application not found');
      if (method === 'GET') return ok(cloudflare.accessApps[index]);
      if (method === 'PUT') {
        const { id, aud } = cloudflare.accessApps[index];
        cloudflare.accessApps[index] = { id, aud, ...body, policies: attachPolicies(body.policies) };
        return ok(cloudflare.accessApps[index]);
      }
    }
    if (route === `GET /zones/${FAKE.zoneId}`) {
      return options.zoneReadable === false ? cloudflareError(403, 9109, 'Unauthorized to access requested resource') : ok(cloudflare.zone);
    }
    if (route === `GET /zones/${FAKE.zoneId}/dns_records`) {
      return ok(cloudflare.dnsRecords.filter(record => !query.name || record.name === query.name));
    }
    if (route === `POST /zones/${FAKE.zoneId}/dns_records`) return ok(push(cloudflare.dnsRecords, { id: nextId('dns'), ...body }));
    // PUT overwrites the record (its type too) and keeps its id.
    if ((match = new RegExp(`^/zones/${FAKE.zoneId}/dns_records/([^/]+)$`).exec(target)) && method === 'PUT') {
      const index = cloudflare.dnsRecords.findIndex(entry => entry.id === match[1]);
      if (index === -1) return cloudflareError(404, 81044, 'Record does not exist.');
      cloudflare.dnsRecords[index] = { id: match[1], ...body };
      return ok(cloudflare.dnsRecords[index]);
    }
    return cloudflareError(404, 7003, `No route for ${route}`);
  }

  function attachPolicies(policies = []) {
    return policies.map(entry => {
      const policy = cloudflare.policies.find(candidate => candidate.id === entry.id);
      return { ...(policy ?? {}), id: entry.id, precedence: entry.precedence };
    });
  }

  return platform;
}

/**
 * A Dokploy domain row; by default the one the deploy wants for the app.
 * @param {object} [overrides]
 */
export function appDomain(overrides = {}) {
  return {
    domainId: 'domain-existing',
    host: FAKE.hostname,
    https: true,
    port: 3000,
    path: '/',
    serviceName: null,
    domainType: 'application',
    uniqueConfigKey: 1,
    createdAt: '2026-10-03T15:00:00.000Z',
    composeId: null,
    customCertResolver: null,
    previewDeploymentId: null,
    certificateType: 'none',
    internalPath: '/',
    stripPath: false,
    middlewares: [],
    forwardAuthEnabled: false,
    enabled: true,
    customEntrypoint: null,
    ...overrides,
  };
}

/**
 * Add an application to the fake Dokploy (as `application.create` does).
 * @param {ReturnType<typeof createFakePlatform>} platform
 * @param {{ name: string, appName?: string, environmentId: string, [key: string]: unknown }} fields
 */
export function seedApplication(platform, { name, appName, environmentId, ...fields }) {
  const created = {
    applicationId: platform.nextId('application'),
    name,
    appName: `${appName ?? 'app'}-x7k2q9`,
    environmentId,
    description: null,
    refreshToken: FAKE.refreshToken,
    env: null,
    buildArgs: null,
    buildSecrets: null,
    createEnvFile: true,
    sourceType: 'github',
    githubId: null,
    owner: null,
    repository: null,
    branch: null,
    buildPath: '/',
    triggerType: 'push',
    autoDeploy: true,
    watchPaths: null,
    enableSubmodules: false,
    customGitUrl: null,
    customGitBranch: null,
    customGitBuildPath: null,
    buildType: 'nixpacks',
    dockerfile: null,
    dockerContextPath: null,
    dockerBuildStage: null,
    dockerImage: null,
    replicas: 1,
    updateConfigSwarm: null,
    healthCheckSwarm: null,
    stopGracePeriodSwarm: null,
    args: null,
    command: null,
    mounts: [],
    domains: [],
    ports: [],
    ...fields,
  };
  platform.dokploy.applications.set(created.applicationId, created);
  return created;
}

/**
 * A Dokploy GitHub App provider and the repositories (`owner/name`) its installation can see.
 * @param {{ githubId?: string, name?: string, repositories?: string[] }} [fields]
 */
export function githubProvider({
  githubId = FAKE.githubId,
  name = FAKE.githubProviderName,
  repositories = [`${FAKE.githubOwner}/${FAKE.githubRepository}`, `${FAKE.githubOwner}/another-repository`],
} = {}) {
  return { githubId, name, repositories };
}

/**
 * The Cloudflare Access application that lets GitHub's push webhooks through
 * to the Dokploy panel: the webhook path with a Bypass (Everyone) policy.
 * @param {object} [overrides]
 */
export function webhookBypassApp(overrides = {}) {
  const uri = `${new URL(FAKE.dokployUrl).hostname}/api/deploy/github`;
  return {
    id: 'access-app-github-webhook',
    aud: 'aud-github-webhook',
    name: 'Dokploy GitHub webhook',
    type: 'self_hosted',
    domain: uri,
    destinations: [{ type: 'public', uri }],
    policies: [{ id: 'policy-github-webhook', name: 'github-webhook-bypass', decision: 'bypass', include: [{ everyone: {} }], precedence: 1 }],
    ...overrides,
  };
}

/**
 * Add the project and its production environment (as `project.create` does).
 * @param {ReturnType<typeof createFakePlatform>} platform
 * @returns {string} environmentId
 */
export function seedProject(platform) {
  const project = { projectId: platform.nextId('project'), name: 'content-radar', description: null, environments: [] };
  const environment = { environmentId: platform.nextId('environment'), name: 'production', projectId: project.projectId };
  project.environments.push(environment);
  platform.dokploy.projects.push(project);
  return environment.environmentId;
}

/**
 * The deployed app behind Access: anonymous requests are redirected to the
 * Access login; the service token reaches the API.
 */
export function defaultAppResponder({ path, headers, platform }) {
  const authorized = headers['cf-access-client-id'] === FAKE.clientId && headers['cf-access-client-secret'] === FAKE.clientSecret;
  if (!authorized) {
    return new Response(null, {
      status: 302,
      headers: { location: `https://${FAKE.authDomain}/cdn-cgi/access/login/${FAKE.hostname}?kid=abc&redirect_url=${encodeURIComponent(path)}` },
    });
  }
  if (path === '/api/health') {
    return json(200, {
      status: 'ok',
      version: 'test',
      time: '2026-10-03T12:00:00.000Z',
      runtime: { active: true, leased: true, leaseHolder: { id: platform.app.leaseHolderId, self: true, expiresAt: '2026-10-03T12:01:00.000Z' }, running: false, queued: 0, scheduledChannels: 0 },
      channelCount: 1,
    });
  }
  if (path === '/api/channels/telegram-main/status') {
    return json(200, { channelId: 'telegram-main', paused: true, cutoverRequired: true, notBefore: null, version: 1 });
  }
  if (path === '/api/channels/telegram-main') {
    return json(200, { id: 'telegram-main', createdAt: platform.app.channelCreatedAt, version: 1 });
  }
  return json(404, { error: 'not_found', message: 'Không tìm thấy.' });
}

/**
 * The origin as Traefik serves the deployed app over HTTPS: `/healthz` is
 * the app's "ok", and every other route the app's own 401 without an Access JWT.
 * @param {{ path: string }} request
 */
export async function defaultOriginProbe({ path }) {
  if (path === '/healthz') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'ok' };
  return { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' }, body: APP_401_JSON };
}

/** Output sink that keeps what was written. */
export function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

/**
 * Run the CLI against the fake platform with a fake clock and instant sleeps.
 * @param {string[]} argv
 * @param {{ platform: ReturnType<typeof createFakePlatform>, env?: object, stateDir?: string|null, randomBytes?: (size: number) => Buffer, probeOrigin?: Function }} options
 */
export async function runScript(argv, { platform, env = deployEnv(), stateDir = null, randomBytes, probeOrigin = defaultOriginProbe } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  let clock = Date.parse('2026-10-03T12:00:00.000Z');
  const firstCall = platform.calls.length;
  const code = await main(argv, {
    env,
    fetch: platform.fetch,
    stdout,
    stderr,
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
    probeOrigin,
    randomBytes,
    stateDir,
  });
  return {
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    output: `${stdout.text}\n${stderr.text}`,
    calls: platform.calls.slice(firstCall),
  };
}

/** @param {{ method: string }} call */
export function isMutating(call) {
  return call.method !== 'GET';
}

/** Calls that create a resource. */
export function isCreate(call) {
  if (call.service === 'dokploy') return ['project.create', 'application.create', 'mounts.create', 'domain.create'].includes(call.target);
  return call.service === 'cloudflare' && call.method === 'POST';
}

function push(list, item) {
  list.push(item);
  return item;
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function ok(result) {
  return json(200, { success: true, errors: [], messages: [], result });
}

function cloudflareError(status, code, message) {
  return json(status, { success: false, errors: [{ code, message }], messages: [], result: null });
}
