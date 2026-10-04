import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ClaudeAI } from '../../src/ai/claude.js';
import { OpenAICompatibleAI } from '../../src/ai/openai-compat.js';
import {
  ENGLISH_OUTPUT_RULES,
  VIETNAMESE_OUTPUT_RULES,
  buildHookPrompt,
  buildPrompt,
  buildPromptForDelivery,
  outputRulesFor,
  resolvePromptLanguage,
} from '../../src/ai/_prompts.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { ContentRadar } from '../../src/core/engine.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

const article = {
  title: 'Cloudflare introduces Agent Lee',
  source: 'Cloudflare',
  url: 'https://example.test/agent-lee',
  content: 'Agent Lee combines Workers, KV, D1 and R2 for AI agent workflows.',
};

test('Telegram hook prompt requires a short title, summary, and source link', () => {
  const prompt = buildHookPrompt(article, { platform: 'telegram', style: 'digest' });

  assert.match(prompt.system, /Dòng đầu là tiêu đề bài viết/);
  assert.match(prompt.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.match(prompt.system, /không quá 700 ký tự/);
  assert.match(prompt.system, /Link gốc ở cuối/);
  assert.doesNotMatch(prompt.system, /3-5 câu/);
  assert.doesNotMatch(prompt.system, /Dan Tech Content Radar/);
});

test('Facebook hook prompts sign posts with the Content Radar brand', () => {
  for (const platform of ['facebook']) {
    const prompt = buildHookPrompt(article, { platform, style: 'digest' });

    assert.match(prompt.system, /End with "— Dan Tech Content Radar"/, platform);
    assert.doesNotMatch(prompt.system, /Daily News/, platform);
  }
});

test('digest prompt opens with the Content Radar header', () => {
  const prompt = buildPromptForDelivery([article], { deliveryMode: 'digest', platform: 'telegram' });

  assert.match(prompt.system, /📡 Dan Tech Content Radar - \[DD\/MM\/YYYY\]/);
  assert.doesNotMatch(prompt.system, /Daily Tech Digest/);
});

test('Telegram hot-take style still resolves to the concise news-summary contract', () => {
  const prompt = buildHookPrompt(article, { platform: 'telegram', style: 'hot_take' });

  assert.match(prompt.system, /Chỉ tóm tắt thông tin trong article/);
  assert.match(prompt.system, /Không thêm viewpoint, opinion/);
  assert.doesNotMatch(prompt.system, /Viết 1 post hot take/);
});

test('non-Telegram hook prompts keep their existing editorial structure', () => {
  const prompt = buildHookPrompt(article, { platform: 'facebook', style: 'digest' });

  assert.match(prompt.system, /3-5 câu/);
  assert.doesNotMatch(prompt.system, /không quá 700 ký tự/);
});

test('delivery prompt selector uses the concise hook only for one-article drip mode', () => {
  const drip = buildPromptForDelivery([article], { deliveryMode: 'drip', platform: 'telegram' });
  const digest = buildPromptForDelivery([article], { deliveryMode: 'digest', platform: 'telegram' });

  assert.match(drip.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.doesNotMatch(digest.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
});

test('bundled AI providers send the concise hook prompt for Telegram drip delivery', async () => {
  let claudeBody;
  const claude = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      claudeBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'summary' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    },
  });

  let openAIBody;
  const openAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      openAIBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'summary' } }],
      }), { status: 200 });
    },
  });

  const options = { deliveryMode: 'drip', platform: 'telegram', style: 'digest' };
  await claude.summarize([article], options);
  await openAI.summarize([article], options);

  assert.match(claudeBody.system, /đúng 2-3 câu ngắn chỉ tóm tắt/);
  assert.match(openAIBody.messages[0].content, /đúng 2-3 câu ngắn chỉ tóm tắt/);
});

// Byte-identical lock for the default Vietnamese prompts. Digests cover the
// full text sent to providers; dates are normalized so the lock is stable
// across time zones. Update a digest only for an intentional prompt change.
const SNAPSHOT_AUDIENCE = 'nguoi lam IT Viet Nam: developers, engineers, product, data, security, operations, technical leaders';
const SNAPSHOT_STYLES = ['digest', 'bullet', 'hot_take', 'thread', 'newsletter', 'weekly', 'mustread', 'unknown-style'];
const SNAPSHOT_PLATFORMS = ['telegram', 'facebook', 'unknown-platform'];
const SNAPSHOT_RANDOM_VALUES = [0, 0.5, 0.99];

