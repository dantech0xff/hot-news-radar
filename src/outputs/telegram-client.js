const DEFAULT_TIMEOUT_MS = 15_000;
// Errno codes that prove a request never left this process, each paired with the syscall that must
// have raised it: name resolution or the TCP connect failed, so the provider cannot have seen the
// request. The syscall matters because an established connection can report ENETUNREACH or
// EHOSTUNREACH from `read` after the request was written. Resets, read timeouts, and closed sockets
// are deliberately absent; they can happen after the provider already acted.
const CONNECT_PHASE_SYSCALLS = new Map([
  ['ECONNREFUSED', 'connect'],
  ['ENETUNREACH', 'connect'],
  ['EHOSTUNREACH', 'connect'],
  ['ETIMEDOUT', 'connect'],
  ['ENOTFOUND', 'getaddrinfo'],
  ['EAI_AGAIN', 'getaddrinfo'],
]);
// undici and Node raise these themselves while connecting, so they carry no syscall.
const CONNECT_PHASE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
const MAX_CAUSE_DEPTH = 4;
const MAX_ERROR_LENGTH = 240;
const MAX_RESPONSE_BODY_BYTES = 8_192;
const MAX_RESPONSE_TEXT_BYTES = 2_000_000;
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_LIFECYCLES = new WeakMap();

