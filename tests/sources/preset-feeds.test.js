import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { aiDeepDiveSources, aiNewsSources, bigTechBlogs } from '../../src/presets/index.js';
import { MAX_SOURCE_RESPONSE_BODY_BYTES } from '../../src/sources/source-result.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** One post padded to at least `minBytes`; the cover image keeps image enrichment from fetching the page. */
function fullTextFeed(minBytes) {
  return '<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title>'
    + '<item><title>Full text post</title><link>https://example.test/post</link>'
    + '<pubDate>Sat, 03 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://example.test/cover.png" medium="image"/>'
    + `<description>${'x'.repeat(minBytes)}</description></item></channel></rss>`;
}

test('feeds that embed full post text are read above the default response cap', async () => {
  const sources = [...bigTechBlogs(), ...aiDeepDiveSources()];
  for (const id of ['vercel', 'ahead-of-ai']) {
    const source = sources.find(candidate => candidate.id === id);
    assert.ok(source, `${id} is in a preset`);
    globalThis.fetch = async () => new Response(fullTextFeed(MAX_SOURCE_RESPONSE_BODY_BYTES + 256 * 1024), {
      headers: { 'content-type': 'application/xml' },
    });

    const result = await source.fetchWithDiagnostics();

    assert.equal(result.diagnostic.status, 'success', `${id} reads a feed above the default cap`);
    assert.equal(result.articles.length, 1);
  }
});

test('other preset feeds keep the default response cap', async () => {
  const source = bigTechBlogs().find(candidate => candidate.id === 'github');
  assert.ok(source);
  globalThis.fetch = async () => new Response(fullTextFeed(MAX_SOURCE_RESPONSE_BODY_BYTES + 256 * 1024), {
    headers: { 'content-type': 'application/xml' },
  });

  const result = await source.fetchWithDiagnostics();

  assert.equal(result.diagnostic.failureType, 'response_too_large');
  assert.deepEqual(result.articles, []);
});

test('preset source ids are unique across the bundles the default Telegram channel uses', () => {
  const ids = [...bigTechBlogs(), ...aiNewsSources(), ...aiDeepDiveSources()].map(source => source.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the AI news preset reads Reddit through RSS, which needs no sign-in', () => {
  const sources = aiNewsSources();
  const reddit = sources.find(source => source.id === 'reddit-ai');
  assert.ok(reddit, 'a single Reddit RSS source');
  assert.match(reddit.sourceKey, /reddit\.com\/r\/LocalLLaMA\+artificial\/top\.rss/);
  assert.equal(sources.some(source => /^reddit:/.test(source.id)), false, 'no JSON Reddit source remains');
});

/** XML text of an HTML string, the way Reddit's Atom feed carries entry bodies. */
function escapeXml(html) {
  return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const REDDIT_FOOTER_HTML = ' &#32; submitted by &#32; <a href="https://www.reddit.com/user/jacek2023"> /u/jacek2023 </a> to '
  + '<a href="https://www.reddit.com/r/LocalLLaMA/"> r/LocalLLaMA </a> <br/> <span><a href="https://example.test/article">[link]</a></span> &#32; '
  + '<span><a href="https://www.reddit.com/r/LocalLLaMA/comments/1abc/">[comments]</a></span>';

function redditEntry(title, bodyHtml) {
  return `<entry><title>${title}</title><link href="https://www.reddit.com/r/LocalLLaMA/comments/${title.length}/"/>`
    + '<updated>2026-10-03T10:00:00+00:00</updated><media:thumbnail url="https://example.test/t.png"/>'
    + `<content type="html">${escapeXml(bodyHtml)}</content></entry>`;
}

test("the Reddit preset source drops Reddit's \"submitted by\" footer and keeps the body", async () => {
  const source = aiNewsSources().find(candidate => candidate.id === 'reddit-ai');
  const feed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>Reddit</title>'
    + redditEntry('Self post', `<!-- SC_OFF --><div class="md"><p>It's a body &amp; more</p></div><!-- SC_ON -->${REDDIT_FOOTER_HTML}`)
    + redditEntry('Link post', `<table> <tr><td> <a href="https://example.test/article"> <img src="https://preview.redd.it/x.jpg" alt="t" title="t" /> </a> </td><td>${REDDIT_FOOTER_HTML} </td></tr></table>`)
    + redditEntry('Mentions it', `<div class="md"><p>The paper was submitted by /u/x for review and accepted</p></div>${REDDIT_FOOTER_HTML}`)
    + '</feed>';
  globalThis.fetch = async () => new Response(feed, { headers: { 'content-type': 'application/atom+xml' } });

  const result = await source.fetchWithDiagnostics({ limit: 10 });

  assert.equal(result.diagnostic.status, 'success');
  assert.deepEqual(result.articles.map(article => article.content), [
    "It's a body & more",
    '',
    'The paper was submitted by /u/x for review and accepted',
  ]);
});
