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
