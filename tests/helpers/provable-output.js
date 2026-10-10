import { OutputPlugin } from '../../src/core/contracts.js';
import { ContentRadar } from '../../src/core/engine.js';
import { MemoryDeliveryStore } from '../../src/core/delivery-store.js';
import { DeliveryStateMachine } from '../../src/core/delivery-state-machine.js';
import { RecordingAI, RecordingSource } from './fakes.js';

export const SCAN_INTERVAL_MS = 15 * 60 * 1_000;

export const first = { id: 'a-1', title: 'Kubernetes ships sidecars', url: 'https://example.com/a-1', content: 'Details', source: 'Example' };
export const second = { id: 'a-2', title: 'Rust stabilizes async closures', url: 'https://example.com/a-2', content: 'Details', source: 'Example' };

/** The first send times out (ambiguous); `proof` is what the destination reveals afterwards. */
export class ProvableOutput extends OutputPlugin {
  constructor({ key = 'provable:destination', partial = false } = {}) {
    super();
    this.key = key;
    this.partial = partial;
    this.sends = [];
    this.lookups = [];
    this.timeoutNext = true;
    this.proof = null;
    this.lookupError = null;
    this.onLookup = null;
  }

  get id() { return 'provable-output'; }
  get name() { return 'Provable Output'; }
  get deliveryKey() { return this.key; }

  async send(content, options) {
    this.sends.push({ content, url: options.article?.url ?? options.articles?.[0]?.url });
    if (this.timeoutNext) {
      this.timeoutNext = false;
      if (this.partial) {
        // The first of two parts went out; only the rest is uncertain.
        return {
          success: false,
          messageId: 'part-1',
          meta: {
            deliveryState: 'ambiguous',
            retryDisposition: 'manual',
            sanitizedError: 'second part timed out',
            partialMutation: { successfulSteps: 1, completedSteps: 1, totalSteps: 2, failedStep: 2, messageIds: ['part-1'] },
          },
        };
      }
      throw new Error('network timeout');
    }
    return {
      success: true,
      messageId: `message-${this.sends.length}`,
      meta: { deliveryState: 'success', retryDisposition: 'never' },
    };
  }

  async findDelivered(query) {
    this.lookups.push(query);
    await this.onLookup?.(query);
    if (this.lookupError) throw this.lookupError;
    return this.proof;
  }
}

export function mutableClock(start = '2026-07-20T08:00:00.000Z') {
  let current = new Date(start);
  return {
    clock: () => new Date(current),
    advance(ms) { current = new Date(current.getTime() + ms); },
  };
}

export function setup({
  output = new ProvableOutput(),
  articles = [first],
  store = new MemoryDeliveryStore({ durable: true }),
  time = mutableClock(),
  options = {},
} = {}) {
  const source = new RecordingSource(articles);
  const engine = new ContentRadar()
    .addSource(source)
    .useAI(new RecordingAI('hook'))
    .addOutput(output)
    .useDeliveryStore(store)
    .configure({ channelId: 'telegram-main', maxRetries: 0, clock: time.clock, ...options });
  const machine = new DeliveryStateMachine({ store, channelId: 'telegram-main' });
  return { store, time, source, engine, machine, output };
}

export const mutationState = async machine => (await machine.getChannelState()).mutationState;