const richArticle = {
  title: 'Kubernetes 1.40 ships sidecar containers as GA',
  source: 'Kubernetes Blog',
  url: 'https://example.test/k8s-140',
  content: 'Sidecar containers graduate to GA with ordered startup and shutdown guarantees. '.repeat(20),
  category: 'DevOps',
  meta: { icon: '☸️', score: 87, alsoFrom: ['Hacker News', 'r/kubernetes'], points: 412, upvotes: 1200, stars: 99 },
};

const groupedArticles = [
  { ...article, category: 'AI/ML', meta: { icon: '🔶' } },
  richArticle,
  { title: 'PostgreSQL 18 adds asynchronous I/O', source: 'PostgreSQL', url: 'https://example.test/pg-18', category: 'Databases' },
];

function promptDigest(cases) {
  const normalized = JSON.stringify(cases).replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '{{date}}');
  return createHash('sha256').update(normalized).digest('hex');
}

function digestPromptCases() {
  const cases = [];
  for (const style of SNAPSHOT_STYLES) {
    for (const platform of SNAPSHOT_PLATFORMS) {
      for (const audience of [undefined, SNAPSHOT_AUDIENCE]) {
        cases.push({ style, platform, audience, ...buildPrompt(groupedArticles, { style, platform, audience }) });
      }
    }
  }
  cases.push({ name: 'single-category', ...buildPrompt([richArticle], { audience: SNAPSHOT_AUDIENCE }) });
  cases.push({ name: 'no-options', ...buildPrompt(groupedArticles) });
  return cases;
}

function hookPromptCases(t) {
  const random = t.mock.method(Math, 'random', () => 0);
  const cases = [];
  for (const value of SNAPSHOT_RANDOM_VALUES) {
    random.mock.mockImplementation(() => value);
    for (const platform of SNAPSHOT_PLATFORMS) {
      for (const style of ['digest', 'hot_take', 'bullet']) {
        for (const audience of [undefined, SNAPSHOT_AUDIENCE]) {
          for (const item of [article, richArticle]) {
            cases.push({ value, platform, style, audience, ...buildHookPrompt(item, { platform, style, audience }) });
          }
        }
      }
    }
  }
  cases.push({ name: 'no-options', ...buildHookPrompt(article) });
  return cases;
}

function deliveryPromptCases(t) {
  t.mock.method(Math, 'random', () => 0);
  const options = { platform: 'telegram', style: 'digest', audience: SNAPSHOT_AUDIENCE };
  return [
    buildPromptForDelivery([article], { ...options, deliveryMode: 'drip' }),
    buildPromptForDelivery([article], { ...options, platform: 'facebook', deliveryMode: 'drip' }),
    buildPromptForDelivery(groupedArticles, { ...options, deliveryMode: 'drip' }),
    buildPromptForDelivery([article], { ...options, deliveryMode: 'digest' }),
    buildPromptForDelivery(groupedArticles, options),
  ];
}

async function providerRequestCases(t) {
  t.mock.method(Math, 'random', () => 0);
  const bodies = [];
  const claude = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      bodies.push({ provider: 'claude', ...JSON.parse(init.body) });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'summary' }] }), { status: 200 });
    },
  });
  const openAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      bodies.push({ provider: 'openai-compatible', ...JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'summary' } }] }), { status: 200 });
    },
  });
  const channel = { platform: 'telegram', style: 'digest', audience: SNAPSHOT_AUDIENCE, language: 'vi' };
  const requests = [
    [[article], { ...channel, deliveryMode: 'drip' }],
    [groupedArticles, { ...channel, deliveryMode: 'digest' }],
    [[article], { systemPrompt: 'Legacy override prompt.' }],
    [[article], { systemPrompt: `Legacy override prompt.\n\n${VIETNAMESE_OUTPUT_RULES}` }],
    [[article], { _rawUserPrompt: 'Raw user prompt.', deliveryMode: 'digest' }],
    [[article], {}],
  ];
  for (const provider of [claude, openAI]) {
    for (const [articles, options] of requests) await provider.summarize(articles, options);
  }
  return bodies;
}

