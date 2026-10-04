/**
 * Channel definitions — each channel is an independent engine configuration
 * All channel state derived from env at runtime
 */

import { bigTechBlogs, aiNewsSources, aiDeepDiveSources } from '../presets/index.js';
import { createAI } from '../ai/create-ai.js';
import { TelegramOutput, FacebookOutput } from '../outputs/index.js';
import { validateCronExpression } from './runner.js';

/** Map provider name → env var for API key */
const PROVIDER_KEY_MAP = {
  claude: 'ANTHROPIC_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY', google: 'GEMINI_API_KEY',
  qwen: 'QWEN_API_KEY', alibaba: 'QWEN_API_KEY', dashscope: 'QWEN_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  custom: 'CUSTOM_AI_API_KEY',
};

/** Audience string used by every built-in channel prompt. */
export const IT_AUDIENCE = 'nguoi lam IT Viet Nam: developers, engineers, product, data, security, operations, technical leaders';

/**
 * Helper: resolve env value (works for both CF env object and process.env)
 * @param {Object} env
 * @param {string} key
 * @param {string} [fallback]
 */
function e(env, key, fallback) { return env[key] ?? fallback; }

/** Parse a strict base-10 integer without accepting partial or ambiguous values. */
function eInt(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${key} must be a safe integer`);
  }
  return Number(value);
}

/**
 * Create AI plugin from env vars (shared logic extracted from both adapters)
 * @param {Object} env
 * @returns {import('../core/contracts.js').AIPlugin|null}
 */
function makeAI(env) {
  const provider = e(env, 'AI_PROVIDER', 'claude').toLowerCase();
  const keyEnv = PROVIDER_KEY_MAP[provider];
  const isGemini = provider === 'gemini' || provider === 'google';
  const gatewayValues = [
    env.CF_AIG_TOKEN,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.AI_GATEWAY_ID,
  ];
  const hasGatewayConfig = gatewayValues.some(value => String(value ?? '').trim());
  const hasCompleteGatewayConfig = gatewayValues.every(value => String(value ?? '').trim());
  const useGateway = isGemini && hasCompleteGatewayConfig;
  if (isGemini && hasGatewayConfig && !hasCompleteGatewayConfig) {
    throw new Error('Incomplete Cloudflare AI Gateway config: CF_AIG_TOKEN, CLOUDFLARE_ACCOUNT_ID, and AI_GATEWAY_ID are required');
  }
  if (!['ollama'].includes(provider) && !useGateway && (!keyEnv || !env[keyEnv])) {
    throw new Error(`Missing AI credential${keyEnv ? `: ${keyEnv}` : ` for provider ${provider}`}`);
  }
  if (provider === 'custom' && !env.CUSTOM_AI_BASE_URL) {
    throw new Error('Missing AI endpoint: CUSTOM_AI_BASE_URL');
  }
  return createAI({
    provider,
    model: e(env, 'AI_MODEL', undefined),
    apiKey: keyEnv ? env[keyEnv] : undefined,
    baseUrl: provider === 'ollama'
      ? e(env, 'OLLAMA_BASE_URL', undefined)
      : provider === 'custom' ? env.CUSTOM_AI_BASE_URL : undefined,
    name: provider === 'custom' ? e(env, 'CUSTOM_AI_NAME', undefined) : undefined,
    gateway: useGateway ? {
      token: env.CF_AIG_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID,
      byokAlias: e(env, 'AI_GATEWAY_BYOK_ALIAS', undefined),
    } : undefined,
  });
}

/**
 * Define all channels from env vars
 * @param {Object} env - Environment variables (process.env)
 * @returns {Array<import('./runner.js').ChannelConfig>}
 */
export function defineChannels(env) {
  const channels = [];

  // --- Telegram (tech blogs + AI news + AI deep-dives) ---
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    channels.push({
      id: 'telegram-main',
      sources: [...bigTechBlogs(), ...aiNewsSources(), ...aiDeepDiveSources()],
      ai: makeAI(env),
      output: new TelegramOutput({
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      }),
      prompt: {
        language: 'vi',
        style: 'digest',
        audience: IT_AUDIENCE,
        platform: 'telegram',
      },
      mode: e(env, 'BROADCAST_MODE', 'drip'),
      schedule: e(env, 'CRON_SCHEDULE', '0 1,7,13 * * *'),
      timezone: e(env, 'CRON_TIMEZONE', 'UTC'),
      batchSize: eInt(env, 'DRIP_BATCH_SIZE', 5),
      delayMs: eInt(env, 'DRIP_DELAY_MS', 0),
      dailyLimit: eInt(env, 'DRIP_DAILY_LIMIT', 18),
      maxArticles: eInt(env, 'MAX_ARTICLES', 12),
      maxArticlesPerSource: eInt(env, 'MAX_ARTICLES_PER_SOURCE', 3),
      concurrency: eInt(env, 'CONCURRENCY_LIMIT', 5),
    });
  }

  // --- Facebook Page — uncomment when Meta app review approved ---
  // Requires: FB_PAGE_TOKEN, FB_PAGE_ID
  if (env.FB_PAGE_TOKEN && env.FB_PAGE_ID) {
    channels.push({
      id: 'fb-ai-vn',
      sources: bigTechBlogs(),
      ai: makeAI(env),
      output: new FacebookOutput({ pageToken: env.FB_PAGE_TOKEN, pageId: env.FB_PAGE_ID }),
      prompt: { language: 'vi', style: 'digest', audience: IT_AUDIENCE, platform: 'facebook' },
      mode: 'drip',
      schedule: e(env, 'FB_CRON_SCHEDULE', '0 1,7,13 * * *'),
      timezone: e(env, 'FB_CRON_TIMEZONE', e(env, 'CRON_TIMEZONE', 'UTC')),
      batchSize: eInt(env, 'FB_BATCH_SIZE', 1),
      delayMs: 0,
      dailyLimit: 10,
      maxArticles: 10,
      maxArticlesPerSource: 3,
      concurrency: 5,
    });
  }

  return validateChannels(channels);
}

/** Validate channel identity and runtime contracts before any request is claimed. */
export function validateChannels(channels) {
  if (!Array.isArray(channels)) throw new Error('Channels must be an array');
  const ids = new Set();
  for (const channel of channels) {
    if (!channel || typeof channel.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(channel.id)) {
      throw new Error('Every channel requires a stable id');
    }
    if (ids.has(channel.id)) throw new Error(`Duplicate channel id: ${channel.id}`);
    ids.add(channel.id);
    if (!['digest', 'drip'].includes(channel.mode)) throw new Error(`Invalid mode for channel ${channel.id}`);
    if (!validateCronExpression(channel.schedule)) throw new Error(`Invalid cron schedule for channel ${channel.id}: ${channel.schedule}`);
    try { new Intl.DateTimeFormat('en', { timeZone: channel.timezone || 'UTC' }).format(); }
    catch { throw new Error(`Invalid timezone for channel ${channel.id}: ${channel.timezone}`); }
    if (!Array.isArray(channel.sources) || channel.sources.length === 0) throw new Error(`Channel ${channel.id} has no sources`);
    if (!channel.ai) throw new Error(`Channel ${channel.id} has no AI provider`);
    if (!channel.output) throw new Error(`Channel ${channel.id} has no output`);
    validateInteger(channel.concurrency, `Channel ${channel.id} concurrency`, 1, 50);
    validateInteger(channel.batchSize, `Channel ${channel.id} batchSize`, 1, 100);
    validateInteger(channel.delayMs, `Channel ${channel.id} delayMs`, 0, 3_600_000);
    validateInteger(channel.dailyLimit, `Channel ${channel.id} dailyLimit`, 1, 500);
    validateInteger(channel.maxArticles, `Channel ${channel.id} maxArticles`, 1, 500);
    validateInteger(channel.maxArticlesPerSource, `Channel ${channel.id} maxArticlesPerSource`, 1, 100);
  }
  return channels;
}

function validateInteger(value, label, minimum, maximum) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in range ${minimum}-${maximum}`);
  }
}
