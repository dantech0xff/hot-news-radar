/**
 * Presets — Pre-configured source bundles
 * Each preset returns SourcePlugin[] — spread into .addSource()
 */

import { createRSSSources } from '../sources/rss.js';
import { HackerNewsSource } from '../sources/hackernews.js';
import { RedditSource } from '../sources/reddit.js';
import { DevToSource } from '../sources/devto.js';
import { GitHubTrendingSource } from '../sources/github-trending.js';
import { MAX_SOURCE_RESPONSE_BODY_CEILING_BYTES } from '../sources/source-result.js';

const OFFICIAL_AI_FEEDS = [
  { id: 'openai',      name: 'OpenAI Blog',       feedUrl: 'https://openai.com/blog/rss.xml',      icon: '🤖', category: 'AI/ML' },
  { id: 'deepmind',    name: 'Google DeepMind',   feedUrl: 'https://deepmind.google/blog/rss.xml', icon: '🧠', category: 'AI/ML' },
  { id: 'huggingface', name: 'Hugging Face Blog', feedUrl: 'https://huggingface.co/blog/feed.xml', icon: '🤗', category: 'AI/ML' },
];

function createOfficialAIFeedConfigs() {
  return OFFICIAL_AI_FEEDS.map(config => ({ ...config }));
}

// Feeds that embed the full text of every post are larger than the default
// response cap (about 2.6 and 3.6 MiB in 2026), so they ask for the ceiling.
const FULL_TEXT_FEED_MAX_BYTES = MAX_SOURCE_RESPONSE_BODY_CEILING_BYTES;

// Reddit ends every RSS body with "submitted by /u/<user> to r/<subreddit> [link] [comments]".
const REDDIT_FOOTER = /\s*submitted by\s+\/u\/\S+(?:\s+to\s+r\/\S+)?(?:\s+\[link\])?(?:\s+\[comments\])?\s*$/i;

// ============================================
// Big Tech Engineering Blogs (12 sources)
// ============================================

export function bigTechBlogs() {
  return createRSSSources([
    { id: 'meta',       name: 'Meta Engineering',        feedUrl: 'https://engineering.fb.com/feed/',                    icon: '🔵', category: 'Big Tech' },
    { id: 'netflix',    name: 'Netflix Tech Blog',       feedUrl: 'https://netflixtechblog.com/feed',                   icon: '🎬', category: 'Big Tech' },
    { id: 'aws',        name: 'AWS Architecture',        feedUrl: 'https://aws.amazon.com/blogs/architecture/feed/',     icon: '☁️', category: 'Cloud' },
    { id: 'cloudflare', name: 'Cloudflare Blog',         feedUrl: 'https://blog.cloudflare.com/rss/',                   icon: '🔶', category: 'Cloud' },
    { id: 'github',     name: 'GitHub Blog',             feedUrl: 'https://github.blog/feed/',                          icon: '🐙', category: 'Developer Tools' },
    { id: 'google-dev', name: 'Google Developers',       feedUrl: 'https://developers.googleblog.com/feeds/posts/default?alt=rss', icon: '🔍', category: 'Big Tech' },
    { id: 'stripe',     name: 'Stripe Engineering',      feedUrl: 'https://stripe.com/blog/feed.rss',                   icon: '💳', category: 'Fintech' },
    { id: 'spotify',    name: 'Spotify Engineering',     feedUrl: 'https://engineering.atspotify.com/feed/',             icon: '🎵', category: 'Big Tech' },
    { id: 'dropbox',    name: 'Dropbox Tech Blog',       feedUrl: 'https://dropbox.tech/feed',                          icon: '📦', category: 'Big Tech' },
    { id: 'shopify',    name: 'Shopify Engineering',     feedUrl: 'https://shopify.engineering/blog.atom',               icon: '🛒', category: 'E-commerce' },
    { id: 'vercel',     name: 'Vercel Blog',             feedUrl: 'https://vercel.com/atom',                             icon: '▲',  category: 'Developer Tools', maxResponseBytes: FULL_TEXT_FEED_MAX_BYTES },
    { id: 'mozilla',    name: 'Mozilla Hacks',           feedUrl: 'https://hacks.mozilla.org/feed/',                     icon: '🦊', category: 'Web Platform' },
  ]);
}

// ============================================
// Community Sources (HN, Reddit, Dev.to)
// ============================================

export function communitySources() {
  return [
    new HackerNewsSource({ filter: 'front_page', minPoints: 100 }),
    new RedditSource({ subreddit: 'programming', minUpvotes: 200 }),
    new RedditSource({ subreddit: 'ExperiencedDevs', minUpvotes: 100 }),
    new DevToSource({ minReactions: 50 }),
    new GitHubTrendingSource({ minStars: 100 }),
  ];
}

