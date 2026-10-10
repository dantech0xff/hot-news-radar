/**
 * Proof of delivery from a public Telegram channel's web preview (`https://t.me/s/<username>`).
 *
 * After a send ended ambiguous, a post that carries the article's link and appeared after the attempt
 * began shows the message did reach the channel, so the output can be confirmed without being sent
 * again. Anything uncertain (a private channel, a changed page, a network error) yields null, never a guess.
 */

import { fetchWithTimeout, readResponseText } from './telegram-client.js';

export const LOOKUP_REQUEST_TIMEOUT_MS = 8_000;

const PUBLIC_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const MAX_PREVIEW_PAGES = 3;
const MAX_PREVIEW_BLOCKS = 100;
// Telegram stamps the post and this process stamps the attempt, so their clocks can differ a little.
const CLOCK_SKEW_MS = 120_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; ContentRadar)';
const MESSAGE_BLOCK_START = '<div class="tgme_widget_message_wrap';

export function isPublicUsername(value) {
  return typeof value === 'string' && PUBLIC_USERNAME.test(value);
}

/** A link reduced to what identifies the page: no scheme, `www.`, fragment, tracking query, or trailing slash. */
export function comparableLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    const query = url.searchParams.toString();
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

/** The messages one preview page lists: id, time, and every link outside Telegram that each carries. */
export function parsePreviewMessages(html, username) {
  const messages = [];
  const blocks = String(html).split(/(?=<div class="tgme_widget_message_wrap)/)
    .filter(block => block.startsWith(MESSAGE_BLOCK_START))
    .slice(0, MAX_PREVIEW_BLOCKS);
  for (const block of blocks) {
    // This output never forwards, so a forwarded copy of the same link is someone else's message.
    if (block.includes('tgme_widget_message_forwarded_from')) continue;
    const post = /data-post="([^"/]+)\/(\d+)"/.exec(block);
    if (!post || post[1].toLowerCase() !== username.toLowerCase()) continue;
    const time = Date.parse([...block.matchAll(/<time[^>]{0,300}?datetime="([^"]+)"/g)].at(-1)?.[1] ?? '');
    if (!Number.isFinite(time)) continue;
    const links = [...block.matchAll(/href="(https?:\/\/[^"]+)"/g)]
      .map(match => decodeAttribute(match[1]))
      .filter(link => !/^https?:\/\/(?:www\.)?(?:t|telegram)\.(?:me|org)\//i.test(link));
    messages.push({ id: Number(post[2]), time, links });
  }
  return messages;
}

/**
 * Find the earliest post whose only outside link is `url`, published from `since` until `until` (each
 * widened by a small clock allowance). The upper bound keeps a later post of the same link, such as a
 * forward or another poster's message, from standing in for the send being checked.
 * Resolves `{ messageId }` when found, otherwise null. Network errors propagate to the caller.
 */
export async function findPostByLink({ username, url, since, until, fetchImpl, dependencies, signal }) {
  const wanted = comparableLink(url);
  if (!wanted || !isPublicUsername(username) || !(since instanceof Date) || Number.isNaN(since.getTime())) return null;
  const earliest = since.getTime() - CLOCK_SKEW_MS;
  const latest = until instanceof Date && !Number.isNaN(until.getTime()) ? until.getTime() + CLOCK_SKEW_MS : Infinity;
  let before = null;

  for (let page = 0; page < MAX_PREVIEW_PAGES; page += 1) {
    const html = await fetchPreviewPage({ username, before, fetchImpl, dependencies, signal });
    const messages = html === null ? [] : parsePreviewMessages(html, username);
    if (messages.length === 0) return null;

    const hit = messages
      .filter(message => message.time >= earliest && message.time <= latest && carriesOnly(message, wanted))
      .sort((left, right) => left.id - right.id)[0];
    if (hit) return { messageId: String(hit.id) };

    const oldest = messages.reduce((lowest, message) => (message.id < lowest.id ? message : lowest));
    // Once a page reaches back past the attempt, older posts cannot be its result.
    if (oldest.time < earliest) return null;
    before = oldest.id;
  }
  return null;
}

/** Our posts carry one outside link, the article's; any other mix of links is not our send. */
function carriesOnly(message, wanted) {
  const distinct = new Set(message.links.map(comparableLink));
  return distinct.size === 1 && distinct.has(wanted);
}

async function fetchPreviewPage({ username, before, fetchImpl, dependencies, signal }) {
  const url = `https://t.me/s/${username}${before === null ? '' : `?before=${before}`}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal,
  }, { ...dependencies, timeoutMs: LOOKUP_REQUEST_TIMEOUT_MS });
  const body = await readResponseText(response);
  return response?.ok && body.text ? body.text : null;
}

function decodeAttribute(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'");
}
