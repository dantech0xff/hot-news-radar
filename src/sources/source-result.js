/**
 * Shared, bounded diagnostics for built-in source plugins.
 *
 * Source fetches keep returning Article[] for compatibility. Built-in sources
 * additionally expose fetchWithDiagnostics() and lastFetchDiagnostic so the
 * engine can distinguish a proven empty result from a failed or unknown fetch.
 */

export const SOURCE_FETCH_DIAGNOSTIC_CAPABILITY = 'source-fetch-diagnostic-v1';
export const MAX_SOURCE_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
/**
 * Highest cap a source may ask for with `maxResponseBytes`. Some feeds embed
 * the full text of every post and are larger than the default cap.
 */
export const MAX_SOURCE_RESPONSE_BODY_CEILING_BYTES = 8 * 1024 * 1024;

const RESULT_STATUSES = new Set(['success', 'empty', 'unknown']);
const DIAGNOSTIC_CAPTURE = Symbol('sourceDiagnosticCapture');
const FAILURE_TYPES = new Set([
  'transport',
  'http',
  'parse',
  'response_too_large',
  'invalid_shape',
  'unsupported_shape',
]);

/**
 * Internal sentinel used to classify failures without retaining raw errors,
 * response bodies, request URLs, or credentials.
 */
export class SourceFetchFailure extends Error {
  /**
   * @param {'transport'|'http'|'parse'|'response_too_large'|'invalid_shape'|'unsupported_shape'} failureType
   * @param {{httpStatus?: number}} [details]
   */
  constructor(failureType, details = {}) {
    super('Source fetch failed');
    this.name = 'SourceFetchFailure';
    this.failureType = FAILURE_TYPES.has(failureType) ? failureType : 'invalid_shape';
    this.httpStatus = normalizeHttpStatus(details.httpStatus);
  }
}

/** @returns {SourceFetchFailure} */
export function httpSourceFailure(status) {
  return new SourceFetchFailure('http', { httpStatus: status });
}

/** @returns {SourceFetchFailure} */
export function parseSourceFailure() {
  return new SourceFetchFailure('parse');
}

/** @returns {SourceFetchFailure} */
export function sourceResponseTooLarge() {
  return new SourceFetchFailure('response_too_large');
}

/** @returns {SourceFetchFailure} */
export function invalidSourceShape() {
  return new SourceFetchFailure('invalid_shape');
}

/**
 * Mark a structurally valid response whose article semantics cannot be proven
 * by the built-in parser. Unknown results must never be treated as exhaustion.
 *
 * @param {Array} [articles]
 */
export function unknownSourceResult(articles = []) {
  return { articles, status: 'unknown', failureType: 'unsupported_shape' };
}

/**
 * Read a response as UTF-8 without buffering beyond a fixed byte cap.
 *
 * @param {Response|Object} response
 * @param {number} [maxBytes] Cap in bytes; defaults to MAX_SOURCE_RESPONSE_BODY_BYTES and is never above MAX_SOURCE_RESPONSE_BODY_CEILING_BYTES.
 * @returns {Promise<string>}
 */
export async function readSourceText(response, maxBytes = MAX_SOURCE_RESPONSE_BODY_BYTES) {
  const byteLimit = normalizeResponseBodyLimit(maxBytes);
  if (declaredBodyLength(response) > byteLimit) {
    await discardSourceResponse(response);
    throw sourceResponseTooLarge();
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') throw parseSourceFailure();

  let reader;
  let bytes = new Uint8Array(Math.min(byteLimit, 8 * 1024));
  let totalBytes = 0;
  try {
    reader = body.getReader();
    while (true) {
      const result = await reader.read();
      if (!result || typeof result.done !== 'boolean') throw parseSourceFailure();
      if (result.done) break;

      const chunk = asByteChunk(result.value);
      if (chunk.byteLength === 0) continue;
      if (chunk.byteLength > byteLimit - totalBytes) {
        await cancelReader(reader);
        throw sourceResponseTooLarge();
      }
      bytes = ensureCapacity(bytes, totalBytes + chunk.byteLength, byteLimit);
      bytes.set(chunk, totalBytes);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  } finally {
    try { reader?.releaseLock(); } catch {}
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, totalBytes));
  } catch {
    throw parseSourceFailure();
  }
}

/**
 * Parse a bounded JSON response without exposing parser messages or content.
 *
 * @param {Response|Object} response
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 */
export async function readSourceJson(response, maxBytes = MAX_SOURCE_RESPONSE_BODY_BYTES) {
  try {
    return JSON.parse(await readSourceText(response, maxBytes));
  } catch (error) {
    if (error instanceof SourceFetchFailure) throw error;
    throw parseSourceFailure();
  }
}

