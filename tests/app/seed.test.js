import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChannelFromConfig } from '../../src/app/channels/build-channel.js';
import { ChannelConflictError, ChannelRepository } from '../../src/app/channels/channel-repository.js';
import {
  SEED_CHANNEL_ID,
  SEED_PAUSE_REASON,
  seedDefaultChannels,
  telegramMainSeedConfig,
} from '../../src/app/channels/seed.js';
import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { IT_AUDIENCE, defineChannels } from '../../src/channels/definitions.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const SEEDED_AT = '2026-10-03T00:00:00.000Z';
const clock = () => new Date(SEEDED_AT);

async function setup(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir, now: new Date(SEEDED_AT) });
  const channels = new ChannelRepository({ storage: createNodeSqlStorage(db), clock });
  const pauses = [];
  const pauseChannel = async (channelId, context) => {
    pauses.push({ channelId, context, channelExisted: channels.get(channelId) !== null });
  };
  return { channels, pauses, pauseChannel };
}

function otherChannel(id) {
  return {
    id,
    name: id,
    mode: 'digest',
    cron: '0 9 * * *',
    sources: [{ type: 'preset', preset: 'devopsSources' }],
    prompt: { audience: 'IT' },
    ai: { provider: 'claude' },
  };
}

test('an empty database is seeded with a paused telegram-main', async t => {
  const { channels, pauses, pauseChannel } = await setup(t);

  const result = await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock });

  assert.deepEqual(result, { seeded: true, channelIds: [SEED_CHANNEL_ID] });
  assert.deepEqual(pauses, [{
    channelId: 'telegram-main',
    context: { operatorId: 'system-seed', reason: SEED_PAUSE_REASON },
    channelExisted: false,
  }]);
  assert.deepEqual(channels.list(), [{
    id: 'telegram-main',
    name: 'Telegram Main',
    enabled: true,
    platform: 'telegram',
    mode: 'drip',
    cron: '0 0-17 * * *',
    timezone: 'UTC',
    notBefore: null,
    sources: [
      { type: 'preset', preset: 'bigTechBlogs', enabled: true },
      { type: 'preset', preset: 'aiNewsSources', enabled: true },
      { type: 'preset', preset: 'aiDeepDiveSources', enabled: true },
    ],
    prompt: { language: 'vi', style: 'digest', audience: IT_AUDIENCE, customSystemPrompt: null },
    ai: {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      name: null,
      baseUrl: null,
      apiKeyCredentialId: null,
      gateway: {
        accountId: '6f23d177fcdb5209dfeb68a687ed306d',
        gatewayId: 'news-engine',
        byokAlias: null,
        tokenCredentialId: null,
      },
    },
    telegram: { botTokenCredentialId: null, chatIdCredentialId: null },
    limits: { batchSize: 1, delayMs: 0, dailyLimit: 18, maxArticles: 18, maxArticlesPerSource: 3, concurrency: 5 },
    cutoverRequired: true,
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    updatedBy: 'system-seed',
  }]);
});

test('the seeded channel keeps its cutover flag through updates; channels created otherwise never get it', async t => {
  const { channels, pauseChannel } = await setup(t);
  await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock });

  // Input cannot clear the flag, and setting notBefore leaves it in place.
  const updated = channels.update(SEED_CHANNEL_ID, { cutoverRequired: false, notBefore: '2026-10-03T00:00:00Z' }, { expectedVersion: 1, actor: 'ops@example.test' });
  assert.equal(updated.cutoverRequired, true);
  assert.equal(updated.notBefore, '2026-10-03T00:00:00.000Z');
  assert.equal(channels.update(SEED_CHANNEL_ID, { notBefore: null }, { expectedVersion: 2, actor: 'ops@example.test' }).cutoverRequired, true);

  // Input cannot set it either.
  const other = channels.create({ ...otherChannel('digest-weekly'), cutoverRequired: true }, { actor: 'ops@example.test' });
  assert.equal(other.cutoverRequired, false);
  assert.equal(channels.update('digest-weekly', { cutoverRequired: true }, { expectedVersion: 1, actor: 'ops@example.test' }).cutoverRequired, false);
  assert.throws(() => channels.create(otherChannel('flag-typo'), { actor: 'ops@example.test', cutoverRequired: 'yes' }), TypeError);
});

test('seeding is idempotent and never touches existing channels', async t => {
  const { channels, pauses, pauseChannel } = await setup(t);
  await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock });
  const edited = channels.update(SEED_CHANNEL_ID, { name: 'Edited by operator', enabled: false }, { expectedVersion: 1, actor: 'ops@example.test' });

  assert.deepEqual(await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock }), { seeded: false, channelIds: [] });
  assert.equal(pauses.length, 1);
  assert.deepEqual(channels.list(), [edited]);
});

test('a database that already has other channels is not seeded', async t => {
  const { channels, pauses, pauseChannel } = await setup(t);
  channels.create(otherChannel('digest-weekly'), { actor: 'ops@example.test' });

  assert.deepEqual(await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock }), { seeded: false, channelIds: [] });
  assert.deepEqual(pauses, []);
  assert.deepEqual(channels.list().map(channel => channel.id), ['digest-weekly']);
});

