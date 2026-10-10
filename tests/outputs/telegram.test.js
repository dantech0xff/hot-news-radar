import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TELEGRAM_REQUEST_TIMEOUT_MS, TelegramOutput } from '../../src/outputs/telegram.js';
import {
  assertCanonicalResult,
  jsonResponse,
  noDelay,
  sequenceFetch,
  textResponse,
} from './test-helpers.js';

const config = {
  botToken: '123456:super-secret-token',
  chatId: '-1009876543210',
  sleep: noDelay,
};

function systemError(code, syscall) {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}

// fetch reports the real network error as the cause of a generic TypeError.
function fetchFailed(cause) {
  return new TypeError('fetch failed', { cause });
}

test('Telegram returns canonical success metadata and all message IDs', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 11 } }),
    jsonResponse(200, { ok: true, result: { message_id: 12 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send(`${'a'.repeat(4096)}\n\nsecond`);

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '11');
  assert.deepEqual(result.meta.successfulMessageIds, ['11', '12']);
  assert.equal(result.meta.parts, 2);
  assert.equal(transport.calls.length, 2);
});

test('Telegram stops at the first failed part and preserves partial mutation evidence', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 21 } }),
    jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: rejected' }),
    jsonResponse(200, { ok: true, result: { message_id: 23 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const content = ['a'.repeat(4090), 'b'.repeat(4090), 'c'.repeat(100)].join('\n\n');

  const result = await output.send(content);

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, '21');
  assert.deepEqual(result.meta.successfulMessageIds, ['21']);
  assert.equal(result.meta.partsAttempted, 2);
  assert.equal(result.meta.partsTotal, 3);
  assert.deepEqual(result.meta.partialMutation, {
    successfulSteps: 1,
    completedSteps: 1,
    totalSteps: 3,
    failedStep: 2,
    messageIds: ['21'],
  });
  assert.equal(result.meta.partResults[0].messageId, '21');
  assert.equal(result.meta.partResults[1].deliveryState, 'definitive_failure');
  assert.equal(transport.calls.length, 2);
});