test('default Vietnamese digest prompts are byte-identical to the locked output', () => {
  const digest = promptDigest(digestPromptCases());
  assert.equal(digest, '720a92c7ec4b11ca5bee0524d917fad984e144bda062718a6b8e6a91cd3bdf2c', `digest prompt snapshot changed: ${digest}`);
});

test('default Vietnamese hook prompts are byte-identical to the locked output', t => {
  const digest = promptDigest(hookPromptCases(t));
  assert.equal(digest, '62daec69b045ee8d4aca47c8971a02c190eda97b97c8b7c7c7a5e2ed8c2b9aa4', `hook prompt snapshot changed: ${digest}`);
});

test('default delivery prompt selection is byte-identical to the locked output', t => {
  const digest = promptDigest(deliveryPromptCases(t));
  assert.equal(digest, 'dc86bec207ccc53ffb52c5b163a98bc4bfaa5bfd111cc2845fb92010af95b56e', `delivery prompt snapshot changed: ${digest}`);
});

test('bundled providers send byte-identical default Vietnamese requests', async t => {
  const digest = promptDigest(await providerRequestCases(t));
  assert.equal(digest, 'dce7cd5f8beaf64c3b264718bc5666911a8a831185813f5a0fb71fe95f326d26', `provider request snapshot changed: ${digest}`);
});

test('an explicit vi language matches the default prompts exactly', t => {
  t.mock.method(Math, 'random', () => 0.5);
  for (const style of SNAPSHOT_STYLES) {
    for (const platform of SNAPSHOT_PLATFORMS) {
      const options = { style, platform, audience: SNAPSHOT_AUDIENCE };
      assert.deepEqual(buildPrompt(groupedArticles, { ...options, language: 'vi' }), buildPrompt(groupedArticles, options));
      assert.deepEqual(buildHookPrompt(article, { ...options, language: 'vi' }), buildHookPrompt(article, options));
    }
  }
});

const SOURCE_DATA_HEADING = 'SOURCE DATA RULES:';
const VIETNAMESE_VOICE_HEADING = 'GIỌNG VIẾT:';
const CUSTOM_PROMPT = 'You are the editor of an internal platform-engineering bulletin. Focus on migration risk.';

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

test('English digest prompts use English output rules, style, and user message', () => {
  const prompt = buildPrompt(groupedArticles, { language: 'en', style: 'digest', audience: 'platform engineers', platform: 'telegram' });

  assert.ok(prompt.system.startsWith(ENGLISH_OUTPUT_RULES));
  assert.match(prompt.system, /You are a tech content curator & editorial analyst for platform engineers\./);
  assert.match(prompt.system, /Use Telegram formatting: \*bold\*, _italic_/);
  assert.ok(prompt.system.includes(SOURCE_DATA_HEADING));
  assert.ok(!prompt.system.includes(VIETNAMESE_OUTPUT_RULES));
  assert.ok(!prompt.system.includes(VIETNAMESE_VOICE_HEADING));
  assert.match(prompt.user, /^Today is \d{2}\/\d{2}\/\d{4}\.\n\nHere is the list of articles:/);
  assert.match(prompt.user, /Write the content in English\.$/);
});

test('English hook prompts keep the Telegram caption contract without Vietnamese voice', () => {
  const prompt = buildHookPrompt(article, { language: 'en', platform: 'telegram', style: 'digest', audience: 'platform engineers' });

  assert.match(prompt.system, /^Write one short summary post about the tech article below for platform engineers\./);
  assert.match(prompt.system, /exactly 2-3 short sentences/);
  assert.match(prompt.system, /under 700 characters/);
  assert.ok(prompt.system.includes(ENGLISH_OUTPUT_RULES));
  assert.ok(prompt.system.includes(SOURCE_DATA_HEADING));
  assert.ok(!prompt.system.includes(VIETNAMESE_OUTPUT_RULES));
  assert.ok(!prompt.system.includes(VIETNAMESE_VOICE_HEADING));
  assert.doesNotMatch(prompt.system, /Vietnglish/);
  assert.match(prompt.user, /Write the post in English\.$/);
});

test('every hook platform has English rules that keep the platform constraints', () => {
  for (const platform of ['facebook']) {
    const prompt = buildHookPrompt(article, { language: 'en', platform, style: 'hot_take' });
    assert.match(prompt.system, /End with "— Dan Tech Content Radar"/, platform);
    assert.doesNotMatch(prompt.system, /Vietnglish/, platform);
    assert.ok(!prompt.system.includes(VIETNAMESE_OUTPUT_RULES), platform);
  }
});

