/**
 * Source Plugin: RSS / Atom Feed
 * Dùng cho bất kỳ blog nào có RSS feed
 */

import { SourcePlugin } from '../core/contracts.js';
import { enrichMissingImages } from './og-image.js';
import {
  SOURCE_FETCH_DIAGNOSTIC_CAPABILITY,
  discardSourceResponse,
  fetchSourceWithDiagnostics,
  httpSourceFailure,
  invalidSourceShape,
  parseSourceFailure,
  readLastFetchDiagnostic,
  readSourceText,
  runDiagnosedFetch,
  validateArticleArray,
} from './source-result.js';

export class RSSSource extends SourcePlugin {
  /**
   * @param {Object} config
   * @param {string} config.id       - Unique ID
   * @param {string} config.name     - Display name
   * @param {string} config.feedUrl  - RSS/Atom feed URL
   * @param {string} [config.icon]   - Emoji icon
   * @param {string} [config.category]
   * @param {string} [config.baseUrl] - Base URL để resolve relative links
   * @param {number} [config.maxResponseBytes] - Response size cap for feeds that embed full post text (default 2 MiB, at most 8 MiB)
   */
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return this._config.id; }
  get name() { return this._config.name; }
  get sourceKey() {
    return JSON.stringify([
      'rss', this.id, this.name, this._config.feedUrl,
      this._config.baseUrl ?? '', this._config.category ?? '',
    ]);
  }
  get icon() { return this._config.icon || '📰'; }
  get diagnosticCapability() { return SOURCE_FETCH_DIAGNOSTIC_CAPABILITY; }
  get lastFetchDiagnostic() { return readLastFetchDiagnostic(this); }

  async fetchWithDiagnostics(options = {}) {
    return fetchSourceWithDiagnostics(this, options);
  }

  async fetch(options = {}) {
    return runDiagnosedFetch(this, options, async () => {
      const { limit = 5, since } = options;

      const xml = await withResponseTimeout(
        this._config.feedUrl,
        15000,
        options.signal,
        async response => {
          if (!response.ok) {
            await discardSourceResponse(response);
            throw httpSourceFailure(response.status);
          }
          return readSourceText(response, this._config.maxResponseBytes);
        },
      );
      validateFeedDocument(xml);
      let articles = this._parseXML(xml);
      validateArticleArray(articles);

      // Filter by date
      if (since) {
        articles = articles.filter(a => !a.publishedAt || a.publishedAt > since);
      }

      articles = articles.slice(0, limit);

      // Fetch og:image for articles missing imageUrl
      await enrichMissingImages(articles, { signal: options.signal });

      return articles;
    });
  }

  _parseXML(xml) {
    // Try RSS 2.0
    const rssItems = extractBlocks(xml, 'item');
    if (rssItems.length > 0) {
      return rssItems.map(item => this._parseItem(item, 'rss'));
    }

    // Try Atom
    const atomEntries = extractBlocks(xml, 'entry');
    return atomEntries.map(item => this._parseItem(item, 'atom'));
  }

  _parseItem(xml, format) {
    const title = cleanHTML(extractTag(xml, 'title'));
    const url = format === 'atom'
      ? extractAttr(xml, 'link', 'href') || extractTag(xml, 'link')
      : extractTag(xml, 'link');
    const rawContent = extractTag(xml, 'description')
      || extractTag(xml, 'content:encoded')
      || extractTag(xml, 'summary')
      || extractTag(xml, 'content')
      || '';
    const dateStr = extractTag(xml, 'pubDate')
      || extractTag(xml, 'published')
      || extractTag(xml, 'updated')
      || extractTag(xml, 'dc:date');

    const resolvedUrl = resolveUrl(url, this._config.baseUrl || this._config.feedUrl);
    const imageUrl = extractImageUrl(xml, rawContent);

    return {
      id: resolvedUrl || `${this.id}:${title}`,
      title,
      url: resolvedUrl,
      content: cleanHTML(rawContent).substring(0, 1000),
      source: this.name,
      category: this._config.category,
      imageUrl: imageUrl || undefined,
      publishedAt: dateStr ? new Date(dateStr) : null,
      meta: { icon: this.icon },
    };
  }
}

// ============================================
// Batch helper: tạo nhiều RSSSource từ config array
// ============================================

/**
 * @param {Array<{id, name, feedUrl, icon?, category?, baseUrl?}>} configs
 * @returns {RSSSource[]}
 */
export function createRSSSources(configs) {
  return configs.map(c => new RSSSource(c));
}

// ============================================
// XML parsing helpers (zero dependencies)
// ============================================

function extractBlocks(xml, tag) {
  const blocks = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) blocks.push(m[1]);
  return blocks;
}

function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

// Named entities that feeds use besides &amp;, which cleanHTML decodes first.
const NAMED_ENTITIES = Object.freeze({
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…',
});