test('Telegram only retries Markdown as plain text after definitive format rejection', async () => {
  const transport = sequenceFetch([
    jsonResponse(400, {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }),
    jsonResponse(200, { ok: true, result: { message_id: 31 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '31');
  assert.equal(result.meta.fallbackAttempted, true);
  assert.equal(transport.calls.length, 2);
  assert.equal(JSON.parse(transport.calls[1].init.body).parse_mode, undefined);
});

test('Telegram does not fallback after an ambiguous provider response', async () => {
  const transport = sequenceFetch([
    jsonResponse(503, { ok: false, description: "can't parse entities" }),
    jsonResponse(200, { ok: true, result: { message_id: 42 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(transport.calls.length, 1);
});

test('Telegram HTTP 5xx stays ambiguous even if the body claims a 4xx parse error', async () => {
  const transport = sequenceFetch([
    jsonResponse(503, {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }),
    jsonResponse(200, { ok: true, result: { message_id: 43 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('*formatted*');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, '400');
  assert.equal(transport.calls.length, 1);
});

test('Telegram invalid success envelopes are ambiguous and never retried as fallback', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: {} }),
    jsonResponse(200, { ok: true, result: { message_id: 44 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, 'invalid_response');
  assert.equal(transport.calls.length, 1);
});

test('Telegram aborts a never-resolving request and classifies it as ambiguous', async () => {
  let signal;
  const fetch = (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  };
  const output = new TelegramOutput({ ...config, fetch, timeoutMs: 5 });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.meta.providerCode, 'timeout');
  assert.equal(signal.aborted, true);
});

test('Telegram connection failures before the request is sent are definitive and retry automatically', async () => {
  const cases = [
    ['ECONNREFUSED', fetchFailed(systemError('ECONNREFUSED', 'connect'))],
    ['ENOTFOUND', fetchFailed(systemError('ENOTFOUND', 'getaddrinfo'))],
    ['EAI_AGAIN', fetchFailed(systemError('EAI_AGAIN', 'getaddrinfo'))],
    ['ETIMEDOUT', fetchFailed(systemError('ETIMEDOUT', 'connect'))],
    ['UND_ERR_CONNECT_TIMEOUT', fetchFailed(Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }))],
    // A host with several addresses fails with one error per address.
    ['ETIMEDOUT', fetchFailed(Object.assign(
      new AggregateError([systemError('ETIMEDOUT', 'connect'), systemError('ENETUNREACH', 'connect')]),
      { code: 'ETIMEDOUT' },
    ))],
  ];

  for (const [providerCode, failure] of cases) {
    const transport = sequenceFetch([() => { throw failure; }]);
    const output = new TelegramOutput({ ...config, fetch: transport.fetch });

    const result = await output.send('hello');

    assertCanonicalResult(result, 'definitive_failure', 'automatic');
    assert.equal(result.meta.providerCode, providerCode);
    assert.equal(transport.calls.length, 1);
  }
});

test('Telegram failures that may have reached Telegram stay ambiguous', async () => {
  const cases = [
    ['connection reset mid-request', fetchFailed(systemError('ECONNRESET', 'read')), 'network_error'],
    ['timeout on an established connection', fetchFailed(systemError('ETIMEDOUT', 'read')), 'network_error'],
    // An established connection can report these from `read` after the request was already written.
    ['EHOSTUNREACH on an established connection', fetchFailed(systemError('EHOSTUNREACH', 'read')), 'network_error'],
    ['ENETUNREACH on an established connection', fetchFailed(systemError('ENETUNREACH', 'read')), 'network_error'],
    ['connect code without its syscall', fetchFailed(Object.assign(new Error('refused'), {
      code: 'ECONNREFUSED',
    })), 'network_error'],
    ['unknown code without a syscall', fetchFailed(Object.assign(new Error('unknown'), {
      code: 'EWHATEVER',
    })), 'network_error'],
    ['socket closed by the other side', fetchFailed(Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    })), 'network_error'],
    ['one address refused and one reset', fetchFailed(new AggregateError([
      systemError('ECONNREFUSED', 'connect'),
      systemError('ECONNRESET', 'read'),
    ])), 'network_error'],
    ['fetch failed without a cause', new TypeError('fetch failed'), 'network_error'],
    ['unclassified error', new Error('boom'), 'network_error'],
    ['abort', new DOMException('This operation was aborted', 'AbortError'), 'aborted'],
    ['abort wrapping a connect error', new DOMException('This operation was aborted', {
      name: 'AbortError',
      cause: systemError('ECONNREFUSED', 'connect'),
    }), 'aborted'],
  ];

  for (const [label, failure, providerCode] of cases) {
    const transport = sequenceFetch([() => { throw failure; }]);
    const output = new TelegramOutput({ ...config, fetch: transport.fetch });

    const result = await output.send('hello');

    assertCanonicalResult(result, 'ambiguous', 'manual');
    assert.equal(result.meta.providerCode, providerCode, label);
    assert.equal(transport.calls.length, 1, label);
  }
});

test('Telegram connection failure after the first message part stays ambiguous', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 31 } }),
    () => { throw fetchFailed(systemError('ECONNREFUSED', 'connect')); },
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const content = ['a'.repeat(4090), 'b'.repeat(4090)].join('\n\n');

  const result = await output.send(content);

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, '31');
  assert.deepEqual(result.meta.successfulMessageIds, ['31']);
  assert.equal(transport.calls.length, 2);
});

test('Telegram connection failure after a posted photo stays ambiguous', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 61 } }),
    () => { throw fetchFailed(systemError('ECONNREFUSED', 'connect')); },
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('x'.repeat(1500), {
    articles: [{ imageUrl: 'https://example.test/image.png' }],
  });

  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(result.messageId, '61');
  assert.deepEqual(result.meta.successfulMessageIds, ['61']);
  assert.equal(transport.calls.length, 2);
});

test('Telegram connection failure on the plain-caption retry is retryable because nothing was posted', async () => {
  const transport = sequenceFetch([
    jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }),
    () => { throw fetchFailed(systemError('ECONNREFUSED', 'connect')); },
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('caption', { article: { imageUrl: 'https://example.test/image.png' } });

  assertCanonicalResult(result, 'definitive_failure', 'automatic');
  assert.equal(result.meta.fallbackAttempted, true);
  assert.equal(transport.calls.length, 2);
});

