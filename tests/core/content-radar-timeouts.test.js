import test from 'node:test';
import assert from 'node:assert/strict';

import { AIPlugin, OutputPlugin, SourcePlugin } from '../../src/core/contracts.js';
import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { TELEGRAM_REQUEST_TIMEOUT_MS } from '../../src/outputs/telegram.js';
import { RecordingAI, RecordingOutput, RecordingSource } from '../helpers/fakes.js';

const article = {
  id: 'timeout-article',
  title: 'Bounded operation',
  url: 'https://example.com/timeout',
  content: 'Details',
  source: 'Timeout Source',
};

test('never-resolving source settles and a later reservation retry remains possible', async () => {
  let now = new Date('2026-07-20T00:00:00.000Z');
  class RecoveringSource extends SourcePlugin {
    calls = 0;
    recovered = false;
    get id() { return 'recovering-source'; }
    get name() { return 'Recovering Source'; }
    async fetchWithDiagnostics() {
      this.calls += 1;
      if (!this.recovered) return new Promise(() => {});
      return { articles: [article], diagnostic: { status: 'success', articleCount: 1 } };
    }
  }
  const source = new RecoveringSource();
  const output = new RecordingOutput();
  const engine = new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI('digest'))
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({
      channelId: 'telegram-main',
      maxRetries: 0,
      sourceTimeoutMs: 20,
      clock: () => new Date(now),
    });

  const timedOut = await engine.run({ requestId: 'source-timeout-request' });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.reason, 'sources_failed');
  assert.equal(output.calls.length, 0);

  source.recovered = true;
  now = new Date('2026-07-20T00:01:01.000Z');
  const recovered = await engine.run({ requestId: 'source-timeout-retry' });
  assert.equal(recovered.status, 'success');
  assert.equal(output.calls.length, 1);
});

test('never-resolving AI attempt times out durably and retries without publishing twice', async () => {
  let now = new Date('2026-07-20T00:00:00.000Z');
  class RecoveringAI extends AIPlugin {
    calls = 0;
    get id() { return 'recovering-ai'; }
    get name() { return 'Recovering AI'; }
    async summarize() {
      this.calls += 1;
      if (this.calls === 1) return new Promise(() => {});
      return { text: 'recovered digest' };
    }
  }
  const ai = new RecoveringAI();
  const output = new RecordingOutput();
  const engine = new ContentRadar()
    .addSource(new RecordingSource([article]))
    .useAI(ai)
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({
      channelId: 'telegram-main',
      maxRetries: 0,
      generationTimeoutMs: 20,
      clock: () => new Date(now),
    });

  const timedOut = await engine.run({ requestId: 'ai-timeout-request' });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.reason, 'generation_retry_scheduled');
  assert.equal(output.calls.length, 0);

  now = new Date('2026-07-20T00:00:02.000Z');
  const recovered = await engine.run({ requestId: 'ai-timeout-request' });
  assert.equal(recovered.status, 'success');
  assert.equal(ai.calls, 2);
  assert.equal(output.calls.length, 1);
});

test('never-resolving output is aborted before its lease and becomes a manual ambiguity', async () => {
  class HangingOutput extends OutputPlugin {
    calls = 0;
    aborted = false;
    get id() { return 'hanging-output'; }
    get name() { return 'Hanging Output'; }
    get deliveryKey() { return 'hanging:destination'; }
    async send(_content, options) {
      this.calls += 1;
      options.signal.addEventListener('abort', () => { this.aborted = true; }, { once: true });
      return new Promise(() => {});
    }
  }
  const output = new HangingOutput();
  const engine = new ContentRadar()
    .addSource(new RecordingSource([article]))
    .useAI(new RecordingAI('digest'))
    .addOutput(output)
    .useDeliveryStore(new MemoryDeliveryStore({ durable: true }))
    .configure({
      channelId: 'telegram-main',
      maxRetries: 0,
      attemptTimeoutMs: 100,
      outputTimeoutMs: 20,
    });

  const timedOut = await engine.run({ requestId: 'output-timeout-request' });
  assert.equal(timedOut.status, 'ambiguous');
  assert.equal(timedOut.reason, 'output_needs_reconciliation');
  assert.equal(output.calls, 1);
  assert.equal(output.aborted, true);

  const replay = await engine.run({ requestId: 'output-timeout-request' });
  assert.equal(replay.status, 'ambiguous');
  assert.equal(output.calls, 1);
});

test('default time budgets nest so a provider can answer before its attempt lapses', () => {
  const { attemptTimeoutMs, outputTimeoutMs, generationTimeoutMs } = new ContentRadar().options;

  assert.ok(
    TELEGRAM_REQUEST_TIMEOUT_MS < outputTimeoutMs,
    'the engine must not abort a Telegram request before the request times out itself',
  );
  assert.ok(outputTimeoutMs < attemptTimeoutMs, 'an output call must finish inside its attempt lease');
  assert.ok(generationTimeoutMs < attemptTimeoutMs, 'a generation call must finish inside its attempt lease');

  const operatorMachine = new DeliveryStateMachine({
    store: new MemoryDeliveryStore({ durable: true }),
    channelId: 'telegram-main',
  });
  assert.equal(
    operatorMachine.attemptTimeoutMs,
    attemptTimeoutMs,
    'operator retries grant the same lease as scheduled runs',
  );
});
