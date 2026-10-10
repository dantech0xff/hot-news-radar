/**
 * ============================================
 * Plugin Contracts — Mọi plugin implement từ đây
 * ============================================
 *
 * 3 loại plugin:
 *   1. Source    — Nơi lấy data (RSS, API, scrape, DB...)
 *   2. AI       — Model xử lý/tóm tắt (Claude, OpenAI, Gemini, local...)
 *   3. Output   — Nơi gửi kết quả (Telegram, Slack, Discord, Email, File...)
 *
 * + Cache contract cho dedup
 */

/**
 * @typedef {Object} SourceFetchDiagnostic
 * @property {'success'|'empty'|'failed'|'unknown'} status
 * @property {number} articleCount
 * @property {'transport'|'http'|'parse'|'response_too_large'|'invalid_shape'|'unsupported_shape'|'exception'} [failureType]
 * @property {number} [httpStatus]
 */

// ============================================
// 1. SOURCE CONTRACT
// ============================================

/**
 * @typedef {Object} Article
 * @property {string}  id          - Unique identifier (URL hoặc hash)
 * @property {string}  title       - Tiêu đề bài viết
 * @property {string}  url         - Link gốc
 * @property {string}  content     - Nội dung / mô tả (plain text)
 * @property {string}  source      - Tên nguồn
 * @property {string}  [category]  - Phân loại
 * @property {string}  [author]    - Tác giả
 * @property {string}  [imageUrl]  - URL ảnh cover/hero của bài viết
 * @property {Date}    [publishedAt] - Ngày xuất bản
 * @property {Object}  [meta]      - Metadata tuỳ ý (tags, images, etc.)
 */

/**
 * Mỗi Source plugin phải implement interface này
 */
export class SourcePlugin {
  /** @returns {string} Unique plugin ID */
  get id() { throw new Error('Not implemented'); }

  /** @returns {string} Display name */
  get name() { throw new Error('Not implemented'); }

  /** Stable, non-credential source configuration identity used for durable batch invalidation. */
  get sourceKey() { return `${this.id}:${this.name}`; }

  /** @returns {string} Emoji icon */
  get icon() { return '📰'; }

  /** Capability marker overridden by diagnostic-aware source plugins. */
  get diagnosticCapability() { return null; }

  /** @returns {SourceFetchDiagnostic} Last bounded diagnostic snapshot. */
  get lastFetchDiagnostic() { return { status: 'unknown', articleCount: 0 }; }

  /**
   * Fetch articles from this source. Source work happens before a durable
   * delivery/request/attempt is claimed; no delivery identity or output
   * single-mutation permission is implied by this call.
   *
   * Implementations must honor `signal` in provider requests, stream reads,
   * sleeps, and retry loops, and must settle promptly after abort. The engine
   * ignores a non-cooperative completion after its operation deadline.
   *
   * @param {Object} [options={}]
   * @param {number} [options.limit=5]      - Maximum articles to return
   * @param {Date}   [options.since]        - Return only newer articles
   * @param {Object} [options.config]       - Source-specific config (API keys, etc.)
   * @param {AbortSignal} [options.signal]  - Cooperative operation deadline/cancellation
   * @param {(diagnostic: SourceFetchDiagnostic) => void|Promise<void>} [options.reportError]
   * @returns {Promise<Article[]>}
   */
  async fetch(options = {}) { throw new Error('Not implemented'); }

  /**
   * Optional diagnostic fetch contract. Legacy plugins inherit a conservative
   * adapter: non-empty arrays are successful, but an empty array is unknown
   * because the plugin did not prove that its upstream was healthy.
   * Overrides receive the same bounded options and must honor `options.signal`.
   * @param {Object} [options={}]
   * @param {number} [options.limit=5]
   * @param {Date} [options.since]
   * @param {Object} [options.config]
   * @param {AbortSignal} [options.signal]
   * @param {(diagnostic: SourceFetchDiagnostic) => void|Promise<void>} [options.reportError]
   * @returns {Promise<{articles: Article[], diagnostic: SourceFetchDiagnostic}>}
   */
  async fetchWithDiagnostics(options = {}) {
    const articles = await this.fetch(options);
    if (!Array.isArray(articles)) throw new Error(`${this.name} returned a non-array article result`);
    return {
      articles,
      diagnostic: {
        status: articles.length > 0 ? 'success' : 'unknown',
        articleCount: articles.length,
      },
    };
  }
}

// ============================================
// 2. AI PROVIDER CONTRACT
// ============================================

/**
 * @typedef {Object} SummaryResult
 * @property {string}  text       - Nội dung đã xử lý
 * @property {Object}  [usage]    - Token usage { input, output, cost }
 * @property {string}  [model]    - Model đã dùng
 */

/**
 * Mỗi AI plugin phải implement interface này
 */
export class AIPlugin {
  /** @returns {string} Unique plugin ID */
  get id() { throw new Error('Not implemented'); }

  /** @returns {string} Display name */
  get name() { throw new Error('Not implemented'); }

