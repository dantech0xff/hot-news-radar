import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TelegramOutput } from '../../src/outputs/telegram.js';
import {
  comparableLink,
  findPostByLink,
  isPublicUsername,
  parsePreviewMessages,
} from '../../src/outputs/telegram-preview.js';
import { jsonResponse, noDelay, sequenceFetch, textResponse } from './test-helpers.js';

const USERNAME = 'radar_news';
const ARTICLE = 'https://blog.example.com/posts/launch';
const SINCE = new Date('2026-10-10T12:00:00.000Z');

function message({ id, time = '2026-10-10T12:00:05+00:00', links = [ARTICLE], text = 'Tin moi' }) {
  const anchors = links.map(link => ` <a href="${link.replace(/&/g, '&amp;')}" target="_blank" rel="noopener">${link}</a>`).join('');
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${USERNAME}/${id}" data-view="abc">`
    + `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}${anchors}</div>`
    + `<div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/${USERNAME}/${id}"><time datetime="${time}" class="time">20:00</time></a></div></div></div>`;
}

const page = (...messages) => `<html><body><section>${messages.join('')}</section></body></html>`;
const htmlResponse = html => textResponse(200, html, { 'Content-Type': 'text/html; charset=utf-8' });

function findWith(responses, overrides = {}) {
  const transport = sequenceFetch(responses);
  const promise = findPostByLink({
    username: USERNAME,
    url: ARTICLE,
    since: SINCE,
    fetchImpl: transport.fetch,
    dependencies: { sleep: noDelay },
    ...overrides,
  });
  return { transport, promise };
}

test('links compare by page, ignoring scheme, www, fragment, tracking query, and trailing slash', () => {
  const canonical = comparableLink('https://blog.example.com/posts/launch');
  assert.equal(comparableLink('http://www.Blog.Example.com/posts/launch/'), canonical);
  assert.equal(comparableLink('https://blog.example.com/posts/launch?utm_source=x&utm_medium=y#top'), canonical);
  assert.notEqual(comparableLink('https://blog.example.com/posts/other'), canonical);
  assert.notEqual(comparableLink('https://blog.example.com/posts/launch?id=2'), canonical);
  assert.equal(comparableLink('not a url'), null);
  assert.equal(comparableLink('ftp://blog.example.com/posts/launch'), null);
});

test('only well-formed public usernames are accepted', () => {
  assert.equal(isPublicUsername('radar_news'), true);
  for (const bad of ['', 'abc', '1radar', 'radar news', 'radar/news', '../etc', null, undefined, 'a'.repeat(33)]) {
    assert.equal(isPublicUsername(bad), false, String(bad));
  }
});

test('a preview page yields id, time, and outside links for the channel own posts only', () => {
  const html = page(
    message({ id: 10, links: ['https://a.example.com/x?p=1&q=2', 'https://t.me/someone/5', 'https://telegram.org/faq'] }),
    message({ id: 11, time: 'not a date' }),
    message({ id: 12 }).replace(`${USERNAME}/12`, 'other_channel/12'),
  );

  assert.deepEqual(parsePreviewMessages(html, USERNAME), [
    { id: 10, time: Date.parse('2026-10-10T12:00:05+00:00'), links: ['https://a.example.com/x?p=1&q=2'] },
  ]);
  assert.deepEqual(parsePreviewMessages('', USERNAME), []);
});

test('finds the post that carries the article link and reports its message id', async () => {
  const { transport, promise } = findWith([htmlResponse(page(
    message({ id: 40, links: ['https://other.example.com/a'] }),
    message({ id: 41 }),
  ))]);

  assert.deepEqual(await promise, { messageId: '41' });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, `https://t.me/s/${USERNAME}`);
  assert.equal(transport.calls[0].init.method, 'GET');
  assert.equal(transport.calls[0].init.redirect, 'manual');
});