export class OutputTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Provider request timed out after ${timeoutMs}ms`);
    this.name = 'OutputTimeoutError';
    this.code = 'timeout';
  }
}

/**
 * Resolve backward-compatible output dependencies from either config or a
 * separate dependency object. Injected transports keep tests fully offline.
 */
export function createOutputDependencies(config = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl
    || dependencies.fetch
    || config.fetchImpl
    || config.fetch
    || globalThis.fetch?.bind(globalThis);
  const now = resolveNow(dependencies) || resolveNow(config) || Date.now;

  return {
    fetchImpl,
    now,
    sleep: dependencies.sleep || config.sleep || defaultSleep,
    timeoutMs: normalizeTimeout(dependencies.timeoutMs ?? config.timeoutMs),
    setTimeoutImpl: dependencies.setTimeout || config.setTimeout || globalThis.setTimeout.bind(globalThis),
    clearTimeoutImpl: dependencies.clearTimeout || config.clearTimeout || globalThis.clearTimeout.bind(globalThis),
  };
}

/** Execute one provider request with an abort signal and a hard Promise bound. */
export async function fetchWithTimeout(fetchImpl, url, init = {}, dependencies = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('No fetch implementation is available');
  }

  const timeoutMs = normalizeTimeout(dependencies.timeoutMs);
  const setTimer = dependencies.setTimeoutImpl || globalThis.setTimeout.bind(globalThis);
  const clearTimer = dependencies.clearTimeoutImpl || globalThis.clearTimeout.bind(globalThis);
  const controller = new AbortController();
  const callerSignal = init.signal;
  let timer;
  let removeAbortListener;
  let headersReceived = false;

  const cleanup = () => {
    clearTimer(timer);
    removeAbortListener?.();
    removeAbortListener = null;
  };

  if (callerSignal) {
    const abortFromCaller = () => controller.abort(callerSignal.reason);
    if (callerSignal.aborted) abortFromCaller();
    else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      removeAbortListener = () => callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }

  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      const error = new OutputTimeoutError(timeoutMs);
      controller.abort(error);
      removeAbortListener?.();
      removeAbortListener = null;
      if (!headersReceived) reject(error);
    }, timeoutMs);
  });

  try {
    const request = Promise.resolve().then(() => fetchImpl(url, {
      ...init,
      signal: controller.signal,
    }));
    const response = await Promise.race([request, timeout]);
    headersReceived = true;
    if (response && typeof response === 'object') {
      RESPONSE_LIFECYCLES.set(response, { signal: controller.signal, cleanup });
    } else {
      cleanup();
    }
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Read and parse a provider response without buffering more than a small byte cap. */
export async function readResponseBody(response, maxBytes = MAX_RESPONSE_BODY_BYTES, byteCeiling = MAX_RESPONSE_BODY_BYTES) {
  return withResponseLifecycle(response, signal => readResponseBodyBounded(response, maxBytes, signal, { byteCeiling }));
}

/**
 * Read a text or HTML response (such as a public channel preview page) under the same timeout
 * lifecycle and a larger, still bounded, byte cap. `text` is empty when the body is missing,
 * oversized, or not valid UTF-8.
 */
export async function readResponseText(response, maxBytes = MAX_RESPONSE_TEXT_BYTES) {
  return withResponseLifecycle(response, signal => readResponseBodyBounded(response, maxBytes, signal, {
    byteCeiling: MAX_RESPONSE_TEXT_BYTES,
    asText: true,
  }));
}

async function withResponseLifecycle(response, read) {
  const lifecycle = response && typeof response === 'object' ? RESPONSE_LIFECYCLES.get(response) : null;
  try {
    return await read(lifecycle?.signal);
  } finally {
    lifecycle?.cleanup();
    if (response && typeof response === 'object') RESPONSE_LIFECYCLES.delete(response);
  }
}

async function readResponseBodyBounded(response, maxBytes, signal, { byteCeiling = MAX_RESPONSE_BODY_BYTES, asText = false } = {}) {
  const byteLimit = normalizeResponseBodyLimit(maxBytes, byteCeiling);
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    return { text: '', data: null, validJson: false };
  }

  if (declaredBodyLength(response) > byteLimit) {
    await discardResponseBody(response);
    return oversizedResponse();
  }

  let reader;
  const chunks = [];
  let totalBytes = 0;
  try {
    reader = body.getReader();
    while (true) {
      const result = await readWithAbort(reader, signal);
      if (!result || typeof result.done !== 'boolean') throw new TypeError('Invalid stream result');
      if (result.done) break;

      const chunk = asByteChunk(result.value);
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > byteLimit - totalBytes) {
        await cancelReader(reader);
        return oversizedResponse();
      }
      chunks.push(chunk.slice());
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    await cancelReader(reader);
    if (signal?.aborted) throw abortReason(signal);
    return invalidResponse();
  } finally {
    try { reader?.releaseLock(); } catch {}
  }

  if (totalBytes === 0) return { text: '', data: null, validJson: false };
  try {
    const bytes = joinChunks(chunks, totalBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (asText) return { text, data: null, validJson: false };
    return { text: '', data: JSON.parse(text), validJson: true };
  } catch {
    return invalidResponse();
  }
}

function readWithAbort(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => reader.read()).then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Provider request was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function successResult(messageId, meta = {}) {
  const normalizedId = normalizeMessageId(messageId);
  return {
    success: true,
    ...(normalizedId ? { messageId: normalizedId } : {}),
    meta: compactMeta({
      ...boundKnownMetadata(meta),
      deliveryState: 'success',
      retryDisposition: 'never',
    }),
  };
}

export function failureResult({
  deliveryState = 'ambiguous',
  retryDisposition = 'manual',
  error,
  providerCode,
  retryAfterMs,
  now = Date.now,
  messageId,
  meta = {},
} = {}) {
  const sanitizedError = sanitizeError(error);
  const normalizedCode = normalizeProviderCode(providerCode);
  const normalizedId = normalizeMessageId(messageId);
  const boundedRetryAfter = normalizeRetryAfter(retryAfterMs);
  const currentTime = safeNow(now);
  const nextAttemptAt = boundedRetryAfter === undefined
    ? undefined
    : new Date(currentTime + boundedRetryAfter).toISOString();

  return {
    success: false,
    ...(normalizedId ? { messageId: normalizedId } : {}),
    error: sanitizedError,
    meta: compactMeta({
      ...boundKnownMetadata(meta),
      deliveryState,
      retryDisposition,
      providerCode: normalizedCode,
      sanitizedError,
      retryAfterMs: boundedRetryAfter,
      nextAttemptAt,
    }),
  };
}

/** Classify a provider's explicit HTTP/envelope rejection. */
export function httpFailureResult({
  status,
  headers,
  error,
  providerCode,
  retryAfterMs,
  now = Date.now,
  meta,
} = {}) {
  const numericStatus = Number(status);
  const resolvedRetryAfter = numericStatus === 429
    ? retryAfterMs ?? parseRetryAfter(headers, now)
    : undefined;

  if (numericStatus === 429) {
    return failureResult({
      deliveryState: 'definitive_failure',
      retryDisposition: 'automatic',
      error: error || 'Provider rate limit rejected the request',
      providerCode: providerCode ?? numericStatus,
      retryAfterMs: resolvedRetryAfter,
      now,
      meta,
    });
  }

  if (numericStatus >= 400 && numericStatus < 500 && numericStatus !== 408) {
    return failureResult({
      deliveryState: 'definitive_failure',
      retryDisposition: neverRetryStatus(numericStatus) ? 'never' : 'manual',
      error: error || `Provider rejected the request (${numericStatus})`,
      providerCode: providerCode ?? numericStatus,
      now,
      meta,
    });
  }

  return failureResult({
    deliveryState: 'ambiguous',
    retryDisposition: 'manual',
    error: error || `Provider outcome is uncertain (${numericStatus || 'invalid response'})`,
    providerCode: providerCode ?? (numericStatus || 'invalid_response'),
    now,
    meta,
  });
}

/**
 * Classify a request that threw. A timeout or abort may have happened after the provider acted, so it
 * stays ambiguous. A failure to connect never reached the provider, so it is a definitive failure that
 * is safe to retry automatically; leaving it ambiguous would block the channel until an operator steps in.
 *
 * That holds only for `singleHop` callers, whose one request is never redirected: after a followed
 * redirect, a connect failure on the second hop says nothing about whether the first hop already
 * processed the request. Every other caller keeps treating any thrown error as ambiguous.
 */
export function exceptionFailureResult(error, { now = Date.now, meta, singleHop = false } = {}) {
  const timeout = error instanceof OutputTimeoutError || error?.code === 'timeout';
  const aborted = !timeout && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  const connectCode = timeout || aborted || !singleHop ? null : connectPhaseCode(error);
  if (connectCode) {
    return failureResult({
      deliveryState: 'definitive_failure',
      retryDisposition: 'automatic',
      error: 'Provider connection failed before the request was sent',
      providerCode: connectCode,
      now,
      meta,
    });
  }
  return failureResult({
    deliveryState: 'ambiguous',
    retryDisposition: 'manual',
    error: timeout
      ? 'Provider request timed out; delivery outcome is uncertain'
      : aborted
        ? 'Provider request was aborted; delivery outcome is uncertain'
        : error,
    providerCode: timeout ? 'timeout' : aborted ? 'aborted' : 'network_error',
    now,
    meta,
  });
}

/**
 * The error code when `error` proves the request never left this process, otherwise null. `fetch`
 * wraps the real error as `cause` (`TypeError: fetch failed`), and a host with several addresses
 * reports an AggregateError holding one error per address; every one of those must be pre-send.
 */
function connectPhaseCode(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > MAX_CAUSE_DEPTH) return null;
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    const codes = error.errors.map(entry => connectPhaseCode(entry, depth + 1));
    return codes.every(Boolean) ? codes[0] : null;
  }
  const { code } = error;
  const requiredSyscall = CONNECT_PHASE_SYSCALLS.get(code);
  if (CONNECT_PHASE_CODES.has(code) || (requiredSyscall !== undefined && error.syscall === requiredSyscall)) return code;
  return connectPhaseCode(error.cause, depth + 1);
}

export function invalidResponseResult(provider, options = {}) {
  return failureResult({
    deliveryState: 'ambiguous',
    retryDisposition: 'manual',
    error: `${provider} returned an invalid success response`,
    providerCode: 'invalid_response',
    ...options,
  });
}

export function withPartialMutation(failure, {
  successfulMessageIds = [],
  completedSteps,
  totalSteps,
  failedStep,
  partResults,
  parts,
} = {}) {
  const ids = successfulMessageIds.map(normalizeMessageId).filter(Boolean).slice(0, 50);
  const partialMutation = {
    successfulSteps: clampCount(completedSteps ?? ids.length),
    completedSteps: clampCount(completedSteps ?? ids.length),
    totalSteps: clampCount(totalSteps),
    failedStep: clampCount(failedStep),
    messageIds: ids,
  };

  return failureResult({
    deliveryState: 'ambiguous',
    retryDisposition: 'manual',
    error: failure?.meta?.sanitizedError || failure?.error,
    providerCode: failure?.meta?.providerCode,
    messageId: ids[0] || failure?.messageId,
    meta: {
      ...failure?.meta,
      successfulMessageIds: ids,
      partialMutation,
      parts,
      partsAttempted: Array.isArray(partResults) ? partResults.length : undefined,
      partsTotal: clampCount(totalSteps),
      failedAt: clampCount(failedStep),
      partResults: Array.isArray(partResults) ? partResults.slice(0, 50) : undefined,
    },
  });
}

export function partResult(part, result, kind = 'message') {
  return compactMeta({
    part: clampCount(part),
    kind: String(kind).slice(0, 32),
    success: result.success === true,
    messageId: normalizeMessageId(result.messageId),
    deliveryState: result.meta?.deliveryState,
    providerCode: normalizeProviderCode(result.meta?.providerCode),
    sanitizedError: result.meta?.sanitizedError
      ? sanitizeError(result.meta.sanitizedError)
      : undefined,
  });
}

export function parseRetryAfter(headers, now = Date.now) {
  const value = getHeader(headers, 'retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return normalizeRetryAfter(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return normalizeRetryAfter(Math.max(0, timestamp - safeNow(now)));
}

export function sanitizeError(value, fallback = 'Provider request failed') {
  const original = value instanceof Error ? value.message : value;
  let text = String(original || fallback)
    .replace(/https?:\/\/[^\s)\]}>"']+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*[-_\d])[A-Za-z0-9_-]+\b/g, '[redacted-value]')
    .replace(/-?\b\d{7,}\b/g, '[redacted-id]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!text) text = fallback;
  return text.slice(0, MAX_ERROR_LENGTH);
}

/** Stable synchronous SHA-256 destination fingerprint, safe in Node/Workers. */
export function destinationDeliveryKey(provider, destinationParts, explicitKey) {
  const explicit = normalizeDestinationPart(explicitKey);
  const parts = Array.isArray(destinationParts) ? destinationParts : [destinationParts];
  const canonical = explicit
    ? `explicit\u001f${explicit}`
    : parts.map(normalizeDestinationPart).filter(Boolean).join('\u001f');
  if (!canonical) return provider;
  return `${provider}:${sha256(canonical).slice(0, 24)}`;
}

export function normalizeMessageId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const id = String(value).slice(0, 128);
  return /^[A-Za-z0-9_.:-]+$/.test(id)
    ? id
    : `opaque-${sha256(id).slice(0, 24)}`;
}

function oversizedResponse() {
  return {
    text: '',
    data: null,
    validJson: false,
    tooLarge: true,
    readError: 'Provider response exceeded byte limit',
  };
}

function invalidResponse() {
  return {
    text: '',
    data: null,
    validJson: false,
    readError: 'Invalid provider response',
  };
}

async function discardResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function cancelReader(reader) {
  try { await reader?.cancel?.(); } catch {}
}

function declaredBodyLength(response) {
  try {
    const value = Number(response?.headers?.get?.('content-length'));
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  } catch {
    return -1;
  }
}

function asByteChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Invalid response chunk');
}

function joinChunks(chunks, totalBytes) {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeResponseBodyLimit(value, ceiling = MAX_RESPONSE_BODY_BYTES) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return ceiling;
  return Math.max(1, Math.min(Math.floor(bytes), ceiling));
}

function compactMeta(meta) {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
}

function boundKnownMetadata(meta) {
  const bounded = { ...meta };
  if (Array.isArray(meta.successfulMessageIds)) {
    bounded.successfulMessageIds = meta.successfulMessageIds
      .map(normalizeMessageId)
      .filter(Boolean)
      .slice(0, 50);
  }
  if (Array.isArray(meta.partResults)) bounded.partResults = meta.partResults.slice(0, 50);
  return bounded;
}

function normalizeTimeout(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : DEFAULT_TIMEOUT_MS;
}

function normalizeRetryAfter(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.min(Math.floor(numeric), MAX_RETRY_AFTER_MS);
}

function normalizeProviderCode(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const code = String(value).slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/.test(code) ? code : 'provider_error';
}

function normalizeDestinationPart(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 2_048);
}

function neverRetryStatus(status) {
  return [400, 404, 405, 410, 413, 414, 415, 422].includes(status);
}

function clampCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(1_000, Math.floor(numeric)));
}

function resolveNow(source) {
  if (typeof source?.now === 'function') return source.now.bind(source);
  if (Number.isFinite(Number(source?.now))) return () => Number(source.now);
  if (typeof source?.clock === 'function') return source.clock;
  if (typeof source?.clock?.now === 'function') return source.clock.now.bind(source.clock);
  return undefined;
}

function safeNow(now) {
  try {
    const value = Number(typeof now === 'function' ? now() : now);
    if (Number.isFinite(value)) return value;
  } catch {}
  return Date.now();
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) || undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256(input) {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = schedule[i - 15];
      const b = schedule[i - 2];
      const sigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const sigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[i] = (schedule[i - 16] + sigma0 + schedule[i - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[i] + schedule[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return state.map(value => value.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}
