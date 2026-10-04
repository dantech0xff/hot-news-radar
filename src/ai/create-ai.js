/**
 * Shared AI factory — single source of truth for creating AI plugins
 * Used by the Node CLI and the dashboard app
 */

import { ClaudeAI } from './claude.js';
import {
  OpenAICompatibleAI, openai, groq, gemini, geminiGateway, qwen,
  deepseek, ollama, openRouter, togetherAI,
} from './openai-compat.js';

/**
 * Create AI plugin from provider config
 * Each adapter maps its own env format to this config shape
 *
 * @param {Object} config
 * @param {string} [config.provider='claude'] - Provider name
 * @param {string} [config.model]             - Model override
 * @param {string} [config.apiKey]            - API key for the chosen provider
 * @param {string} [config.baseUrl]           - Custom base URL (for 'custom' provider)
 * @param {string} [config.name]              - Custom display name (for 'custom' provider)
 * @param {Object} [config.gateway]           - Cloudflare AI Gateway BYOK config
 * @returns {import('../core/contracts.js').AIPlugin|null}
 */
export function createAI(config) {
  const { provider = 'claude', model, apiKey, baseUrl, name, gateway } = config;

  switch (provider.toLowerCase()) {
    case 'none':
    case 'off':
    case 'skip':
      return null;

    case 'claude':
    case 'anthropic':
      return new ClaudeAI({ apiKey, ...(model && { model }) });

    case 'openai':
      return openai(apiKey, model || 'gpt-4o-mini');

    case 'groq':
      return groq(apiKey, model || 'llama-3.3-70b-versatile');

    case 'gemini':
    case 'google':
      if (gateway) {
        return geminiGateway({
          ...gateway,
          model: model || 'gemini-2.0-flash',
        });
      }
      return gemini(apiKey, model || 'gemini-2.0-flash');

    case 'qwen':
    case 'alibaba':
    case 'dashscope':
      return qwen(apiKey, model || 'qwen-plus');

    case 'deepseek':
      return deepseek(apiKey, model || 'deepseek-chat');

    case 'ollama':
      return ollama(model || 'llama3.2', baseUrl || 'http://localhost:11434/v1');

    case 'openrouter':
      return openRouter(apiKey, model || 'anthropic/claude-3.5-sonnet');

    case 'together':
      return togetherAI(apiKey, model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo');

    case 'custom':
      return new OpenAICompatibleAI({
        apiKey,
        baseUrl,
        model: model || 'default',
        name: name || 'Custom AI',
      });

    default:
      throw new Error(`Unknown AI provider: "${provider}"\nSupported: claude, openai, groq, gemini, qwen, deepseek, ollama, openrouter, together, custom`);
  }
}
