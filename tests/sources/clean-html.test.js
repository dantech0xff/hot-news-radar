import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { RSSSource, cleanHTML } from '../../src/sources/rss.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('the five basic entities and &nbsp; decode as before', () => {
  assert.equal(cleanHTML('Q&amp;A &lt;b&gt; &quot;quoted&quot; a&nbsp;b'), 'Q&A <b> "quoted" a b');
});

test('&apos; decodes to an apostrophe', () => {
  assert.equal(cleanHTML('Helix: powering our Shopify app&apos;s native migration'), "Helix: powering our Shopify app's native migration");
});

test('numeric references decode in decimal, zero-padded decimal, and hex', () => {
  assert.equal(cleanHTML('Meta&#8217;s first chip'), 'Meta’s first chip');
  assert.equal(cleanHTML('you can&#039;t use it'), "you can't use it");
  assert.equal(cleanHTML('it&#39;s and it&#x27;s and it&#X27;s'), "it's and it's and it's");
  assert.equal(cleanHTML('&#8216;Full Disk Access&#8217;'), '‘Full Disk Access’');
  assert.equal(cleanHTML('smile &#x1F600; done'), 'smile \u{1F600} done');
});

test('typographic named entities decode', () => {
  assert.equal(
    cleanHTML('&ldquo;ultraintelligent&rdquo; &lsquo;x&rsquo; a&ndash;b c&mdash;d wait&hellip;'),
    '“ultraintelligent” ‘x’ a–b c—d wait…',
  );
});

test('doubly escaped references decode like singly escaped ones', () => {
  assert.equal(cleanHTML('It&amp;#39;s and &amp;apos;this&amp;apos; and &amp;lt;b&amp;gt;'), "It's and 'this' and <b>");
});

test('references that are unknown, unsafe, or not references stay as written', () => {
  for (const text of ['&foo;', '&#0;', '&#1;', '&#127;', '&#150;', '&#xD800;', '&#1114112;', '&#99999999;', 'AT&T and R&D', 'a & b', '&amp', '&#39']) {
    assert.equal(cleanHTML(text), text, text);
  }
});

test('whitespace references collapse like other whitespace', () => {
  assert.equal(cleanHTML('a&#32;&#160;&#10;b'), 'a b');
});

test('tags are stripped before entities decode, so an encoded angle bracket survives as text', () => {
  assert.equal(cleanHTML('<p>Use <b>the</b> &lt;div&gt; tag</p>'), 'Use the <div> tag');
});

test('an RSS item title and description decode entities', async () => {
  const xml = '<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title>'
    + '<item><title>Meta&#8217;s chip &amp; Shopify app&apos;s move &#039;now&#039;</title><link>https://example.test/post</link>'
    + '<pubDate>Sat, 03 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://example.test/cover.png" medium="image"/>'
    + '<description>We&#8217;re open-sourcing it &#8230; read more</description></item></channel></rss>';
  globalThis.fetch = async () => new Response(xml, { headers: { 'content-type': 'application/xml' } });
  const source = new RSSSource({ id: 'entities', name: 'Entities', feedUrl: 'https://example.test/feed.xml' });

  const result = await source.fetchWithDiagnostics();

  assert.equal(result.diagnostic.status, 'success');
  assert.equal(result.articles[0].title, "Meta’s chip & Shopify app's move 'now'");
  assert.equal(result.articles[0].content, 'We’re open-sourcing it … read more');
});