test('matches a link that differs only in tracking parameters and trailing slash', async () => {
  const { promise } = findWith([htmlResponse(page(
    message({ id: 7, links: [`${ARTICLE}/?utm_source=feed`] }),
  ))]);

  assert.deepEqual(await promise, { messageId: '7' });
});

test('ignores a post of the same link that was published before the attempt began', async () => {
  const { promise } = findWith([htmlResponse(page(
    message({ id: 3, time: '2026-10-10T11:00:00+00:00' }),
  ))]);

  assert.equal(await promise, null);
});

test('tolerates a small clock difference between Telegram and this process', async () => {
  const within = findWith([htmlResponse(page(message({ id: 5, time: '2026-10-10T11:58:30+00:00' })))]);
  const beyond = findWith([htmlResponse(page(message({ id: 5, time: '2026-10-10T11:56:00+00:00' })))]);

  assert.deepEqual(await within.promise, { messageId: '5' });
  assert.equal(await beyond.promise, null);
});

test('reports the earliest of several matching posts', async () => {
  const { promise } = findWith([htmlResponse(page(
    message({ id: 52, time: '2026-10-10T12:30:00+00:00' }),
    message({ id: 50 }),
    message({ id: 51, time: '2026-10-10T12:10:00+00:00' }),
  ))]);

  assert.deepEqual(await promise, { messageId: '50' });
});

test('keeps paging back while the page is still newer than the attempt, and stops once it passes it', async () => {
  const newer = page(
    message({ id: 30, links: ['https://x.example.com/1'], time: '2026-10-10T13:00:00+00:00' }),
    message({ id: 31, links: ['https://x.example.com/2'], time: '2026-10-10T13:05:00+00:00' }),
  );
  const older = page(message({ id: 20 }), message({ id: 21, links: ['https://x.example.com/3'] }));
  const found = findWith([htmlResponse(newer), htmlResponse(older)]);

  assert.deepEqual(await found.promise, { messageId: '20' });
  assert.equal(found.transport.calls[1].url, `https://t.me/s/${USERNAME}?before=30`);

  const past = page(message({ id: 9, links: ['https://x.example.com/old'], time: '2026-10-10T10:00:00+00:00' }));
  const stopped = findWith([htmlResponse(past)]);
  assert.equal(await stopped.promise, null);
  assert.equal(stopped.transport.calls.length, 1);
});

test('looks at no more than three pages', async () => {
  const pageAt = id => htmlResponse(page(message({ id, links: ['https://x.example.com/n'], time: '2026-10-10T13:00:00+00:00' })));
  const { transport, promise } = findWith([pageAt(90), pageAt(80), pageAt(70), pageAt(60)]);

  assert.equal(await promise, null);
  assert.equal(transport.calls.length, 3);
});

test('an unreadable preview is never proof', async () => {
  for (const response of [
    textResponse(302, '', { Location: 'https://t.me/radar_news' }),
    textResponse(404, 'not found'),
    htmlResponse('<html><body>This channel cannot be displayed</body></html>'),
    htmlResponse(''),
  ]) {
    const { promise } = findWith([response]);
    assert.equal(await promise, null);
  }
});

test('refuses to look without a public username, a usable link, or a valid start time', async () => {
  for (const overrides of [
    { username: '../etc' },
    { username: undefined },
    { url: 'not a url' },
    { url: undefined },
    { since: new Date('nope') },
    { since: undefined },
  ]) {
    const { transport, promise } = findWith([htmlResponse(page(message({ id: 1 })))], overrides);
    assert.equal(await promise, null);
    assert.equal(transport.calls.length, 0);
  }
});

function telegram(responses, chatId = '-1001234567890') {
  const transport = sequenceFetch(responses);
  const output = new TelegramOutput({ botToken: '123456:test-token', chatId, fetch: transport.fetch, sleep: noDelay });
  return { transport, output };
}

const query = (overrides = {}) => ({ articles: [{ url: ARTICLE }], since: SINCE, ...overrides });

