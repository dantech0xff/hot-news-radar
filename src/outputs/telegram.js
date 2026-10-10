/**
 * Output Plugin: Telegram
 */

import { OutputPlugin } from '../core/contracts.js';
import {
  createOutputDependencies,
  destinationDeliveryKey,
  exceptionFailureResult,
  fetchWithTimeout,
  httpFailureResult,
  invalidResponseResult,
  normalizeMessageId,
  partResult,
  readResponseBody,
  successResult,
  withPartialMutation,
} from './telegram-client.js';

const CAPTION_MAX = 1024;
const NEWS_CAPTION_MAX = 700;

/**
 * Telegram downloads a photo URL itself before it answers, so a slow image host can hold one request
 * open well past the shared 15 s default. A request cut off at its timeout may still have been posted;
 * that outcome is ambiguous and blocks the channel until an operator reconciles it, so wait longer
 * before giving up. Must stay below the engine's output budget (`DEFAULT_OUTPUT_TIMEOUT_MS`).
 */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 45_000;

export class TelegramOutput extends OutputPlugin {
  /**
   * @param {Object} config
   * @param {string} config.botToken
   * @param {string} config.chatId
   * @param {boolean} [config.disablePreview=true]
   * @param {boolean} [config.silent=false]
   * @param {Function} [config.fetch] - Injectable fetch transport
   * @param {number} [config.timeoutMs=45000]
   * @param {Object} [dependencies] - Optional injected fetch/clock/timers
   */
  constructor(config, dependencies = {}) {
    super();
    this._config = { disablePreview: true, silent: false, ...config };
    this._dependencies = createOutputDependencies(
      { ...config, timeoutMs: config.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS },
      dependencies,
    );
    this._deliveryKey = destinationDeliveryKey('telegram', config.chatId, config.deliveryKey);
  }

  get id() { return 'telegram'; }
  get name() { return 'Telegram'; }
  get supportsSingleMutation() { return true; }
  get maxLength() { return 4096; }
  get deliveryKey() { return this._deliveryKey; }

  async send(content, options = {}) {
    if (options.singleMutation === true) {
      if (content.length > this.maxLength) {
        return {
          success: false,
          error: 'Single-mutation content exceeds Telegram message limit',
          meta: {
            deliveryState: 'definitive_failure',
            retryDisposition: 'never',
            providerCode: 'content_too_long',
            sanitizedError: 'Single-mutation content exceeds Telegram message limit',
          },
        };
      }
      return this._request('sendMessage', {
        chat_id: this._config.chatId,
        text: stripMarkdown(content),
        disable_web_page_preview: this._config.disablePreview,
        disable_notification: this._config.silent,
      }, options.signal);
    }
    const imageUrl = options.article?.imageUrl
      || options.articles?.[0]?.imageUrl
      || null;

    if (imageUrl) {
      const photoContent = options.article
        ? fitNewsCaption(content, options.article.url, NEWS_CAPTION_MAX)
        : content;
      return this._sendWithPhoto(
        photoContent,
        imageUrl,
        options.signal,
        options.article ? NEWS_CAPTION_MAX : CAPTION_MAX,
      );
    }

    return this._sendTextOnly(content, options.signal);
  }

  async _sendTextOnly(content, signal) {
    const messages = splitSmart(content, this.maxLength);
    const successfulMessageIds = [];
    const partResults = [];
    let fallbackAttempted = false;

    for (let i = 0; i < messages.length; i++) {
      const result = await this._sendOne(
        i > 0 ? `(${i + 1}/${messages.length})\n\n${messages[i]}` : messages[i],
        i > 0,
        signal,
      );
      fallbackAttempted ||= result.meta?.fallbackAttempted === true;
      partResults.push(partResult(i + 1, result));

      if (!result.success) {
        const metadata = {
          ...result.meta,
          parts: messages.length,
          partsAttempted: partResults.length,
          partsTotal: messages.length,
          failedAt: i + 1,
          partResults,
          ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
        };

        if (successfulMessageIds.length > 0) {
          return withPartialMutation({ ...result, meta: metadata }, {
            successfulMessageIds,
            completedSteps: successfulMessageIds.length,
            totalSteps: messages.length,
            failedStep: i + 1,
            partResults,
            parts: messages.length,
          });
        }

        return { ...result, meta: metadata };
      }

      if (result.messageId) successfulMessageIds.push(result.messageId);
      if (i < messages.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      parts: messages.length,
      partsAttempted: messages.length,
      partsTotal: messages.length,
      successfulMessageIds,
      partResults,
      ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
    });
  }

