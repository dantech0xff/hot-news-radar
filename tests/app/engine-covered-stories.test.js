import test from 'node:test';
import assert from 'node:assert/strict';

import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';
import { mutableClock } from './helpers/runtime-fixture.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1_000;

function story(id, title) {
  return { id, title, url: `https://example.test/${id}`, content: title, source: 'Example' };
}

async function coveredScan({ options = {} } = {}) {
  const clock = mutableClock();
  const source = new RecordingSource([story('gpt-6', 'OpenAI ships GPT-6 for developers')]);
  const output = new RecordingOutput();
  const engine = new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock, ...options });
  assert.equal((await engine.runDrip({ batchSize: 2 })).status, 'success');
  source.articles = [
    story('gpt-6-recap', 'Developers get GPT-6 from OpenAI today'),
    story('rust-2', 'Rust 2.0 compiler ships async closures'),
  ];
  clock.advance(SCAN_INTERVAL_MS);
  const second = await engine.runDrip({ batchSize: 2 });
  return { second, output };
}

test('radar scans report candidates skipped as already-covered stories to an optional observer', async () => {
  const reported = [];
  const observed = await coveredScan({ options: { onCoveredStoriesExcluded: articles => reported.push(articles.map(article => article.id)) } });
  const plain = await coveredScan();

  assert.deepEqual(reported, [['gpt-6-recap']]);
  assert.deepEqual(observed.second.stats.selection, plain.second.stats.selection);
  assert.deepEqual(observed.second.stats.selection, { fetched: 2, fresh: 2, uncovered: 1, relevant: 1, ranked: 1, enqueued: 1 });
  assert.deepEqual(observed.output.calls.map(call => call.options.article.id), ['gpt-6', 'rust-2']);
});

test('a failing covered-story observer is logged and never changes delivery', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const { second, output } = await coveredScan({
    options: { onCoveredStoriesExcluded: () => { throw new Error('observer broke token=abc123'); } },
  });

  assert.equal(second.status, 'success');
  assert.equal(output.calls.length, 2);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(JSON.stringify(warnings.mock.calls[0].arguments).includes('abc123'), false);
});

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Posts a story, then scans two publishing days later when only a rewrite of it is on offer. */
async function rewriteTwoDaysLater({ sourceWindowHours } = {}) {
  const clock = mutableClock('2026-10-01T10:00:00.000Z');
  const source = new RecordingSource([story('gpt-6', 'OpenAI ships GPT-6 for developers')]);
  const output = new RecordingOutput();
  const engine = new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock, ...(sourceWindowHours && { sourceWindowHours }) });
  assert.equal((await engine.runDrip({ batchSize: 2 })).status, 'success');
  source.articles = [story('gpt-6-recap', 'Developers get GPT-6 from OpenAI today')];
  clock.advance(2 * DAY_MS);
  return { second: await engine.runDrip({ batchSize: 2 }), output };
}

test('a 48-hour source window also skips stories delivered two publishing days ago', async () => {
  const { second, output } = await rewriteTwoDaysLater({ sourceWindowHours: 48 });

  assert.equal(second.stats.selection.uncovered, 0);
  assert.equal(output.calls.length, 1);
});

test('the default 24-hour window covers only today and yesterday', async () => {
  const { second, output } = await rewriteTwoDaysLater();

  assert.equal(second.stats.selection.uncovered, 1);
  assert.equal(output.calls.length, 2);
});