test('Telegram asks getChat for the public username of a numeric chat, then reads the preview', async () => {
  const { transport, output } = telegram([
    jsonResponse(200, { ok: true, result: { id: -1001234567890, type: 'channel', username: USERNAME } }),
    htmlResponse(page(message({ id: 61 }))),
  ]);

  assert.deepEqual(await output.findDelivered(query()), { messageId: '61' });
  assert.match(transport.calls[0].url, /\/getChat$/);
  assert.deepEqual(JSON.parse(transport.calls[0].init.body), { chat_id: '-1001234567890' });
  assert.equal(transport.calls[0].init.redirect, 'manual');
  assert.equal(transport.calls[1].url, `https://t.me/s/${USERNAME}`);
});

test('Telegram skips getChat when the chat id already is a public @username', async () => {
  const { transport, output } = telegram([htmlResponse(page(message({ id: 62 })))], `@${USERNAME}`);

  assert.deepEqual(await output.findDelivered(query()), { messageId: '62' });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, `https://t.me/s/${USERNAME}`);
});

test('Telegram finds nothing for a private chat, a malformed @name, or a failing lookup', async () => {
  const privateChat = telegram([jsonResponse(200, { ok: true, result: { id: -1001, type: 'channel' } })]);
  assert.equal(await privateChat.output.findDelivered(query()), null);
  assert.equal(privateChat.transport.calls.length, 1);

  const malformed = telegram([], '@x/../y');
  assert.equal(await malformed.output.findDelivered(query()), null);
  assert.equal(malformed.transport.calls.length, 0);

  const rejected = telegram([jsonResponse(400, { ok: false, error_code: 400, description: 'chat not found' })]);
  assert.equal(await rejected.output.findDelivered(query()), null);

  const broken = telegram([() => { throw new TypeError('fetch failed'); }]);
  assert.equal(await broken.output.findDelivered(query()), null);
});

test('Telegram only looks for a send that carried exactly one article with a link', async () => {
  for (const articles of [undefined, [], [{ url: ARTICLE }, { url: 'https://other.example.com/b' }], [{ title: 'no link' }]]) {
    const { transport, output } = telegram([]);
    assert.equal(await output.findDelivered(query({ articles })), null);
    assert.equal(transport.calls.length, 0);
  }
});

test('the base output contract finds nothing, so other outputs stay ambiguous', async () => {
  const { OutputPlugin } = await import('../../src/core/contracts.js');
  assert.equal(await new OutputPlugin().findDelivered(query()), null);
});

test('a post of the same link made after the attempt ended is not the send being checked', async () => {
  const until = new Date('2026-10-10T12:00:20.000Z');
  // Nothing matches on the first page and it is still newer than the attempt, so the finder asks for the next page.
  const late = findWith([htmlResponse(page(message({ id: 8, time: '2026-10-10T12:10:00+00:00' }))), htmlResponse(page())], { until });
  const within = findWith([htmlResponse(page(message({ id: 9, time: '2026-10-10T12:01:30+00:00' })))], { until });

  assert.equal(await late.promise, null);
  assert.deepEqual(await within.promise, { messageId: '9' });
});

test('a forwarded copy or a post that mixes in other links is never taken for our send', async () => {
  const forwarded = message({ id: 4 }).replace(
    '<div class="tgme_widget_message_text',
    '<div class="tgme_widget_message_forwarded_from accent_color">Forwarded from someone</div><div class="tgme_widget_message_text',
  );
  const mixed = message({ id: 5, links: [ARTICLE, 'https://other.example.com/y'] });

  assert.equal(await findWith([htmlResponse(page(forwarded)), htmlResponse(page())]).promise, null);
  assert.equal(await findWith([htmlResponse(page(mixed)), htmlResponse(page())]).promise, null);
  // The same link shown twice (text and link preview) is still one link.
  assert.deepEqual(await findWith([htmlResponse(page(message({ id: 6, links: [ARTICLE, `${ARTICLE}/`] })))]).promise, { messageId: '6' });
});

