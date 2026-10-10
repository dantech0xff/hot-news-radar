import test from 'node:test';
import assert from 'node:assert/strict';

import { BlockedChannelAlerts } from '../../src/app/runtime/alerts.js';

const block = {
  channelId: 'telegram-main',
  attemptId: 'attempt-1',
  article: { title: 'Deno is joining Cloudflare', url: 'https://blog.example.com/deno' },
};

function channelThatNotifies(outcome = () => true) {
  const sent = [];
  const output = {
    async notify(chatId, text) {
      sent.push({ chatId, text });
      return outcome(sent.length);
    },
  };
  return { channel: { output, outputs: [output] }, sent };
}

const quiet = { warn() {} };

test('a blocked channel is reported once per blocking attempt, and a new block reports again', async () => {
  const alerts = new BlockedChannelAlerts({ chatId: '123456789', logger: quiet });
  const { channel, sent } = channelThatNotifies();

  assert.equal(await alerts.channelBlocked(channel, block), true);
  assert.equal(await alerts.channelBlocked(channel, block), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, '123456789');
  assert.match(sent[0].text, /telegram-main/);
  assert.match(sent[0].text, /Deno is joining Cloudflare https:\/\/blog\.example\.com\/deno/);
  assert.match(sent[0].text, /Xác nhận đã gửi/);

  assert.equal(await alerts.channelBlocked(channel, { ...block, attemptId: 'attempt-2' }), true);
  assert.equal(sent.length, 2);
});

test('a failed alert is tried again on the next run and never throws', async () => {
  const warnings = [];
  const alerts = new BlockedChannelAlerts({ chatId: '123456789', logger: { warn: message => warnings.push(message) } });
  const { channel, sent } = channelThatNotifies(call => {
    if (call === 2) throw new TypeError('fetch failed');
    return call === 3;
  });

  assert.equal(await alerts.channelBlocked(channel, block), false);
  assert.equal(await alerts.channelBlocked(channel, block), false);
  assert.equal(await alerts.channelBlocked(channel, block), true);
  assert.equal(await alerts.channelBlocked(channel, block), false);

  assert.equal(sent.length, 3);
  assert.equal(warnings.length, 2);
});

test('nothing is sent without a chat id or without an output that can notify', async () => {
  const off = new BlockedChannelAlerts({ logger: quiet });
  const { channel, sent } = channelThatNotifies();
  assert.equal(off.enabled, false);
  assert.equal(await off.channelBlocked(channel, block), false);
  assert.equal(sent.length, 0);

  const on = new BlockedChannelAlerts({ chatId: '123456789', logger: quiet });
  assert.equal(on.enabled, true);
  assert.equal(await on.channelBlocked({ output: {}, outputs: [{}] }, block), false);
});

test('the alert text is bounded and still makes sense without an article', async () => {
  const alerts = new BlockedChannelAlerts({ chatId: '123456789', logger: quiet });
  const long = channelThatNotifies();
  await alerts.channelBlocked(long.channel, {
    ...block,
    article: { title: `line one\nline two ${'x'.repeat(2_000)}`, url: block.article.url },
  });
  assert.ok(long.sent[0].text.length < 700);
  assert.doesNotMatch(long.sent[0].text, /undefined/);

  const bare = channelThatNotifies();
  await alerts.channelBlocked(bare.channel, { channelId: 'telegram-main', attemptId: 'attempt-9', article: null });
  assert.doesNotMatch(bare.sent[0].text, /Bài:|undefined|null/);
});