test('Telegram never follows a redirect and treats a redirect answer as uncertain', async () => {
  const transport = sequenceFetch([
    textResponse(307, '', { Location: 'https://elsewhere.example/hook' }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('hello');

  assert.equal(transport.calls[0].init.redirect, 'manual');
  assertCanonicalResult(result, 'ambiguous', 'manual');
  assert.equal(transport.calls.length, 1);
});

test('Telegram waits its own request timeout by default and honors an explicit one', async () => {
  const delays = [];
  const timers = {
    setTimeout: (_callback, ms) => { delays.push(ms); return delays.length; },
    clearTimeout: () => {},
  };
  const sent = () => sequenceFetch([jsonResponse(200, { ok: true, result: { message_id: 1 } })]).fetch;

  await new TelegramOutput({ ...config, ...timers, fetch: sent() }).send('hello');
  await new TelegramOutput({ ...config, ...timers, timeoutMs: 1234, fetch: sent() }).send('hello');

  assert.deepEqual(delays, [TELEGRAM_REQUEST_TIMEOUT_MS, 1234]);
});

test('Telegram 429 is a definitive automatic retry with bounded timing metadata', async () => {
  const now = () => Date.parse('2026-07-20T10:00:00.000Z');
  const transport = sequenceFetch([
    jsonResponse(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 7 },
    }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch, now });

  const result = await output.send('hello');

  assertCanonicalResult(result, 'definitive_failure', 'automatic');
  assert.equal(result.meta.providerCode, '429');
  assert.equal(result.meta.retryAfterMs, 7000);
  assert.equal(result.meta.nextAttemptAt, '2026-07-20T10:00:07.000Z');
});

test('Telegram sanitizes provider errors and never exposes its destination or token', async () => {
  const transport = sequenceFetch([
    jsonResponse(400, {
      ok: false,
      error_code: 400,
      description: 'Bad https://private.example/hook for -1009876543210 token 123456:super-secret-token',
    }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send('hello');
  const serialized = JSON.stringify(result);

  assertCanonicalResult(result, 'definitive_failure', 'never');
  assert.doesNotMatch(serialized, /private\.example/);
  assert.doesNotMatch(serialized, /-1009876543210/);
  assert.doesNotMatch(serialized, /super-secret-token/);
});

test('Telegram sends a short news post as a standard photo caption', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 50 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const url = 'https://example.test/news';
  const content = `*Important*\n\nA short summary. A second sentence.\n\n${url}`;

  const result = await output.send(content, {
    article: { imageUrl: 'https://example.test/image.png', url },
  });

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '50');
  assert.equal(result.meta.hasPhoto, true);
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0].url, /\/sendPhoto$/);
  assert.doesNotMatch(transport.calls[0].url, /Rich/);

  const body = JSON.parse(transport.calls[0].init.body);
  assert.equal(body.chat_id, config.chatId);
  assert.equal(body.photo, 'https://example.test/image.png');
  assert.equal(body.caption, content);
  assert.equal(body.parse_mode, 'Markdown');
});

test('Telegram deterministically keeps a generated single-news caption concise', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 51 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const url = 'https://example.test/news';

  const result = await output.send(`*Important*\n\n${'Long summary sentence. '.repeat(80)}\n\n${url}`, {
    article: { imageUrl: 'https://example.test/image.png', url },
  });

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0].url, /\/sendPhoto$/);
  const body = JSON.parse(transport.calls[0].init.body);
  assert.ok(body.caption.length <= 700);
  assert.match(body.caption, /\n\nhttps:\/\/example\.test\/news$/);
});

test('Telegram limits a generated news summary to three sentences', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 52 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const url = 'https://example.test/news';

  await output.send(`*Important*\n\nOne. Two. Three. Four. Five.\n\n${url}`, {
    article: { imageUrl: 'https://example.test/image.png', url },
  });

  const body = JSON.parse(transport.calls[0].init.body);
  assert.equal(body.caption, `*Important*\n\nOne. Two. Three.\n\n${url}`);
});

test('Telegram limits an inline generated news summary to three sentences', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 53 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const url = 'https://example.test/news';

  await output.send(`*Important* One. Two. Three. Four.\n\n${url}`, {
    article: { imageUrl: 'https://example.test/image.png', url },
  });

  const body = JSON.parse(transport.calls[0].init.body);
  assert.equal(body.caption, `*Important*\n\nOne. Two. Three.\n\n${url}`);
});