  /**
   * Summarize an engine-selected, bounded article set. Real delivery and
   * recovery calls use the durable projected article snapshot; dry-run calls
   * use the equivalent bounded selection before persistence. Treat articles as
   * read-only and do not refetch or expand the snapshot inside the plugin.
   *
   * Implementations must honor `signal` in all provider I/O and settle promptly
   * after abort. Opaque identities, when supplied by the invoking runtime, are
   * correlation/idempotency context only; plugins do not own delivery state.
   * A late completion after abort is ignored and cannot overwrite the durable
   * attempt result.
   *
   * @param {ReadonlyArray<Article>} articles
   * @param {Object} [options={}]
   * @param {string}    [options.language='vi']   - Output language: 'vi' (Vietnamese with diacritics) or 'en'; any other value falls back to 'vi'. Its output rules are always enforced.
   * @param {string}    [options.style='digest']  - Style: digest | hot_take | bullet | thread | newsletter | weekly | mustread
   * @param {string}    [options.platform='telegram'] - Platform formatting rules
   * @param {string}    [options.audience]
   * @param {'digest'|'drip'} [options.deliveryMode]
   * @param {string}    [options.customSystemPrompt] - Per-channel editorial instructions; replace only the style section and keep the language, source-data, and platform rules
   * @param {string}    [options.systemPrompt]    - Legacy full system prompt override (the language output rules are still appended)
   * @param {number}    [options.maxTokens=4096]
   * @param {string}    [options.requestId]  - Opaque durable request identity when available
   * @param {string}    [options.deliveryId] - Opaque durable delivery identity when available
   * @param {string}    [options.attemptId]  - Opaque generation-attempt identity when available
   * @param {AbortSignal} [options.signal]    - Cooperative operation deadline/cancellation
   * @returns {Promise<SummaryResult>}
   */
  async summarize(articles, options = {}) { throw new Error('Not implemented'); }
}

// ============================================
// 3. OUTPUT CONTRACT
// ============================================

/**
 * @typedef {Object} SendResult
 * @property {boolean} success
 * @property {string}  [messageId]   - ID của message đã gửi (nếu có)
 * @property {string}  [error]       - Lỗi nếu fail
 * @property {Object}  [meta]
 * @property {'success'|'definitive_failure'|'ambiguous'} [meta.deliveryState]
 * @property {'automatic'|'manual'|'never'} [meta.retryDisposition]
 * @property {string} [meta.providerRequestId]
 * @property {Object|boolean} [meta.partialMutation]
 * @property {string} [meta.sanitizedError]
 */

/**
 * Mỗi Output plugin phải implement interface này
 */
export class OutputPlugin {
  /** @returns {string} Unique plugin ID */
  get id() { throw new Error('Not implemented'); }

  /** @returns {string} Display name */
  get name() { throw new Error('Not implemented'); }

  /** Stable destination identity. Override when multiple destinations share one plugin id. */
  get deliveryKey() { return this.id; }

  /**
   * True only when `send(..., { singleMutation: true })` guarantees at most one
   * provider mutation, including fallbacks, splitting, and internal retries.
   */
  get supportsSingleMutation() { return false; }

  /**
   * Send formatted content to one durable output target. `articles` and
   * `article` are bounded, projected snapshots; treat them as read-only.
   * Request/delivery/attempt identities are opaque correlation or provider
   * idempotency inputs and must not be parsed to derive delivery state.
   *
   * Implementations must honor `signal` for every provider request and response
   * read, and must stop before issuing any later mutation after abort. Abort is
   * cooperative and cannot revoke a mutation already accepted by a provider.
   * A non-cooperative provider-side late completion cannot be cancelled. If it
   * finishes after the engine deadline, its result cannot be committed: delivery
   * remains conservatively ambiguous and automatic resend stays blocked pending
   * reconciliation.
   *
   * When `singleMutation` is true, issue at most one provider-mutating request;
   * if that cannot be guaranteed, fail definitively before provider mutation.
   * Return canonical `deliveryState`/`retryDisposition` metadata whenever
   * possible. Unclassified legacy failures are treated as ambiguous/manual.
   *
   * @param {string} content       - Nội dung đã format
   * @param {Object} [options={}]
   * @param {Object} [options.config]  - Output-specific config (tokens, IDs, etc.)
   * @param {ReadonlyArray<Article>} [options.articles] - Durable bounded article snapshot
   * @param {Article} [options.article] - Drip-mode view into `options.articles`
   * @param {string} [options.requestId]  - Opaque durable request identity when available
   * @param {string} [options.deliveryId] - Opaque durable delivery identity
   * @param {string} [options.attemptId]  - Opaque unique output-attempt identity
   * @param {boolean} [options.singleMutation=false] - At-most-one provider mutation contract
   * @param {AbortSignal} [options.signal] - Cooperative operation deadline/cancellation
   * @returns {Promise<SendResult>}
   */
  async send(content, options = {}) { throw new Error('Not implemented'); }

  /**
   * Optional. After a send ended ambiguous, look for proof that the post reached the destination so
   * the engine can confirm it without sending again. Resolve `{ messageId }` only when the post is
   * positively found; resolve null when it is absent or anything is uncertain. Must never mutate the
   * destination, must not throw for an ordinary lookup failure, and should honor `signal`.
   *
   * @param {Object} query
   * @param {ReadonlyArray<Article>} query.articles - Durable snapshot of what the attempt carried
   * @param {Date} query.since - When the ambiguous attempt started
   * @param {Date} [query.until] - When it ended; a post after this is not the send being checked
   * @param {AbortSignal} [query.signal] - Cooperative lookup deadline
   * @returns {Promise<{ messageId: string } | null>}
   */
  async findDelivered(query) { return null; }

  /**
   * Max content length cho output này (dùng để split)
   * @returns {number}
   */
  get maxLength() { return Infinity; }
}

// ============================================
// 4. CACHE CONTRACT
// ============================================

export class CachePlugin {
  async get(key) { return null; }
  async peek(key) { return this.get(key); }
  async set(key, value, ttlMs) {}
  async has(key) { return (await this.get(key)) !== null; }
  async delete(key) {}

  get capabilities() {
    return {
      persistent: false,
      nonMutatingRead: false,
    };
  }
}
