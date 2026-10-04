/**
 * Source Plugin: Hacker News
 * Uses official HN Algolia API (no auth needed)
 */

import { SourcePlugin } from '../core/contracts.js';
import { enrichMissingImages } from './og-image.js';
import {
  SOURCE_FETCH_DIAGNOSTIC_CAPABILITY,
  discardSourceResponse,
  fetchSourceWithDiagnostics,
  httpSourceFailure,
  invalidSourceShape,
  readLastFetchDiagnostic,
  readSourceJson,
  runDiagnosedFetch,
} from './source-result.js';

export class HackerNewsSource extends SourcePlugin {
  /**
   * @param {Object} [config]
   * @param {string} [config.query]      - Search query (e.g. 'rust', 'kubernetes')
   * @param {boolean} [config.matchAny=false] - Accept stories that match any word of `query` instead of every word
   * @param {string} [config.filter]     - 'front_page' | 'show_hn' | 'ask_hn' | null
   * @param {number} [config.minPoints=50] - Minimum points threshold
   */
  constructor(config = {}) {
    super();
    this._config = { minPoints: 50, ...config };
  }

  get id() { return `hackernews${this._config.query ? `:${this._config.query}` : ''}`; }
  get name() { return 'Hacker News'; }
  get sourceKey() {
    const { query, filter, minPoints, matchAny } = this._config;
    return JSON.stringify([
      'hackernews', this.id, query ?? '', filter ?? '', minPoints,
      // Appended only when set, so the keys of sources that do not use it stay as they were.
      ...(matchAny ? ['match-any'] : []),
    ]);
  }
  get icon() { return '🟠'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 10, since } = options;
      const { query, filter, minPoints, matchAny } = this._config;

      let url;
      if (query) {
        // Newest first, like a feed: relevance order keeps returning the same older stories.
        url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit * 2}`;
        // Algolia requires every query word to match; marking them optional makes one word enough.
        if (matchAny) url += `&optionalWords=${encodeURIComponent(query.split(/\s+/).filter(Boolean).join(','))}`;
      } else if (filter === 'front_page') {
        url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit * 2}`;
      } else {
        url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${limit * 2}`;
      }

      // Filter on the server: the page holds only a few hits, so filtering them by points
      // afterwards would leave almost nothing.
      const numericFilters = [`points>=${minPoints}`];
      if (since) numericFilters.push(`created_at_i>${Math.floor(since.getTime() / 1000)}`);
      url += `&numericFilters=${numericFilters.join(',')}`;

      const response = await fetch(url, { signal: options.signal });
      if (!response.ok) {
        await discardSourceResponse(response);
        throw httpSourceFailure(response.status);
      }

      const data = await readSourceJson(response);
      validateHackerNewsPayload(data);
      const articles = data.hits
        .filter(hit => (hit.points || 0) >= minPoints)
        .slice(0, limit)
        .map(hit => ({
          id: `hn:${hit.objectID}`,
          title: hit.title,
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          content: `${hit.points || 0} points, ${hit.num_comments || 0} comments`,
          source: this.name,
          category: 'Community',
          publishedAt: hit.created_at ? new Date(hit.created_at) : null,
          meta: {
            icon: this.icon,
            points: hit.points,
            comments: hit.num_comments,
            hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          },
        }));

      await enrichMissingImages(articles, { signal: options.signal });
      return articles;
    });
  }
}

function validateHackerNewsPayload(data) {
  if (!isRecord(data) || !Array.isArray(data.hits)) throw invalidSourceShape();

  for (const hit of data.hits) {
    if (!isRecord(hit)) throw invalidSourceShape();
    if (!isValidSourceId(hit.objectID)) throw invalidSourceShape();
    if (typeof hit.title !== 'string' || !hit.title.trim()) throw invalidSourceShape();
    if (hit.url !== undefined && hit.url !== null && typeof hit.url !== 'string') {
      throw invalidSourceShape();
    }
    if (hit.points !== undefined && hit.points !== null && !Number.isFinite(hit.points)) {
      throw invalidSourceShape();
    }
    if (hit.num_comments !== undefined && hit.num_comments !== null && !Number.isFinite(hit.num_comments)) {
      throw invalidSourceShape();
    }
    if (hit.created_at !== undefined && hit.created_at !== null && typeof hit.created_at !== 'string') {
      throw invalidSourceShape();
    }
    if (typeof hit.created_at === 'string' && Number.isNaN(new Date(hit.created_at).getTime())) {
      throw invalidSourceShape();
    }
  }
}

function isValidSourceId(value) {
  return (typeof value === 'string' && Boolean(value.trim()))
    || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