test('Telegram preserves long source URLs and cleans markdown link wrappers', async () => {
  const longUrl = `https://example.test/${'x'.repeat(690)}`;
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 54 } }),
    jsonResponse(200, { ok: true, result: { message_id: 55 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  await output.send(`*Important*\n\nOne sentence. Second sentence.\n\n[source](${longUrl})`, {
    article: { imageUrl: 'https://example.test/image.png', url: longUrl },
  });

  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[0].url, /\/sendPhoto$/);
  assert.equal(JSON.parse(transport.calls[0].init.body).caption, undefined);
  const textBody = JSON.parse(transport.calls[1].init.body);
  assert.ok(textBody.text.endsWith(longUrl));
  assert.equal(textBody.text.includes('[source]()'), false);
  assert.equal(textBody.text.includes('[source]'), false);
});

test('Telegram keeps an oversized source URL intact in the standard photo-plus-text flow', async () => {
  const longUrl = `https://example.test/${'x'.repeat(1_500)}`;
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 56 } }),
    jsonResponse(200, { ok: true, result: { message_id: 57 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });

  const result = await output.send(`*Important*\n\nOne sentence. Second sentence.\n\n${longUrl}`, {
    article: { imageUrl: 'https://example.test/image.png', url: longUrl },
  });

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.meta.parts, 2);
  assert.match(transport.calls[0].url, /\/sendPhoto$/);
  assert.match(transport.calls[1].url, /\/sendMessage$/);
  assert.equal(JSON.parse(transport.calls[0].init.body).caption, undefined);
  assert.ok(JSON.parse(transport.calls[1].init.body).text.endsWith(longUrl));
});

test('Telegram sends an unexpectedly long photo post as standard photo plus text', async () => {
  const transport = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 51 } }),
    jsonResponse(200, { ok: true, result: { message_id: 52 } }),
  ]);
  const output = new TelegramOutput({ ...config, fetch: transport.fetch });
  const content = `*Important*\n\n${'x'.repeat(1_500)}`;

  const result = await output.send(content, {
    articles: [{ imageUrl: 'https://example.test/image.png' }],
  });

  assertCanonicalResult(result, 'success', 'never');
  assert.equal(result.messageId, '51');
  assert.equal(result.meta.parts, 2);
  assert.deepEqual(result.meta.successfulMessageIds, ['51', '52']);
  assert.equal(result.meta.richMessageAttempted, undefined);
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[0].url, /\/sendPhoto$/);
  assert.match(transport.calls[1].url, /\/sendMessage$/);
  assert.equal(transport.calls.some(call => /sendRichMessage/.test(call.url)), false);

  const photoBody = JSON.parse(transport.calls[0].init.body);
  assert.equal(photoBody.photo, 'https://example.test/image.png');
  assert.equal(photoBody.caption, undefined);
  assert.equal(JSON.parse(transport.calls[1].init.body).text, content);
});

test('Telegram photo fallback is blocked after uncertainty and long-photo flows stop on failure', async () => {
  const uncertainPhoto = sequenceFetch([
    jsonResponse(500, { ok: false, description: 'upstream error' }),
    jsonResponse(200, { ok: true, result: { message_id: 51 } }),
  ]);
  const uncertainOutput = new TelegramOutput({ ...config, fetch: uncertainPhoto.fetch });

  const uncertain = await uncertainOutput.send('caption', {
    article: { imageUrl: 'https://example.test/image.png' },
  });

  assertCanonicalResult(uncertain, 'ambiguous', 'manual');
  assert.equal(uncertainPhoto.calls.length, 1);

  const partialPhoto = sequenceFetch([
    jsonResponse(200, { ok: true, result: { message_id: 61 } }),
    jsonResponse(400, { ok: false, error_code: 400, description: 'text rejected' }),
    jsonResponse(200, { ok: true, result: { message_id: 63 } }),
  ]);
  const partialOutput = new TelegramOutput({ ...config, fetch: partialPhoto.fetch });

  const partial = await partialOutput.send('x'.repeat(1500), {
    articles: [{ imageUrl: 'https://example.test/image.png' }],
  });

  assertCanonicalResult(partial, 'ambiguous', 'manual');
  assert.equal(partial.messageId, '61');
  assert.deepEqual(partial.meta.successfulMessageIds, ['61']);
  assert.equal(partial.meta.richMessageAttempted, undefined);
  assert.equal(partialPhoto.calls.length, 2);
});