/** Stop an unused response body so an upstream cannot keep buffering it. */
export async function discardSourceResponse(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

/**
 * Run a source operation, structurally validate its Article[] result, and
 * record a sanitized diagnostic. Failures remain compatible by returning [].
 *
 * @param {Object} source
 * @param {Object} options
 * @param {() => Promise<Array|{articles:Array,status?:'success'|'empty'|'unknown',failureType?:string}>} operation
 * @returns {Promise<Array>}
 */
export async function runDiagnosedFetch(source, options = {}, operation) {
  try {
    const rawResult = await operation();
    const result = Array.isArray(rawResult) ? { articles: rawResult } : rawResult;

    if (!isPlainObject(result) || !Array.isArray(result.articles)) {
      throw invalidSourceShape();
    }

    validateArticleArray(result.articles);

    const status = result.status || (result.articles.length > 0 ? 'success' : 'empty');
    if (!RESULT_STATUSES.has(status)) throw invalidSourceShape();
    if (status === 'success' && result.articles.length === 0) throw invalidSourceShape();
    if ((status === 'empty' || status === 'unknown') && result.articles.length > 0) {
      throw invalidSourceShape();
    }

    const diagnostic = {
      status,
      articleCount: result.articles.length,
      ...(status === 'unknown'
        ? { failureType: normalizeFailureType(result.failureType, 'unsupported_shape') }
        : {}),
    };

    setLastDiagnostic(source, diagnostic);
    captureDiagnostic(options, diagnostic);
    if (status === 'unknown') await reportDiagnostic(options, diagnostic);
    return result.articles;
  } catch (error) {
    const failure = error instanceof SourceFetchFailure
      ? error
      : new SourceFetchFailure('transport');
    const diagnostic = {
      status: 'failed',
      articleCount: 0,
      failureType: failure.failureType,
      ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
    };

    setLastDiagnostic(source, diagnostic);
    captureDiagnostic(options, diagnostic);
    await reportDiagnostic(options, diagnostic);
    return [];
  }
}

/**
 * @param {Object} source
 * @returns {{status:'success'|'empty'|'failed'|'unknown',articleCount:number,failureType?:string,httpStatus?:number}}
 */
export function readLastFetchDiagnostic(source) {
  const diagnostic = source?._lastFetchDiagnostic;
  if (!diagnostic) return { status: 'unknown', articleCount: 0 };
  return { ...diagnostic };
}

/**
 * Compatibility helper for each source's fetchWithDiagnostics() method.
 *
 * @param {Object} source
 * @param {Object} options
 */
export async function fetchSourceWithDiagnostics(source, options = {}) {
  let capturedDiagnostic;
  const articles = await source.fetch({
    ...options,
    [DIAGNOSTIC_CAPTURE]: diagnostic => { capturedDiagnostic = { ...diagnostic }; },
  });
  return {
    articles,
    diagnostic: capturedDiagnostic || readLastFetchDiagnostic(source),
  };
}

/**
 * Validate the public Article contract. One invalid entry fails the entire
 * source result so malformed upstream data cannot masquerade as healthy input.
 *
 * @param {Array} articles
 */
export function validateArticleArray(articles) {
  if (!Array.isArray(articles)) throw invalidSourceShape();
  for (const article of articles) {
    if (!isPlainObject(article)) throw invalidSourceShape();
    if (!isNonEmptyString(article.id)) throw invalidSourceShape();
    if (!isNonEmptyString(article.title)) throw invalidSourceShape();
    if (!isNonEmptyString(article.url)) throw invalidSourceShape();
    if (typeof article.content !== 'string') throw invalidSourceShape();
    if (!isNonEmptyString(article.source)) throw invalidSourceShape();

    for (const field of ['category', 'author', 'imageUrl']) {
      if (article[field] !== undefined && typeof article[field] !== 'string') {
        throw invalidSourceShape();
      }
    }

    if (article.publishedAt !== undefined && article.publishedAt !== null) {
      if (!(article.publishedAt instanceof Date) || Number.isNaN(article.publishedAt.getTime())) {
        throw invalidSourceShape();
      }
    }

    if (article.meta !== undefined && !isPlainObject(article.meta)) {
      throw invalidSourceShape();
    }
  }
}

function setLastDiagnostic(source, diagnostic) {
  source._lastFetchDiagnostic = Object.freeze({ ...diagnostic });
}

function captureDiagnostic(options, diagnostic) {
  const capture = options?.[DIAGNOSTIC_CAPTURE];
  if (typeof capture === 'function') capture(diagnostic);
}

async function reportDiagnostic(options, diagnostic) {
  if (typeof options?.reportError !== 'function') return;
  try {
    await options.reportError({ ...diagnostic });
  } catch {
    // Diagnostics must never change the legacy fetch() behavior.
  }
}

function normalizeFailureType(value, fallback) {
  return FAILURE_TYPES.has(value) ? value : fallback;
}

function normalizeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function normalizeResponseBodyLimit(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return MAX_SOURCE_RESPONSE_BODY_BYTES;
  return Math.min(Math.max(1, Math.floor(bytes)), MAX_SOURCE_RESPONSE_BODY_CEILING_BYTES);
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
  throw parseSourceFailure();
}

function ensureCapacity(bytes, requiredBytes, byteLimit) {
  if (requiredBytes <= bytes.byteLength) return bytes;
  const nextSize = Math.min(byteLimit, Math.max(requiredBytes, bytes.byteLength * 2));
  const expanded = new Uint8Array(nextSize);
  expanded.set(bytes);
  return expanded;
}

async function cancelReader(reader) {
  try { await reader?.cancel?.(); } catch {}
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
