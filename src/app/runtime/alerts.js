/**
 * Alert for a channel that cannot send until a person acts.
 *
 * The engine reports a channel whose ambiguous send it could not confirm on its own
 * (`onChannelBlocked`). This sends one short Telegram message per blocking attempt to an operator chat
 * through the channel's own bot. It is off unless `ALERT_TELEGRAM_CHAT_ID` is set, and best effort: a
 * failed alert is logged and tried again on the next run, and never affects delivery.
 */

import { sanitizeRuntimeError } from '../../channels/runner.js';

const MAX_TITLE_LENGTH = 200;

export class BlockedChannelAlerts {
  /** @param {{ chatId?: string|null, logger?: Pick<Console, 'warn'> }} [options] */
  constructor({ chatId = null, logger = console } = {}) {
    this._chatId = chatId || null;
    this._logger = logger;
    /** Channel id to the blocking attempt already reported, so a long block alerts once. */
    this._alerted = new Map();
  }

  get enabled() { return this._chatId !== null; }

  /**
   * @param {{ output?: object, outputs?: object[] }} channel The built channel; its Telegram output sends the alert.
   * @param {{ channelId: string, attemptId: string, article?: { title?: string, url?: string }|null }} block
   * @returns {Promise<boolean>} true when an alert was delivered now
   */
  async channelBlocked(channel, block) {
    if (!this.enabled || this._alerted.get(block.channelId) === block.attemptId) return false;
    const notifier = (channel.outputs ?? [channel.output]).find(output => typeof output?.notify === 'function');
    if (!notifier) return false;
    try {
      const sent = await notifier.notify(this._chatId, alertText(block));
      if (sent) this._alerted.set(block.channelId, block.attemptId);
      else this._logger.warn?.(`[Alerts] ${block.channelId}: the blocked-channel alert was not delivered`);
      return sent;
    } catch (error) {
      this._logger.warn?.(`[Alerts] ${block.channelId}: could not send the blocked-channel alert: ${sanitizeRuntimeError(error)}`);
      return false;
    }
  }
}

function alertText({ channelId, article }) {
  const lines = [`⚠️ Kênh ${channelId} đang bị chặn: một lần gửi không rõ kết quả và app không tự xác nhận được.`];
  if (article?.url) {
    const title = String(article.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
    lines.push(`Bài: ${title ? `${title} ` : ''}${article.url}`);
  }
  lines.push('Mở dashboard → Queue & vận hành: chọn "Xác nhận đã gửi" nếu bài đã có trên kênh, hoặc "Gửi lại" nếu chưa.');
  return lines.join('\n');
}