  async _sendWithPhoto(content, imageUrl, signal, captionMax = CAPTION_MAX) {
    if (content.length <= captionMax) {
      const result = await this._sendPhoto(imageUrl, content, signal);
      if (result.success) {
        return successResult(result.messageId, {
          ...result.meta,
          hasPhoto: true,
          successfulMessageIds: result.messageId ? [result.messageId] : [],
        });
      }

      if (!isDefinitiveContentRejection(result)) {
        return {
          ...result,
          meta: { ...result.meta, photoAttempted: true },
        };
      }

      const fallback = await this._sendTextOnly(content, signal);
      return {
        ...fallback,
        meta: {
          ...fallback.meta,
          fallbackAttempted: true,
          photoAttempted: true,
          hasPhoto: false,
        },
      };
    }

    const messages = splitSmart(content, this.maxLength);
    const totalSteps = messages.length + 1;
    const photoResult = await this._sendPhoto(imageUrl, null, signal);

    if (!photoResult.success) {
      if (isDefinitiveContentRejection(photoResult)) {
        const fallback = await this._sendTextOnly(content, signal);
        return {
          ...fallback,
          meta: {
            ...fallback.meta,
            fallbackAttempted: true,
            photoAttempted: true,
            hasPhoto: false,
          },
        };
      }

      return {
        ...photoResult,
        meta: {
          ...photoResult.meta,
          parts: totalSteps,
          partsAttempted: 1,
          partsTotal: totalSteps,
          failedAt: 1,
          photoAttempted: true,
          partResults: [partResult(1, photoResult, 'photo')],
        },
      };
    }

    const successfulMessageIds = photoResult.messageId ? [photoResult.messageId] : [];
    const partResults = [partResult(1, photoResult, 'photo')];
    let fallbackAttempted = false;
    await this._dependencies.sleep(300);

    for (let i = 0; i < messages.length; i++) {
      const result = await this._sendOne(
        i > 0 ? `(${i + 1}/${messages.length})\n\n${messages[i]}` : messages[i],
        i > 0,
        signal,
      );
      const step = i + 2;
      fallbackAttempted ||= result.meta?.fallbackAttempted === true;
      partResults.push(partResult(step, result));

      if (!result.success) {
        const partial = withPartialMutation(result, {
          successfulMessageIds,
          completedSteps: successfulMessageIds.length,
          totalSteps,
          failedStep: step,
          partResults,
          parts: totalSteps,
        });
        return {
          ...partial,
          meta: {
            ...partial.meta,
            hasPhoto: true,
            ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
          },
        };
      }

      if (result.messageId) successfulMessageIds.push(result.messageId);
      if (i < messages.length - 1) await this._dependencies.sleep(500);
    }

    return successResult(successfulMessageIds[0], {
      parts: totalSteps,
      partsAttempted: totalSteps,
      partsTotal: totalSteps,
      hasPhoto: true,
      successfulMessageIds,
      partResults,
      ...(fallbackAttempted ? { fallbackAttempted: true } : {}),
    });
  }

  async _sendPhoto(photoUrl, caption, signal) {
    const body = {
      chat_id: this._config.chatId,
      photo: photoUrl,
      disable_notification: this._config.silent,
    };
    if (caption) {
      body.caption = caption;
      body.parse_mode = 'Markdown';
    }

    const result = await this._request('sendPhoto', body, signal);
    if (!caption || result.success || !isDefinitiveFormatRejection(result)) return result;

    body.caption = stripMarkdown(caption);
    delete body.parse_mode;
    const fallback = await this._request('sendPhoto', body, signal);
    return {
      ...fallback,
      meta: { ...fallback.meta, fallbackAttempted: true },
    };
  }

  async _sendOne(text, forceQuiet = false, signal) {
    const body = {
      chat_id: this._config.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: this._config.disablePreview,
      disable_notification: forceQuiet || this._config.silent,
    };
    const result = await this._request('sendMessage', body, signal);
    if (result.success || !isDefinitiveFormatRejection(result)) return result;
    return this._sendPlain(text, forceQuiet, signal);
  }

  async _sendPlain(text, forceQuiet, signal) {
    const result = await this._request('sendMessage', {
      chat_id: this._config.chatId,
      text: stripMarkdown(text),
      disable_web_page_preview: this._config.disablePreview,
      disable_notification: forceQuiet || this._config.silent,
    }, signal);
    return {
      ...result,
      meta: { ...result.meta, fallbackAttempted: true },
    };
  }

