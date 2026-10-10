import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TelegramOutput } from '../../src/outputs/telegram.js';
import { jsonResponse, noDelay, sequenceFetch, textResponse } from './test-helpers.js';

const config = { botToken: '123456:test-token', chatId: '-1001234567890', sleep: noDelay };

function telegram(responses) {
  const transport = sequenceFetch(responses);
  return { transport, output: new TelegramOutput({ ...config, fetch: transport.fetch }) };
}

test('notify posts a plain-text message to the given chat through the channel bot', async () => {
  const { transport, output } = telegram([jsonResponse(200, { ok: true, result: { message_id: 5 } })]);

  assert.equal(await output.notify('123456789', 'Kênh bị chặn *không* phải markdown_'), true);

  const [call] = transport.calls;
  assert.match(call.url, /\/sendMessage$/);
  assert.equal(call.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(call.init.body), {
    chat_id: '123456789',
    text: 'Kênh bị chặn *không* phải markdown_',
    disable_web_page_preview: true,
  });
});

test('notify never posts into the output own chat', async () => {
  const { transport, output } = telegram([]);

  assert.equal(await output.notify('-1001234567890', 'alert'), false);
  assert.equal(await output.notify(-1001234567890, 'alert'), false);
  assert.equal(transport.calls.length, 0);
});

test('notify reports failure instead of throwing', async () => {
  for (const response of [
    jsonResponse(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
    jsonResponse(200, { ok: false, description: 'odd' }),
    textResponse(502, 'bad gateway'),
    textResponse(307, '', { Location: 'https://elsewhere.example/' }),
    () => { throw new TypeError('fetch failed'); },
  ]) {
    const { output } = telegram([response]);
    assert.equal(await output.notify('123456789', 'alert'), false);
  }
});

test('notify keeps the text within the Telegram message limit', async () => {
  const { transport, output } = telegram([jsonResponse(200, { ok: true, result: { message_id: 6 } })]);

  await output.notify('123456789', 'x'.repeat(5_000));

  assert.equal(JSON.parse(transport.calls[0].init.body).text.length, 4_096);
});
