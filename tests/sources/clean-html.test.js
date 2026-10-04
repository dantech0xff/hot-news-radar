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

const REDDIT_BODY = '&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;It&amp;#39;s a &lt;strong&gt;test&lt;/strong&gt;&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;'
  + ' &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/x&quot;&gt; /u/x &lt;/a&gt;'
  + ' &lt;span&gt;&lt;a href=&quot;https://example.test/?a=1&amp;amp;b=2&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;';

test('escaped HTML in a body loses its tags, comments, and attributes', () => {
  assert.equal(cleanHTML(REDDIT_BODY, { escapedMarkup: true }), "It's a test submitted by /u/x [link]");
  assert.equal(
    cleanHTML('&lt;p&gt;The concept of &lt;strong&gt;RSI&lt;/strong&gt; dates back to &lt;a href=&#34;https://example.test/a?x=1&#34;&gt;I. J. Good&lt;/a&gt;&lt;br/&gt;&lt;img src=&#34;x.png&#34; /&gt;&lt;/p&gt;', { escapedMarkup: true }),
    'The concept of RSI dates back to I. J. Good',
  );
});

test('text that only looks like a tag stays in an escaped body', () => {
  assert.equal(cleanHTML('&lt;p&gt;Use Vec&lt;T&gt; and List&lt;String&gt; for 1 &lt; 2&lt;/p&gt;', { escapedMarkup: true }), 'Use Vec<T> and List<String> for 1 < 2');
});

test('a body of real HTML keeps text that mentions an escaped tag', () => {
  assert.equal(cleanHTML('<p>Use the <code>&lt;div&gt;</code> element</p>', { escapedMarkup: true }), 'Use the <div> element');
});

test('titles and other callers keep escaped markup as text by default', () => {
  assert.equal(cleanHTML('Use &lt;div&gt; in Vec&lt;T&gt;'), 'Use <div> in Vec<T>');
  assert.equal(cleanHTML(REDDIT_BODY).startsWith('<!-- SC_OFF --><div class="md">'), true);
});

test('an Atom type="html" entry and an RSS 2.0 description with escaped HTML give clean content', async () => {
  const atom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>Atom</title>'
    + `<entry><title>Atom post</title><link href="https://example.test/atom"/><updated>2026-10-03T10:00:00+00:00</updated><media:thumbnail url="https://example.test/t.png"/><content type="html">${REDDIT_BODY}</content></entry></feed>`;
  const rss = '<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>RSS</title>'
    + '<item><title>RSS post</title><link>https://example.test/rss</link><pubDate>Sat, 03 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://example.test/c.png" medium="image"/>'
    + '<description>&lt;p&gt;The concept of &lt;strong&gt;RSI&lt;/strong&gt; dates back to &lt;a href=&#34;https://example.test/a&#34;&gt;I. J. Good&lt;/a&gt;&lt;/p&gt;</description></item></channel></rss>';
  for (const [xml, expected] of [[atom, "It's a test submitted by /u/x [link]"], [rss, 'The concept of RSI dates back to I. J. Good']]) {
    globalThis.fetch = async () => new Response(xml, { headers: { 'content-type': 'application/xml' } });
    const source = new RSSSource({ id: 'escaped', name: 'Escaped', feedUrl: 'https://example.test/feed.xml' });

    const result = await source.fetchWithDiagnostics();

    assert.equal(result.diagnostic.status, 'success');
    assert.equal(result.articles[0].content, expected);
  }
});

test('an RSS body of real HTML that mentions an escaped tag keeps the mention', async () => {
  const xml = '<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>RSS</title>'
    + '<item><title>Tags</title><link>https://example.test/tags</link><pubDate>Sat, 03 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://example.test/c.png" medium="image"/>'
    + '<description><![CDATA[<p>Use the <code>&lt;div&gt;</code> element</p>]]></description></item></channel></rss>';
  globalThis.fetch = async () => new Response(xml, { headers: { 'content-type': 'application/xml' } });
  const source = new RSSSource({ id: 'cdata', name: 'CDATA', feedUrl: 'https://example.test/feed.xml' });

  const result = await source.fetchWithDiagnostics();

  assert.equal(result.articles[0].content, 'Use the <div> element');
});