test('unknown prompt languages fall back to Vietnamese', t => {
  t.mock.method(Math, 'random', () => 0);
  const options = { style: 'digest', platform: 'telegram', audience: SNAPSHOT_AUDIENCE };

  assert.equal(resolvePromptLanguage('fr'), 'vi');
  assert.equal(resolvePromptLanguage(undefined), 'vi');
  assert.equal(outputRulesFor('fr'), VIETNAMESE_OUTPUT_RULES);
  assert.equal(outputRulesFor('en'), ENGLISH_OUTPUT_RULES);
  assert.deepEqual(buildPrompt(groupedArticles, { ...options, language: 'fr' }), buildPrompt(groupedArticles, options));
  assert.deepEqual(buildHookPrompt(article, { ...options, language: 'fr' }), buildHookPrompt(article, options));
});

test('a custom system prompt replaces only the style section of digest prompts', () => {
  for (const language of ['vi', 'en']) {
    const options = { language, style: 'digest', audience: SNAPSHOT_AUDIENCE, platform: 'telegram' };
    const standard = buildPrompt(groupedArticles, options);
    const custom = buildPrompt(groupedArticles, { ...options, customSystemPrompt: `  ${CUSTOM_PROMPT}\n` });
    const rules = outputRulesFor(language);
    const platformRules = standard.system.slice(standard.system.lastIndexOf('FORMAT RULES:'));

    assert.equal(custom.system, `${rules}\n\n${CUSTOM_PROMPT}\n\n${standard.system.slice(standard.system.indexOf(SOURCE_DATA_HEADING))}`, language);
    assert.ok(custom.system.endsWith(platformRules), language);
    assert.doesNotMatch(custom.system, /Dan Tech Content Radar - \[DD\/MM\/YYYY\]|DAN TECH CONTENT RADAR/, language);
    assert.equal(custom.user, standard.user, language);
  }
});

test('a custom system prompt replaces only the editorial section of hook prompts', t => {
  t.mock.method(Math, 'random', () => 0);
  for (const language of ['vi', 'en']) {
    const options = { language, platform: 'telegram', style: 'digest', audience: SNAPSHOT_AUDIENCE };
    const standard = buildHookPrompt(article, options);
    const custom = buildHookPrompt(article, { ...options, customSystemPrompt: CUSTOM_PROMPT });
    const rules = outputRulesFor(language);

    assert.equal(custom.system, `${CUSTOM_PROMPT}\n\n${standard.system.slice(standard.system.indexOf(rules))}`, language);
    assert.ok(custom.system.includes(SOURCE_DATA_HEADING), language);
    assert.match(custom.system, /700/, language);
    assert.doesNotMatch(custom.system, /Viết 1 post tóm tắt ngắn|Write one short summary post/, language);
    assert.equal(custom.user, standard.user, language);
  }
});

test('a blank custom system prompt keeps the built-in prompt', t => {
  t.mock.method(Math, 'random', () => 0);
  const options = { style: 'digest', platform: 'telegram', audience: SNAPSHOT_AUDIENCE };
  for (const customSystemPrompt of ['', '   \n', null, 42]) {
    assert.deepEqual(buildPrompt(groupedArticles, { ...options, customSystemPrompt }), buildPrompt(groupedArticles, options));
    assert.deepEqual(buildHookPrompt(article, { ...options, customSystemPrompt }), buildHookPrompt(article, options));
  }
});

function capturingProviders() {
  const bodies = { claude: [], openai: [] };
  const claude = new ClaudeAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      bodies.claude.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'summary' }] }), { status: 200 });
    },
  });
  const openAI = new OpenAICompatibleAI({
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      bodies.openai.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'summary' } }] }), { status: 200 });
    },
  });
  return {
    providers: [claude, openAI],
    systems: () => [...bodies.claude.map(body => body.system), ...bodies.openai.map(body => body.messages[0].content)],
    users: () => [...bodies.claude.map(body => body.messages[0].content), ...bodies.openai.map(body => body.messages[1].content)],
  };
}