export function cleanHTML(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decode named entities from NAMED_ENTITIES and numeric references
 * (&#8217; and &#x27;). A reference that is unknown, or that names a control or
 * surrogate code point, stays as written.
 */
function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, decimal, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
    return isTextCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function isTextCodePoint(codePoint) {
  return codePoint === 9 || codePoint === 10 || codePoint === 13
    || (codePoint >= 0x20 && codePoint < 0x7F)
    || (codePoint >= 0xA0 && codePoint <= 0x10FFFF && !(codePoint >= 0xD800 && codePoint <= 0xDFFF));
}

function extractImageUrl(xml, rawContent) {
  // 1. <media:content url="..."> (prefer medium="image" if specified)
  const mediaImage = xml.match(/<media:content[^>]*medium="image"[^>]*url="([^"]*)"/i)
    || xml.match(/<media:content[^>]*url="([^"]*)"[^>]*medium="image"/i);
  if (mediaImage) return mediaImage[1];

  const mediaContent = extractAttr(xml, 'media:content', 'url');
  if (mediaContent) return mediaContent;

  // 2. <media:thumbnail url="...">
  const mediaThumbnail = extractAttr(xml, 'media:thumbnail', 'url');
  if (mediaThumbnail) return mediaThumbnail;

  // 3. <enclosure type="image/...">
  const enclosureMatch = xml.match(/<enclosure[^>]*type="image\/[^"]*"[^>]*url="([^"]*)"/i)
    || xml.match(/<enclosure[^>]*url="([^"]*)"[^>]*type="image\/[^"]*"/i);
  if (enclosureMatch) return enclosureMatch[1];

  // 4. First <img src="..."> in raw content
  const imgMatch = (rawContent || '').match(/<img[^>]*src="([^"]*)"/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

function resolveUrl(url, base) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

function validateFeedDocument(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw parseSourceFailure();

  const structuralXML = xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const document = assertWellFormedXML(structuralXML);
  const rootName = document.rootName.toLowerCase();

  if (rootName === 'rss') {
    assertFeedTagStructure(document.elements, {
      tags: ['rss', 'channel', 'item'],
      required: { rss: 1, channel: 1 },
      parent: { rss: null, channel: 'rss', item: 'channel' },
    });
    return;
  }

  if (rootName === 'feed') {
    assertFeedTagStructure(document.elements, {
      tags: ['feed', 'entry'],
      required: { feed: 1 },
      parent: { feed: null, entry: 'feed' },
    });
    return;
  }

  throw invalidSourceShape();
}

function assertWellFormedXML(xml) {
  const stack = [];
  const elements = [];
  const roots = [];
  const tokenPattern = /<([^>]*)>/g;
  let previousEnd = 0;
  let match;

  assertValidXMLContent(xml);

  while ((match = tokenPattern.exec(xml))) {
    const text = xml.slice(previousEnd, match.index);
    if (text.includes('<') || (stack.length === 0 && text.trim())) throw parseSourceFailure();
    previousEnd = tokenPattern.lastIndex;

    const token = match[1].trim();
    if (!token) throw parseSourceFailure();
    if (token.startsWith('?')) continue;
    if (token.startsWith('!')) {
      if (!/^!DOCTYPE\b/i.test(token) || stack.length > 0 || roots.length > 0) {
        throw parseSourceFailure();
      }
      continue;
    }

    if (token.startsWith('/')) {
      const closingMatch = token.match(/^\/\s*([A-Za-z_][\w:.-]*)\s*$/);
      if (!closingMatch || stack.pop() !== closingMatch[1]) throw parseSourceFailure();
      continue;
    }

    const selfClosing = /\/\s*$/.test(token);
    const openingToken = selfClosing ? token.replace(/\/\s*$/, '').trimEnd() : token;
    const openingMatch = openingToken.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/);
    if (!openingMatch) throw parseSourceFailure();
    validateXMLAttributes(openingMatch[2]);
    const parentName = stack.at(-1) || null;
    if (!parentName) roots.push(openingMatch[1]);
    elements.push({ name: openingMatch[1], parentName, selfClosing });
    if (!selfClosing) stack.push(openingMatch[1]);
  }

  const trailingText = xml.slice(previousEnd);
  if (trailingText.includes('<') || trailingText.trim() || stack.length > 0 || roots.length !== 1) {
    throw parseSourceFailure();
  }
  return { rootName: roots[0], elements };
}

function assertValidXMLContent(xml) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) throw parseSourceFailure();
  if (/&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[\da-f]+);)/i.test(xml)) throw parseSourceFailure();
}

function validateXMLAttributes(rawAttributes) {
  if (rawAttributes.includes('<')) throw parseSourceFailure();
  let remainder = rawAttributes;
  const names = new Set();

  while (remainder.trim()) {
    const match = remainder.match(/^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/);
    if (!match || names.has(match[1])) throw parseSourceFailure();
    names.add(match[1]);
    remainder = remainder.slice(match[0].length);
  }
}

function assertFeedTagStructure(elements, { tags, required, parent }) {
  const openingCounts = Object.fromEntries(tags.map(tag => [tag, 0]));
  for (const element of elements) {
    const tag = element.name.toLowerCase();
    if (!tags.includes(tag)) continue;
    if (element.selfClosing) throw parseSourceFailure();
    const expectedParent = parent[tag];
    const actualParent = element.parentName?.toLowerCase() || null;
    if (actualParent !== expectedParent) throw parseSourceFailure();
    openingCounts[tag] += 1;
  }

  for (const [tag, expectedCount] of Object.entries(required)) {
    if (openingCounts[tag] !== expectedCount) throw parseSourceFailure();
  }
}

async function withResponseTimeout(url, timeoutMs, externalSignal, consume) {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ContentRadar/2.0' },
    });
    return await consume(response);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}