  async _request(method, body, signal) {
    const url = `https://api.telegram.org/bot${this._config.botToken}/${method}`;

    try {
      // Never follow a redirect: one request is one hop, which is what lets a failed connect count
      // as "never sent" (see `exceptionFailureResult`). A 3xx answer is classified as uncertain.
      const response = await fetchWithTimeout(this._dependencies.fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      }, this._dependencies);
      const parsed = await readResponseBody(response);
      const data = parsed.data;

      if (response?.ok && parsed.validJson && data?.ok === true) {
        const messageId = normalizeMessageId(data.result?.message_id);
        return messageId
          ? successResult(messageId)
          : invalidResponseResult('Telegram', { now: this._dependencies.now });
      }

      if (parsed.validJson && data?.ok === false) {
        const responseStatus = Number(response?.status);
        const providerStatus = Number(data.error_code);
        const status = responseStatus >= 400 ? responseStatus : providerStatus || responseStatus;
        const description = data.description || `Telegram rejected ${method}`;
        return httpFailureResult({
          status,
          headers: response?.headers,
          error: description,
          providerCode: data.error_code || status,
          retryAfterMs: Number.isFinite(Number(data.parameters?.retry_after))
            ? Number(data.parameters.retry_after) * 1000
            : undefined,
          now: this._dependencies.now,
          meta: isFormatRejection(description) ? { reasonCode: 'format_rejected' } : undefined,
        });
      }

      if (!response?.ok) {
        return httpFailureResult({
          status: response?.status,
          headers: response?.headers,
          error: parsed.readError || parsed.text || `Telegram HTTP ${response?.status}`,
          providerCode: response?.status,
          now: this._dependencies.now,
        });
      }

      return invalidResponseResult('Telegram', { now: this._dependencies.now });
    } catch (error) {
      return exceptionFailureResult(error, { now: this._dependencies.now, singleHop: true });
    }
  }
}

function splitSmart(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      parts.push(remaining);
      break;
    }
    let cut = max;
    const separator = remaining.lastIndexOf('━━━', max);
    if (separator > max * 0.5) cut = separator;
    else {
      const newline = remaining.lastIndexOf('\n\n', max);
      if (newline > max * 0.5) cut = newline;
    }
    parts.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return parts;
}

function isDefinitiveFormatRejection(result) {
  return result.meta?.deliveryState === 'definitive_failure'
    && result.meta?.retryDisposition === 'never'
    && result.meta?.reasonCode === 'format_rejected';
}

function isDefinitiveContentRejection(result) {
  return result.meta?.deliveryState === 'definitive_failure'
    && result.meta?.retryDisposition === 'never';
}

function isFormatRejection(description) {
  return /parse|entit(?:y|ies)/i.test(String(description || ''));
}

function stripMarkdown(text) {
  return text
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function fitNewsCaption(content, sourceUrl, maxLength) {
  const url = String(sourceUrl ?? '').trim();
  const text = String(content ?? '').trim();
  if (!url) return text;
  const bodyWithoutUrl = url ? removeSourceUrl(text, url) : text;
  const body = limitNewsSummarySentences(bodyWithoutUrl)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const suffix = url ? `\n\n${url}` : '';
  if (`${body}${suffix}`.length <= maxLength) return `${body}${suffix}`;

  const available = maxLength - suffix.length;
  if (available <= 1) return `${body}${suffix}`;

  let clipped = body.substring(0, available - 1).trimEnd();
  const sentenceBoundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('\n\n'),
  );
  if (sentenceBoundary >= Math.floor(available * 0.55)) {
    clipped = clipped.substring(0, sentenceBoundary + 1).trimEnd();
  }
  if (!/[.!?…]$/.test(clipped)) clipped = `${clipped}…`;
  return `${clipped.substring(0, available)}${suffix}`;
}

function removeSourceUrl(text, url) {
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`\\[[^\\]]*\\]\\(${escapedUrl}\\)`, 'g'), '')
    .split(url)
    .join('');
}

function limitNewsSummarySentences(body) {
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  let title;
  let summary;
  if (lines.length >= 2) {
    [title] = lines;
    summary = lines.slice(1).join(' ');
  } else {
    const inline = body.trim().match(/^(\*[^*]+\*)\s+(.+)$/s);
    if (!inline) return body;
    [, title, summary] = inline;
  }
  const sentences = summary.match(/[^.!?…]+(?:[.!?…]+|$)/gu)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) ?? [];
  if (sentences.length <= 3) return `${title}\n\n${summary}`;
  return `${title}\n\n${sentences.slice(0, 3).join(' ')}`;
}