test('a failed pause creates nothing, so the next start seeds again', async t => {
  const { channels, pauses, pauseChannel } = await setup(t);
  await assert.rejects(
    seedDefaultChannels({
      channelRepository: channels,
      pauseChannel: async () => { throw new Error('delivery store unavailable'); },
      clock,
    }),
    /delivery store unavailable/,
  );
  assert.deepEqual(channels.list(), []);

  assert.equal((await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock })).seeded, true);
  assert.equal(pauses.length, 1);
});

test('a concurrent seed that wins the insert is treated as already seeded', async t => {
  const { channels, pauseChannel } = await setup(t);
  const racing = {
    list: () => [],
    create: () => { throw new ChannelConflictError('channel_exists', SEED_CHANNEL_ID); },
  };
  assert.deepEqual(await seedDefaultChannels({ channelRepository: racing, pauseChannel, clock }), { seeded: false, channelIds: [] });

  const failing = { list: () => [], create: () => { throw new Error('disk full'); } };
  await assert.rejects(seedDefaultChannels({ channelRepository: failing, pauseChannel, clock }), /disk full/);
  assert.deepEqual(channels.list(), []);
});

test('a custom actor is recorded on the pause and the channel', async t => {
  const { channels, pauses, pauseChannel } = await setup(t);
  await seedDefaultChannels({ channelRepository: channels, pauseChannel, actor: 'system-bootstrap', clock });
  assert.equal(pauses[0].context.operatorId, 'system-bootstrap');
  assert.equal(channels.get(SEED_CHANNEL_ID).updatedBy, 'system-bootstrap');
  await assert.rejects(seedDefaultChannels({ channelRepository: channels }), TypeError);
});

test('the seeded channel builds the same runtime channel as the Node CLI builds from the same settings', async () => {
  const seed = telegramMainSeedConfig();
  const fakeSecrets = { 'bot-token': '123456:FAKE-test-bot-token', 'chat-id': '-1001234567890', 'gateway-token': 'fake-gateway-token-for-tests' };
  const [cli] = defineChannels({
    AI_PROVIDER: seed.ai.provider,
    AI_MODEL: seed.ai.model,
    CLOUDFLARE_ACCOUNT_ID: seed.ai.gateway.accountId,
    AI_GATEWAY_ID: seed.ai.gateway.gatewayId,
    BROADCAST_MODE: seed.mode,
    CRON_SCHEDULE: seed.cron,
    SUMMARY_LANGUAGE: seed.prompt.language,
    DRIP_BATCH_SIZE: String(seed.limits.batchSize),
    DRIP_DELAY_MS: String(seed.limits.delayMs),
    MAX_ARTICLES: String(seed.limits.maxArticles),
    MAX_ARTICLES_PER_SOURCE: String(seed.limits.maxArticlesPerSource),
    CONCURRENCY_LIMIT: String(seed.limits.concurrency),
    TELEGRAM_BOT_TOKEN: fakeSecrets['bot-token'],
    TELEGRAM_CHAT_ID: fakeSecrets['chat-id'],
    CF_AIG_TOKEN: fakeSecrets['gateway-token'],
  });
  const seeded = await buildChannelFromConfig({
    ...seed,
    ai: { ...seed.ai, gateway: { ...seed.ai.gateway, tokenCredentialId: 'gateway-token' } },
    telegram: { botTokenCredentialId: 'bot-token', chatIdCredentialId: 'chat-id' },
  }, { resolveCredential: credentialId => fakeSecrets[credentialId] });

  assert.deepEqual(seeded.sources.map(source => source.sourceKey), cli.sources.map(source => source.sourceKey));
  assert.equal(seeded.ai.constructor, cli.ai.constructor);
  assert.deepEqual(seeded.ai._config, cli.ai._config);
  assert.equal(seeded.output.deliveryKey, cli.output.deliveryKey);
  assert.deepEqual(seeded.output._config, cli.output._config);
  assert.deepEqual(seeded.prompt, cli.prompt);
  for (const key of ['id', 'mode', 'schedule', 'timezone', 'batchSize', 'delayMs', 'dailyLimit', 'maxArticles', 'maxArticlesPerSource', 'concurrency']) {
    assert.equal(seeded[key], cli[key], key);
  }
  assert.equal(seeded.notBefore, null);
});

test('the seeded channel cannot run until its credentials are entered', async t => {
  const { channels, pauseChannel } = await setup(t);
  await seedDefaultChannels({ channelRepository: channels, pauseChannel, clock });
  await assert.rejects(
    buildChannelFromConfig(channels.get(SEED_CHANNEL_ID), { resolveCredential: () => 'unused' }),
    /missing required credentials: telegram\.botTokenCredentialId, telegram\.chatIdCredentialId, ai\.gateway\.tokenCredentialId/,
  );
});
