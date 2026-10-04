import test from 'node:test';
import assert from 'node:assert/strict';

import { defineChannels, validateChannels } from '../../src/channels/definitions.js';
import { aiMLBlogs, aiNewsSources } from '../../src/presets/index.js';

function validChannel(overrides = {}) {
  return {
    id: 'channel', mode: 'digest', schedule: '15 9 * * *', timezone: 'UTC',
    sources: [{}], ai: {}, output: {}, ...overrides,
  };
}

test('Telegram daily post limit defaults to 18 and follows DRIP_DAILY_LIMIT', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination', ANTHROPIC_API_KEY: 'key' };

  assert.equal(defineChannels(env)[0].dailyLimit, 18);
  assert.equal(defineChannels({ ...env, DRIP_DAILY_LIMIT: '9' })[0].dailyLimit, 9);
  assert.throws(() => defineChannels({ ...env, DRIP_DAILY_LIMIT: '0' }), /dailyLimit must be an integer in range 1-500/);
});

test('channel validation rejects daily limits outside the supported range', () => {
  assert.throws(() => validateChannels([validChannel({ dailyLimit: 501 })]), /dailyLimit/);
  assert.throws(() => validateChannels([validChannel({ dailyLimit: 1.5 })]), /dailyLimit/);
  assert.doesNotThrow(() => validateChannels([validChannel({ dailyLimit: 500 })]));
});

test('channel definitions fail missing AI credentials before runtime delivery', () => {
  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination', AI_PROVIDER: 'claude',
  }), /ANTHROPIC_API_KEY/);
});

test('Telegram defaults use a broad set of recognized AI sources', () => {
  const [channel] = defineChannels({
    TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination', ANTHROPIC_API_KEY: 'key',
  });
  const sourceIds = channel.sources.map(source => source.id);

  assert.equal(sourceIds.length, 28);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  assert.ok(!sourceIds.includes('reddit:singularity'), 'futurism subreddit is not a default tech source');
  for (const sourceId of [
    'openai', 'deepmind', 'huggingface',
    'wired-ai', 'mit-tech-review-ai', 'ieee-spectrum-ai',
  ]) {
    assert.ok(sourceIds.includes(sourceId), `missing default source: ${sourceId}`);
  }
  assert.ok(!sourceIds.includes('simonwillison'));
});

test('official AI feed configs remain isolated across preset instances', () => {
  const mlOpenAI = aiMLBlogs().find(source => source.id === 'openai');
  const newsOpenAI = aiNewsSources().find(source => source.id === 'openai');

  assert.notStrictEqual(mlOpenAI._config, newsOpenAI._config);
  mlOpenAI._config.feedUrl = 'https://example.com/changed-feed.xml';
  assert.equal(newsOpenAI._config.feedUrl, 'https://openai.com/blog/rss.xml');
});

test('channel validation rejects duplicate IDs, invalid cron, and invalid timezones', () => {
  assert.throws(() => validateChannels([validChannel(), validChannel()]), /duplicate/i);
  assert.throws(() => validateChannels([validChannel({ schedule: '75 9 * * *' })]), /cron/i);
  assert.throws(() => validateChannels([validChannel({ timezone: 'Not/A-Timezone' })]), /timezone/i);
});

test('channel validation rejects unsafe numeric runtime bounds', () => {
  for (const overrides of [
    { concurrency: -1 },
    { concurrency: 0 },
    { concurrency: 1.5 },
    { batchSize: -1 },
    { delayMs: -1 },
    { maxArticles: 0 },
    { maxArticlesPerSource: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => validateChannels([validChannel(overrides)]), /invalid|must|range/i);
  }

  assert.throws(() => defineChannels({
    TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: 'destination',
    ANTHROPIC_API_KEY: 'key', CONCURRENCY_LIMIT: '5oops',
  }), /CONCURRENCY_LIMIT/);
});
