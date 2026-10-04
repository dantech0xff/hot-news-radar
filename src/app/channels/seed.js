/**
 * First-start seed: when the database has no channels, create `telegram-main`
 * with the production settings of the retired Cloudflare Worker's channel
 * (the same sources, prompt, AI, schedule, and limits `defineChannels()` builds
 * for the Node CLI), paused and without credentials. Operators enter
 * credentials and resume the channel at the cutover gate.
 *
 * The seeded channel is marked `cutoverRequired`: it cannot be resumed (or
 * otherwise start delivering) until its `notBefore` cutover instant is set,
 * so nothing published before the cutover is posted.
 */

import { IT_AUDIENCE } from '../../channels/definitions.js';
import { ChannelConflictError } from './channel-repository.js';

export const SEED_CHANNEL_ID = 'telegram-main';
export const SEED_PAUSE_REASON = 'Seeded channel starts paused until an operator resumes it';

/** @returns {import('./config-schema.js').ChannelConfig} A fresh copy of the seeded channel config. */
export function telegramMainSeedConfig() {
  return {
    id: SEED_CHANNEL_ID,
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
  };
}

/**
 * Seed `telegram-main` when no channel exists; never touches existing ones.
 *
 * The delivery-state pause runs before the channel row is written, so a crash
 * or failure between the two steps can never leave a seeded channel unpaused:
 * the next start finds no channels and repeats both steps. `pauseChannel`
 * must therefore work before the row exists and succeed when the channel is
 * already paused.
 *
 * @param {{
 *   channelRepository: import('./channel-repository.js').ChannelRepository,
 *   pauseChannel: (channelId: string, context: { operatorId: string, reason: string }) => unknown,
 *   actor?: string,
 *   clock?: () => Date,
 * }} options
 * @returns {Promise<{ seeded: boolean, channelIds: string[] }>}
 */
export async function seedDefaultChannels({
  channelRepository,
  pauseChannel,
  actor = 'system-seed',
  clock = () => new Date(),
} = {}) {
  if (typeof channelRepository?.list !== 'function' || typeof channelRepository.create !== 'function') {
    throw new TypeError('seedDefaultChannels requires a channel repository');
  }
  if (typeof pauseChannel !== 'function') throw new TypeError('seedDefaultChannels requires pauseChannel');
  if (typeof clock !== 'function') throw new TypeError('seedDefaultChannels clock must be a function');

  if (channelRepository.list().length > 0) return { seeded: false, channelIds: [] };

  await pauseChannel(SEED_CHANNEL_ID, { operatorId: actor, reason: SEED_PAUSE_REASON });
  try {
    channelRepository.create(telegramMainSeedConfig(), { actor, now: clock(), cutoverRequired: true });
  } catch (error) {
    // Another process seeded between the emptiness check and the insert.
    if (error instanceof ChannelConflictError && error.code === 'channel_exists') return { seeded: false, channelIds: [] };
    throw error;
  }
  return { seeded: true, channelIds: [SEED_CHANNEL_ID] };
}