// ============================================
// AI / ML Blogs
// ============================================

export function aiMLBlogs() {
  return [
    ...createRSSSources(createOfficialAIFeedConfigs()),
    new RedditSource({ subreddit: 'MachineLearning', minUpvotes: 150 }),
    new HackerNewsSource({ query: 'AI LLM', minPoints: 80 }),
  ];
}

// ============================================
// AI News Sources — daily driver (11 sources)
// Launches, research, and industry news
// ============================================

export function aiNewsSources() {
  return [
    ...createRSSSources([
      ...createOfficialAIFeedConfigs(),
      { id: 'techcrunch-ai',  name: 'TechCrunch AI',     feedUrl: 'https://techcrunch.com/category/artificial-intelligence/feed/', icon: '💚', category: 'AI News' },
      { id: 'verge-ai',       name: 'The Verge AI',      feedUrl: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', icon: '🔮', category: 'AI News' },
      { id: 'ars-ai',         name: 'Ars Technica AI',   feedUrl: 'https://arstechnica.com/ai/feed/',           icon: '🔬', category: 'AI News' },
      { id: 'wired-ai',       name: 'WIRED AI',          feedUrl: 'https://www.wired.com/feed/tag/ai/latest/rss', icon: '🧵', category: 'AI News' },
      { id: 'mit-tech-review-ai', name: 'MIT Technology Review AI', feedUrl: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', icon: '🎓', category: 'AI News' },
      { id: 'ieee-spectrum-ai', name: 'IEEE Spectrum AI', feedUrl: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss', icon: '⚡', category: 'AI News' },
      // Reddit answers unauthenticated .json requests with 403, so both AI subreddits are
      // read through one RSS request (top posts of the last day; the feed has no scores).
      { id: 'reddit-ai', name: 'r/LocalLLaMA + r/artificial', feedUrl: 'https://www.reddit.com/r/LocalLLaMA+artificial/top.rss?t=day&limit=25', icon: '🔴', category: 'Community', contentTrailer: REDDIT_FOOTER },
    ]),
    new HackerNewsSource({ query: 'AI LLM GPT OpenAI Anthropic', minPoints: 80 }),
  ];
}

// ============================================
// AI Deep-Dive Sources — weekly gems (5 sources)
// Technical analysis, research, strategy
// ============================================

export function aiDeepDiveSources() {
  return createRSSSources([
    { id: 'lilianweng',     name: 'Lilian Weng',        feedUrl: 'https://lilianweng.github.io/index.xml',              icon: '📝', category: 'AI Deep-Dive' },
    { id: 'latentspace',    name: 'Latent Space',       feedUrl: 'https://www.latent.space/feed',                       icon: '🎙️', category: 'AI Deep-Dive' },
    { id: 'ahead-of-ai',   name: 'Ahead of AI',        feedUrl: 'https://magazine.sebastianraschka.com/feed',           icon: '🔭', category: 'AI Deep-Dive', maxResponseBytes: FULL_TEXT_FEED_MAX_BYTES },
    { id: 'oneusefulthing', name: 'One Useful Thing',   feedUrl: 'https://www.oneusefulthing.org/feed',                 icon: '💡', category: 'AI Deep-Dive' },
    { id: 'import-ai',     name: 'Import AI',           feedUrl: 'https://importai.substack.com/feed',                  icon: '📬', category: 'AI Deep-Dive' },
  ]);
}

// ============================================
// DevOps Sources
// ============================================

export function devopsSources() {
  return [
    ...createRSSSources([
      { id: 'cloudflare-devops', name: 'Cloudflare Blog',  feedUrl: 'https://blog.cloudflare.com/rss/',         icon: '🔶', category: 'DevOps' },
      { id: 'hashicorp',         name: 'HashiCorp Blog',   feedUrl: 'https://www.hashicorp.com/blog/feed.xml',   icon: '🔧', category: 'DevOps' },
    ]),
    new RedditSource({ subreddit: 'devops', minUpvotes: 100 }),
    new DevToSource({ tag: 'devops', minReactions: 30 }),
  ];
}

// ============================================
// Mobile Development Sources
// ============================================

export function mobileSources() {
  return [
    ...createRSSSources([
      { id: 'android-dev', name: 'Android Developers',  feedUrl: 'https://feeds.feedburner.com/blogspot/hsDu',  icon: '🤖', category: 'Mobile' },
      { id: 'swift-blog',  name: 'Swift.org Blog',      feedUrl: 'https://www.swift.org/atom.xml',              icon: '🍎', category: 'Mobile' },
    ]),
    new RedditSource({ subreddit: 'androiddev', minUpvotes: 80 }),
    new RedditSource({ subreddit: 'iOSProgramming', minUpvotes: 50 }),
  ];
}
