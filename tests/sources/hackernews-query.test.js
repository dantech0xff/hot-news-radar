import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { aiNewsSources } from '../../src/presets/index.js';
import { HackerNewsSource } from '../../src/sources/hackernews.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SINCE = new Date('2026-10-03T00:00:00.000Z');
const SINCE_SECONDS = SINCE.getTime() / 1000;

function hit(objectID, points) {
  return {
    objectID,
    title: `Story ${objectID}`,
    url: `https://example.test/${objectID}`,
    points,
    num_comments: 3,
    created_at: '2026-10-03T10:00:00.000Z',
  };
}

/** Answers the Algolia call with `hits` and records its URL; page fetches (og:image) get a 404. */
function algoliaFetch(hits) {
  const requested = [];
  globalThis.fetch = async url => {
    if (!String(url).startsWith('https://hn.algolia.com/')) return new Response('', { status: 404 });
    requested.push(new URL(String(url)));
    return Response.json({ hits });
  };
  return requested;
}

test('the Hacker News request filters by points on the server', async () => {
  const requested = algoliaFetch([hit('1', 120)]);

  await new HackerNewsSource({ query: 'rust', minPoints: 80 }).fetch({ limit: 3, since: SINCE });

  assert.equal(requested.length, 1);
  assert.equal(requested[0].searchParams.get('numericFilters'), `points>=80,created_at_i>${SINCE_SECONDS}`);
});

test('without a date window the request still filters by points', async () => {
  const requested = algoliaFetch([hit('1', 120)]);

  await new HackerNewsSource({ minPoints: 50 }).fetch({ limit: 3 });

  assert.equal(requested[0].searchParams.get('numericFilters'), 'points>=50');
});

test('a keyword query reads the newest stories first and a plain request keeps Algolia ranking', async () => {
  const requested = algoliaFetch([]);

  await new HackerNewsSource({ query: 'rust' }).fetch({ limit: 3, since: SINCE });
  await new HackerNewsSource().fetch({ limit: 3, since: SINCE });

  assert.deepEqual(requested.map(url => url.pathname), ['/api/v1/search_by_date', '/api/v1/search']);
});

test('a query requires every word unless matchAny is set', async () => {
  const requested = algoliaFetch([]);

  await new HackerNewsSource({ query: 'rust async' }).fetch({ limit: 3, since: SINCE });

  assert.equal(requested[0].searchParams.get('query'), 'rust async');
  assert.equal(requested[0].searchParams.has('optionalWords'), false);
});

test('matchAny makes each word of the query optional', async () => {
  const requested = algoliaFetch([]);

  await new HackerNewsSource({ query: 'AI  LLM GPT', matchAny: true }).fetch({ limit: 3, since: SINCE });

  assert.equal(requested[0].searchParams.get('query'), 'AI  LLM GPT');
  assert.equal(requested[0].searchParams.get('optionalWords'), 'AI,LLM,GPT');
});

test('stories below the point threshold are still dropped when the response carries them', async () => {
  algoliaFetch([hit('1', 90), hit('2', 10), hit('3', 200)]);

  const articles = await new HackerNewsSource({ query: 'rust', minPoints: 80 }).fetch({ limit: 5, since: SINCE });

  assert.deepEqual(articles.map(article => article.id), ['hn:1', 'hn:3']);
});

test('matchAny is part of the source key only when it is set', () => {
  const plain = new HackerNewsSource({ query: 'AI LLM', minPoints: 80 });
  const any = new HackerNewsSource({ query: 'AI LLM', minPoints: 80, matchAny: true });

  assert.equal(plain.sourceKey, JSON.stringify(['hackernews', 'hackernews:AI LLM', 'AI LLM', '', 80]));
  assert.notEqual(any.sourceKey, plain.sourceKey);
});

test('the AI news preset reads Hacker News stories that match any of its words', async () => {
  const source = aiNewsSources().find(candidate => candidate.id.startsWith('hackernews:'));
  assert.ok(source, 'the AI news preset has a Hacker News source');
  const requested = algoliaFetch([hit('1', 120)]);

  const articles = await source.fetch({ limit: 3, since: SINCE });

  assert.equal(articles.length, 1);
  assert.equal(requested[0].searchParams.get('optionalWords'), 'AI,LLM,GPT,OpenAI,Anthropic');
  assert.match(requested[0].searchParams.get('numericFilters'), /^points>=80,/);
});