// A message of the live channel preview, tags and attributes as served (long image URLs and the post text shortened).
const SERVED_BLOCK = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="dantechdailynews/1729" data-view="eyJjIjotMzg3NTUwMzk0NiwicCI6MTcyOX0">
  <div class="tgme_widget_message_user"><a href="https://t.me/dantechdailynews"><i class="tgme_widget_message_user_photo bgcolor6" data-content="D"><img src="https://cdn5.telesco.pe/file/avatar.jpg"></i></a></div>
  <div class="tgme_widget_message_bubble">
<a class="tgme_widget_message_photo_wrap" href="https://t.me/dantechdailynews/1729" style="background-image:url('https://cdn5.telesco.pe/file/photo.jpg')">
  <div class="tgme_widget_message_photo" style="padding-top:56.25%"></div>
</a><div class="tgme_widget_message_text js-message_text" dir="auto"><b>Video vi sinh vật thắng giải Nikon Small World in Motion</b><br/><br/>Ban tổ chức đã trao giải nhất mới.<br/><br/><a href="https://arstechnica.com/science/2026/10/winning-nikon-small-world-in-motion-video-disqualified-for-ai-use/" target="_blank" rel="noopener">https://arstechnica.com/science/2026/10/winning-nikon-small-world-in-motion-video-disqualified-for-ai-use/</a></div>
<div class="tgme_widget_message_footer compact js-message_footer">
  <div class="tgme_widget_message_info short js-message_info">
    <span class="tgme_widget_message_views">18</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/dantechdailynews/1729"><time datetime="2026-10-10T12:00:09+00:00" class="time">12:00</time></a></span>
  </div>
</div>
  </div>
</div></div>`;

test('the markup Telegram actually serves yields the post, its time, and its one outside link', async () => {
  const articleUrl = 'https://arstechnica.com/science/2026/10/winning-nikon-small-world-in-motion-video-disqualified-for-ai-use/';
  assert.deepEqual(parsePreviewMessages(page(SERVED_BLOCK), 'dantechdailynews'), [
    { id: 1729, time: Date.parse('2026-10-10T12:00:09+00:00'), links: [articleUrl] },
  ]);

  const { promise } = findWith([htmlResponse(page(SERVED_BLOCK))], {
    username: 'dantechdailynews',
    url: articleUrl,
    since: new Date('2026-10-10T12:00:00.000Z'),
    until: new Date('2026-10-10T12:00:17.000Z'),
  });
  assert.deepEqual(await promise, { messageId: '1729' });
});

test('hostile markup is parsed in bounded time', () => {
  const hostile = `<div class="tgme_widget_message_wrap"><div data-post="${USERNAME}/1">${'<time '.repeat(200_000)}`;
  const started = performance.now();

  assert.deepEqual(parsePreviewMessages(hostile, USERNAME), []);
  assert.ok(performance.now() - started < 1_000);
});

test('Telegram reads a getChat answer far larger than a send result', async () => {
  const { output } = telegram([
    jsonResponse(200, { ok: true, result: { id: -1001, type: 'channel', username: USERNAME, description: 'x'.repeat(20_000) } }),
    htmlResponse(page(message({ id: 63 }))),
  ]);

  assert.deepEqual(await output.findDelivered(query()), { messageId: '63' });
});

test('Telegram passes the end of the attempt on, so a later post of the link does not count', async () => {
  const later = message({ id: 64, time: '2026-10-10T13:00:00+00:00' });
  const { output } = telegram([htmlResponse(page(later)), htmlResponse(page(later))], `@${USERNAME}`);

  assert.deepEqual(await output.findDelivered(query()), { messageId: '64' });
  assert.equal(await output.findDelivered(query({ until: new Date('2026-10-10T12:00:10.000Z') })), null);
});