test('bundled providers forward the custom system prompt and keep the safety blocks', async () => {
  const capture = capturingProviders();
  for (const provider of capture.providers) {
    await provider.summarize([article], { deliveryMode: 'drip', platform: 'telegram', customSystemPrompt: CUSTOM_PROMPT });
    await provider.summarize(groupedArticles, { deliveryMode: 'digest', platform: 'telegram', customSystemPrompt: CUSTOM_PROMPT });
  }

  for (const system of capture.systems()) {
    assert.ok(system.includes(CUSTOM_PROMPT));
    assert.equal(occurrences(system, VIETNAMESE_OUTPUT_RULES), 1);
    assert.ok(system.includes(SOURCE_DATA_HEADING));
    assert.match(system, /FORMAT RULES:|QUY TẮC:/);
  }
});

test('bundled providers enforce the requested language rules', async () => {
  const capture = capturingProviders();
  for (const provider of capture.providers) {
    await provider.summarize([article], { language: 'en', deliveryMode: 'drip', platform: 'telegram' });
    await provider.summarize([article], { language: 'en', systemPrompt: 'Legacy override prompt.' });
  }

  const systems = capture.systems();
  for (const system of systems) {
    assert.equal(occurrences(system, ENGLISH_OUTPUT_RULES), 1);
    assert.ok(!system.includes(VIETNAMESE_OUTPUT_RULES));
  }
  assert.ok(systems.filter(system => system.startsWith('Legacy override prompt.')).length === 2);
  for (const user of capture.users()) assert.match(user, /in English\.$/);
});

test('a legacy system prompt still replaces the custom system prompt entirely', async () => {
  const capture = capturingProviders();
  for (const provider of capture.providers) {
    await provider.summarize([article], { systemPrompt: 'Legacy override prompt.', customSystemPrompt: CUSTOM_PROMPT });
  }

  for (const system of capture.systems()) {
    assert.equal(system, `Legacy override prompt.\n\n${VIETNAMESE_OUTPUT_RULES}`);
  }
});

function forwardingEngine({ ai, options = {} }) {
  return new ContentRadar()
    .addSource(new RecordingSource([{
      id: 'k8s-140', title: 'Kubernetes 1.40 ships sidecar containers', url: 'https://example.test/k8s-140',
      content: 'Sidecar containers are GA.', source: 'Kubernetes Blog',
    }]))
    .useAI(ai)
    .addOutput(new RecordingOutput())
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0, ...options });
}

function summarizeOptions(call) {
  const { signal, ...rest } = call.options;
  assert.ok(signal !== undefined, 'the engine passes an abort signal');
  return rest;
}

test('the engine sends the unchanged default options to every generation path', async () => {
  const ai = new RecordingAI('hook');
  await forwardingEngine({ ai }).run({ dryRun: true });
  await forwardingEngine({ ai }).runDrip({ dryRun: true, batchSize: 1 });
  await forwardingEngine({ ai }).runDrip({ batchSize: 1 });

  assert.equal(ai.calls.length, 3);
  assert.deepEqual(ai.calls.map(summarizeOptions), [
    { language: 'vi', style: 'digest', audience: 'IT professionals', platform: 'telegram', deliveryMode: 'digest' },
    { language: 'vi', style: 'digest', audience: 'IT professionals', platform: 'telegram', deliveryMode: 'drip' },
    { language: 'vi', style: 'digest', audience: 'IT professionals', platform: 'telegram', deliveryMode: 'drip' },
  ]);
});

test('the engine forwards the configured language and custom system prompt to every generation path', async () => {
  const ai = new RecordingAI('hook');
  const options = { language: 'en', customSystemPrompt: CUSTOM_PROMPT, audience: 'platform engineers' };
  await forwardingEngine({ ai, options }).run({ dryRun: true });
  await forwardingEngine({ ai, options }).runDrip({ dryRun: true, batchSize: 1 });
  await forwardingEngine({ ai, options }).runDrip({ batchSize: 1 });

  assert.equal(ai.calls.length, 3);
  for (const [index, deliveryMode] of ['digest', 'drip', 'drip'].entries()) {
    assert.deepEqual(summarizeOptions(ai.calls[index]), {
      language: 'en',
      style: 'digest',
      audience: 'platform engineers',
      platform: 'telegram',
      customSystemPrompt: CUSTOM_PROMPT,
      deliveryMode,
    });
  }
});
