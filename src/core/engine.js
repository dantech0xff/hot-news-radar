import { AIPlugin, CachePlugin, OutputPlugin, SourcePlugin } from './contracts.js';
import {
  aggregateSendResults,
  buildOutputTopology,
  channelArticleHash,
  normalizeSendResult,
  opaqueId,
  projectArticle,
  publishingDayFor,
  sanitizeError,
} from './delivery.js';
import { assertDeliveryStore } from './delivery-store.js';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  DEFAULT_OUTPUT_TIMEOUT_MS,
  DeliveryStateMachine,
} from './delivery-state-machine.js';
import { excludeCoveredStories, pickDistinctStories } from './story-dedup.js';

const DEFAULT_DRIP_DAILY_LIMIT = 18;
const DEFAULT_SCAN_INTERVAL_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RECONCILE_OPERATOR_ID = 'auto-reconcile';

const NON_TERMINAL_DELIVERY_STATES = new Set([
  'pending_generation', 'generating', 'generation_retry_pending',
  'manual_generation_retry_pending', 'generation_exhausted', 'ready',
  'delivering', 'partial_retryable', 'output_manual_retry_required',
  'output_exhausted', 'blocked_topology', 'needs_reconciliation',
]);
const AUTOMATIC_DELIVERY_STATES = new Set([
  'pending_generation', 'generation_retry_pending', 'ready', 'partial_retryable',
]);

export class ContentRadar {
  constructor() {
    this.sources = [];
    this.ai = null;
    this.outputs = [];
    this.cache = new NoopCache();
    this.deliveryStore = null;
    this.logger = console.log;
    this.middlewares = [];
    this._machine = null;
    this._storeInitialized = false;
    this.options = {
      channelId: 'default',
      timezone: 'UTC',
      concurrency: 5,
      maxArticlesPerSource: 5,
      maxRetries: 2,
      maxGenerationAttempts: 3,
      maxOutputAttempts: 3,
      attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
      sourceTimeoutMs: 15_000,
      generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
      outputTimeoutMs: DEFAULT_OUTPUT_TIMEOUT_MS,
      // An output's own lookup makes up to four small requests (the Telegram client allows 8 s for each).
      reconcileLookupTimeoutMs: 40_000,
      language: 'vi',
      secondaryLanguage: null,
      style: 'digest',
      audience: 'IT professionals',
      platform: 'telegram',
      since: null,
      sourceWindowHours: 24,
      allowEphemeralDelivery: false,
      clock: () => new Date(),
    };
  }

  addSource(source) {
    if (!(source instanceof SourcePlugin)) throw new Error('Invalid source: must extend SourcePlugin');
    this.sources.push(source);
    return this;
  }

  useAI(ai) {
    if (!(ai instanceof AIPlugin)) throw new Error('Invalid AI: must extend AIPlugin');
    this.ai = ai;
    return this;
  }

  addOutput(output) {
    if (!(output instanceof OutputPlugin)) throw new Error('Invalid output: must extend OutputPlugin');
    this.outputs.push(output);
    return this;
  }

  useCache(cache) {
    if (!(cache instanceof CachePlugin)) throw new Error('Invalid cache: must extend CachePlugin');
    this.cache = cache;
    return this;
  }

  useDeliveryStore(store) {
    assertDeliveryStore(store, { allowEphemeral: true });
    this.deliveryStore = store;
    this._machine = null;
    this._storeInitialized = false;
    return this;
  }

  use(fn) { this.middlewares.push(fn); return this; }
  setLogger(fn) { this.logger = fn; return this; }

  configure(options) {
    this.options = { ...this.options, ...options, secondaryLanguage: null };
    this._machine = null;
    return this;
  }

  async run(runOptions = {}) {
    const startedAt = this._captureInstant(runOptions.requestedAt);
    const publishingDay = publishingDayFor(startedAt, this.options.timezone);
    const dryRun = runOptions.dryRun === true;
    const force = runOptions.force === true;
    this._validateBase();
    if (!dryRun) await this._validateMutation();
    runOptions = await normalizeMutationRunOptions(runOptions, {
      channelId: this.options.channelId,
      dryRun,
      force,
    });

    const operatorForce = runOptions.operatorForce === true;
    const forceKey = force ? String(runOptions.idempotencyKey ?? `preview-force:${publishingDay}`) : null;
    const requestId = String(runOptions.requestId ?? (
      force ? `force:${forceKey}` : `digest:${publishingDay}`
    ));
    const machine = dryRun ? null : await this._ensureMachine();
    if (machine) {
      await machine.recoverStaleAttempts();
      await machine.compactHistory();
      const channel = await machine.getChannelState();
      if (operatorForce && !channel?.paused) {
        throw new Error('Operator single-mutation canary requires a paused channel');
      }
      if (channel?.paused && !isAuthorizedPausedMutation(runOptions)) {
        return pausedRunResult({ publishingDay, mode: 'digest' });
      }
      await this._reconcileAmbiguousOutput(machine);
      await this._drainMaintenance(machine);
    }
    let sourceHealth = null;
    let delivery = null;
    let reservationClaim = null;
    let reservationId = null;

    if (!dryRun) {
      const exact = await machine.queryDeliveries({ requestId });
      const active = force ? [] : await machine.queryDeliveries({
        state: [...NON_TERMINAL_DELIVERY_STATES],
      });
      const existing = [...new Map([...exact, ...active].map(record => [record.deliveryId, record])).values()]
        .filter(record => record.mode === 'digest')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (existing) {
        if (existing.state === 'succeeded') {
          return this._resultFromDelivery(existing, {
            publishingDay,
            content: existing.generatedContent,
            reason: 'already_complete',
          });
        }
        delivery = await machine.prepareDelivery({
          requestId: existing.requestId,
          mode: existing.mode,
          publishingDay: existing.publishingDay,
          articles: existing.articleSnapshot,
          outputs: this.outputs,
          forceKind: existing.forceKind,
          singleMutation: existing.singleMutation === true,
        });
      }
      if (!delivery && !force) {
        const legacyDigest = (await this.deliveryStore.list('legacy_digest_compat', record => (
          record.channelId === this.options.channelId
          && record.publishingDay === publishingDay
        )))[0];
        if (legacyDigest) {
          return {
            status: 'skipped',
            reason: 'legacy_digest_complete',
            publishingDay,
            stats: { articles: 0 },
          };
        }
      }
      if (!delivery) {
        reservationId = await opaqueId(
          'delivery-reservation',
          this.options.channelId,
          'digest',
          force ? `force:${requestId}` : `normal:${publishingDay}`,
        );
        reservationClaim = await machine.claimDeliveryReservation({ reservationId, requestId });
        if (reservationClaim.status === 'linked') {
          const linked = await machine.getDelivery(reservationClaim.reservation.deliveryId);
          if (!linked) throw new Error('Delivery reservation points to a missing delivery');
          if (linked.state === 'succeeded') {
            return this._resultFromDelivery(linked, {
              publishingDay,
              content: linked.generatedContent,
              reason: 'already_complete',
            });
          }
          delivery = await machine.prepareDelivery({
            requestId: linked.requestId,
            mode: linked.mode,
            publishingDay: linked.publishingDay,
            articles: linked.articleSnapshot,
            outputs: this.outputs,
            forceKind: linked.forceKind,
            singleMutation: linked.singleMutation === true,
          });
        } else if (reservationClaim.status === 'completed') {
          return {
            status: 'skipped',
            reason: reservationClaim.reservation.reason ?? 'no_articles',
            publishingDay,
            sourceHealth: reservationClaim.reservation.sourceHealth,
            stats: { articles: 0 },
          };
        } else if (['in_flight', 'blocked'].includes(reservationClaim.status)) {
          return {
            status: 'skipped',
            reason: reservationClaim.reason ?? 'digest_in_flight',
            publishingDay,
            stats: { articles: 0 },
          };
        }
      }
    }

    let articles = delivery?.articleSnapshot ?? reservationClaim?.reservation?.articleSnapshot ?? null;
    sourceHealth = reservationClaim?.reservation?.sourceHealth ?? sourceHealth;
    let selection = null;
    if (!articles) {
      const prepared = await this._prepareArticles({
        force,
        dryRun,
        limit: runOptions.articleLimit,
      });
      articles = prepared.articles;
      sourceHealth = prepared.sourceHealth;
      selection = prepared.selection;
      if (articles.length === 0) {
        if (!dryRun && reservationId && reservationClaim?.claimToken) {
          await machine.completeDeliveryReservation(reservationId, reservationClaim.claimToken, {
            retryable: !sourceHealth.exhaustionEligible,
            reason: sourceHealth.exhaustionEligible ? 'no_articles' : 'sources_failed',
            sourceHealth,
          });
        }
        return withSelection(emptySourceResult({ publishingDay, sourceHealth, dryRun }), selection);
      }
      if (dryRun) {
        const generated = await this._summarize(articles, 'digest');
        return {
          status: 'dry_run',
          publishingDay,
          content: generated.text,
          sourceHealth,
          aiUsage: generated.usage ?? null,
          stats: { ...this._stats(articles.length, Date.now() - startedAt.getTime()), selection },
          outputs: [],
        };
      }
      if (reservationId && reservationClaim?.claimToken) {
        const bound = await machine.bindDeliveryReservation(reservationId, reservationClaim.claimToken, {
          articles,
          sourceHealth,
        });
        articles = bound.articleSnapshot;
        sourceHealth = bound.sourceHealth;
        reservationClaim = { ...reservationClaim, reservation: bound };
      }
      delivery = await machine.prepareDelivery({
        requestId: reservationClaim?.reservation?.deliveryRequestId ?? requestId,
        mode: 'digest',
        publishingDay,
        articles,
        outputs: this.outputs,
        forceKind: operatorForce ? 'operator' : force ? 'force' : null,
        singleMutation: runOptions.singleMutation === true,
      });
      if (!delivery.deliveryId) {
        return {
          status: delivery.status === 'suppressed' ? 'skipped' : 'failed',
          reason: delivery.reason,
          publishingDay,
          sourceHealth,
        };
      }
      if (reservationId && reservationClaim?.claimToken) {
        await machine.linkDeliveryReservation(reservationId, reservationClaim.claimToken, delivery.deliveryId);
      }
    }
    if (!delivery && articles) {
      delivery = await machine.prepareDelivery({
        requestId: reservationClaim?.reservation?.deliveryRequestId ?? requestId,
        mode: 'digest',
        publishingDay,
        articles,
        outputs: this.outputs,
        forceKind: operatorForce ? 'operator' : force ? 'force' : null,
        singleMutation: runOptions.singleMutation === true,
      });
      if (!delivery.deliveryId) {
        return {
          status: delivery.status === 'suppressed' ? 'skipped' : 'failed',
          reason: delivery.reason,
          publishingDay,
          sourceHealth,
        };
      }
      if (reservationId && reservationClaim?.claimToken) {
        await machine.linkDeliveryReservation(reservationId, reservationClaim.claimToken, delivery.deliveryId);
      }
    }

    const result = await this._executeDelivery({
      machine,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId ?? requestId,
      mode: 'digest',
      sourceHealth,
      confirmPausedMutation: runOptions.confirmPausedMutation === true,
      singleMutation: runOptions.singleMutation === true,
    });
    if (result.status === 'success') result.maintenance = await this._drainMaintenance(machine);
    result.publishingDay = publishingDay;
    return withSelection(result, selection);
  }

  async runDrip(runOptions = {}) {
    const startedAt = this._captureInstant(runOptions.requestedAt);
    const publishingDay = publishingDayFor(startedAt, this.options.timezone);
    const dryRun = runOptions.dryRun === true;
    const force = runOptions.force === true;
    const batchSize = positiveInteger(runOptions.batchSize ?? 5, 'batchSize');
    const delayMs = nonNegativeInteger(runOptions.delayMs ?? 0, 'delayMs');
    this._validateBase();
    if (!dryRun) await this._validateMutation();
    runOptions = await normalizeMutationRunOptions(runOptions, {
      channelId: this.options.channelId,
      dryRun,
      force,
    });

    if (dryRun) {
      const prepared = await this._prepareArticles({ force, dryRun: true });
      if (prepared.articles.length === 0) {
        return withSelection(
          emptySourceResult({ publishingDay, sourceHealth: prepared.sourceHealth, dryRun: true }),
          prepared.selection,
        );
      }
      const selected = prepared.articles.slice(0, batchSize);
      const items = [];
      for (const article of selected) {
        const generated = await this._summarize([article], 'drip');
        items.push({ article: article.title, hook: generated.text, dryRun: true });
      }
      return {
        status: 'dry_run',
        mode: 'drip',
        publishingDay,
        articles: items,
        sourceHealth: prepared.sourceHealth,
        stats: {
          ...this._stats(selected.length, Date.now() - startedAt.getTime()),
          mode: 'drip',
          selection: prepared.selection,
        },
      };
    }

    const machine = await this._ensureMachine();
    await machine.recoverStaleAttempts();
    await machine.compactHistory();
    const channel = await machine.getChannelState();
    if (runOptions.operatorForce === true && !channel?.paused) {
      throw new Error('Operator single-mutation canary requires a paused channel');
    }
    if (channel?.paused && !isAuthorizedPausedMutation(runOptions)) {
      return pausedRunResult({ publishingDay, mode: 'drip' });
    }
    await this._reconcileAmbiguousOutput(machine);
    await this._drainMaintenance(machine);
    if (force) {
      return this._runForcedDrip({ machine, runOptions, publishingDay, startedAt });
    }
    const carryover = (await machine.queryDeliveries({
      state: [...AUTOMATIC_DELIVERY_STATES],
    })).filter(delivery => (
      delivery.mode === 'drip'
      && delivery.publishingDay !== publishingDay
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (carryover.length > 0) {
      return this._runDripCarryover({
        machine,
        deliveries: carryover.slice(0, batchSize),
        publishingDay,
        startedAt,
        delayMs,
      });
    }
    // Radar scan policy applies only to ordinary drip runs, never to preview, force, or carryover.
    const dailyLimit = integerInRange(runOptions.dailyLimit ?? DEFAULT_DRIP_DAILY_LIMIT, 'dailyLimit', 1, 500);
    const scanIntervalMs = integerInRange(
      runOptions.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES,
      'scanIntervalMinutes',
      1,
      1_440,
    ) * 60_000;
    const topologyFingerprint = await opaqueId(
      'source-topology',
      ...this.sources.map(source => source.sourceKey),
      stableSourceSelection(this.options, this.middlewares),
    );
    const batchId = await opaqueId('day-batch', this.options.channelId, publishingDay, 'drip');
    let batch = await machine.getDayBatch(batchId);
    let sourceHealth = batch?.sourceHealth ?? null;

    if (batch && batch.sourceTopologyFingerprint !== topologyFingerprint) {
      batch = await machine.refreshBatchTopology(batchId, topologyFingerprint);
    }

    const adoption = await machine.adoptOrphanedDripDeliveries({
      batchId,
      publishingDay,
      sourceTopologyFingerprint: topologyFingerprint,
    });
    if (adoption.batch) {
      batch = adoption.batch;
      sourceHealth = batch.sourceHealth ?? sourceHealth;
    }

    if (!batch) {
      batch = await machine.ensureDayBatch({
        batchId,
        publishingDay,
        mode: 'drip',
        sourceTopologyFingerprint: topologyFingerprint,
        sourceHealth: null,
        deliveries: [],
      });
    }

    // Radar: scan again whenever slots are open, the daily limit allows it, and a scan is due.
    let items = await machine.listBatchItems(batchId);
    let eligible = await this._eligibleDripItems(machine, items, batchSize);
    let scan = null;
    if (eligible.length < batchSize && items.length < dailyLimit) {
      scan = await this._scanDayBatch({
        machine,
        batchId,
        publishingDay,
        topologyFingerprint,
        limit: Math.min(batchSize - eligible.length, dailyLimit - items.length),
        scanIntervalMs,
      });
      sourceHealth = scan.sourceHealth ?? sourceHealth;
      items = await machine.listBatchItems(batchId);
      eligible = await this._eligibleDripItems(machine, items, batchSize);
    }
    if (eligible.length === 0) {
      return withSelection(this._idleDripResult({
        scan, items, dailyLimit, publishingDay, sourceHealth, startedAt,
      }), scan?.selection);
    }

    const itemResults = [];
    for (let index = 0; index < eligible.length; index++) {
      const item = eligible[index];
      const delivery = await machine.getDelivery(item.deliveryId);
      const result = await this._executeDelivery({
        machine,
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        mode: 'drip',
        sourceHealth,
      });
      await machine.syncBatchItem(batchId, delivery.deliveryId);
      itemResults.push({ deliveryId: delivery.deliveryId, article: delivery.articleSnapshot[0]?.title, ...result });
      if (index < eligible.length - 1 && delayMs > 0) await sleep(delayMs);
    }
    const status = aggregateItemStatuses(itemResults);
    if (status === 'success' || status === 'partial') await this._drainMaintenance(machine);
    const queue = await this.getQueue({ publishingDay });
    return withSelection({
      status,
      mode: 'drip',
      publishingDay,
      articles: itemResults,
      sourceHealth,
      ...(scan?.error ? { scanError: scan.error } : {}),
      stats: {
        ...this._stats(itemResults.length, Date.now() - startedAt.getTime()),
        mode: 'drip',
        remaining: queue.remaining,
        blocked: queue.blocked,
      },
    }, scan?.selection);
  }

  async _eligibleDripItems(machine, items, batchSize) {
    const eligible = [];
    for (const item of items) {
      const current = await machine.getDelivery(item.deliveryId);
      if (!current || !AUTOMATIC_DELIVERY_STATES.has(current.state)) continue;
      eligible.push(item);
      if (eligible.length >= batchSize) break;
    }
    return eligible;
  }

  /**
   * Run one claimed radar scan of the day batch. It never throws: a failure is recorded
   * with backoff so items that are already queued still deliver in this run.
   */
  async _scanDayBatch({ machine, batchId, publishingDay, topologyFingerprint, limit, scanIntervalMs }) {
    const claim = await machine.claimBatchRefill({
      batchId,
      sourceTopologyFingerprint: topologyFingerprint,
      leaseMs: this._scanLeaseMs(),
    });
    if (claim.status !== 'claimed') {
      return { scanned: false, reason: claim.reason, sourceHealth: claim.batch?.sourceHealth ?? null };
    }
    let prepared = null;
    try {
      const coverageDays = coveragePublishingDays(publishingDay, this.options.sourceWindowHours);
      const covered = coveredArticles(await machine.listDeliveriesForPublishingDays(coverageDays));
      // Excluding covered stories before middlewares keeps look-alikes out of the scoring cut.
      prepared = await this._prepareArticles({
        force: false,
        dryRun: false,
        exclude: articles => excludeCoveredStories(articles, covered),
      });
      // Renew before creating deliveries: a scan that lost its claim must leave nothing behind.
      const renewal = await machine.renewBatchRefillClaim({
        batchId,
        claimToken: claim.claimToken,
        leaseMs: this._scanLeaseMs(),
      });
      if (renewal.status !== 'renewed') {
        return {
          scanned: false,
          reason: 'refill_claim_lost',
          sourceHealth: prepared.sourceHealth,
          selection: prepared.selection,
        };
      }
      // Forced drips do not take the scan claim, so re-read coverage after the fetch window.
      const coveredNow = coveredArticles(await machine.listDeliveriesForPublishingDays(coverageDays));
      const selected = pickDistinctStories(excludeCoveredStories(prepared.articles, coveredNow), limit);
      const deliveries = await this._prepareDripDeliveries(machine, selected, publishingDay);
      await machine.recordBatchRefill({
        batchId,
        claimToken: claim.claimToken,
        sourceTopologyFingerprint: topologyFingerprint,
        sourceHealth: prepared.sourceHealth,
        deliveries,
        scanIntervalMs,
      });
      return {
        scanned: true,
        sourceHealth: prepared.sourceHealth,
        selection: { ...prepared.selection, enqueued: deliveries.length },
      };
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      console.error('[Radar] Scan failed', {
        channelId: this.options.channelId,
        publishingDay,
        error: sanitizedError,
      });
      try {
        await machine.recordBatchRefill({
          batchId,
          claimToken: claim.claimToken,
          sourceTopologyFingerprint: topologyFingerprint,
          sourceHealth: prepared?.sourceHealth ?? null,
          deliveries: [],
          scanIntervalMs,
          failed: true,
        });
      } catch {
        // The claim is no longer owned; its lease expiry releases the scan instead.
      }
      return {
        scanned: false,
        reason: 'scan_failed',
        error: sanitizedError,
        sourceHealth: prepared?.sourceHealth ?? null,
        selection: prepared?.selection ?? null,
      };
    }
  }

  /** A scan claim must outlast every sequential source batch, including retries. */
  _scanLeaseMs() {
    const concurrency = positiveInteger(this.options.concurrency, 'concurrency');
    const attempts = nonNegativeInteger(this.options.maxRetries, 'maxRetries') + 1;
    const perSourceMs = positiveInteger(this.options.sourceTimeoutMs, 'sourceTimeoutMs') + 1_000;
    const sourceBatches = Math.max(1, Math.ceil(this.sources.length / concurrency));
    return Math.max(
      positiveInteger(this.options.attemptTimeoutMs, 'attemptTimeoutMs'),
      sourceBatches * attempts * perSourceMs,
    );
  }

  _idleDripResult({ scan, items, dailyLimit, publishingDay, sourceHealth, startedAt }) {
    const stats = { ...this._stats(0, Date.now() - startedAt.getTime()), mode: 'drip', remaining: 0 };
    if (scan?.error) {
      return { status: 'failed', reason: 'scan_failed', error: scan.error, mode: 'drip', publishingDay, sourceHealth, stats };
    }
    if (scan?.scanned && sourceHealth) {
      return { ...emptySourceResult({ publishingDay, sourceHealth, dryRun: false }), mode: 'drip', stats };
    }
    const reason = items.length >= dailyLimit ? 'daily_limit_reached' : scan?.reason ?? 'no_articles';
    return { status: 'skipped', reason, mode: 'drip', publishingDay, sourceHealth, stats };
  }

  async _runForcedDrip({ machine, runOptions, publishingDay, startedAt }) {
    const forceKey = String(runOptions.idempotencyKey);
    const requestId = String(runOptions.requestId ?? `force:${forceKey}`);
    const existing = (await machine.queryDeliveries({ requestId })).filter(record => (
      record.mode === 'drip'
      && record.requestId === requestId
      && record.forceKind !== null
    ))[0];
    if (existing && ['succeeded', 'abandoned'].includes(existing.state)) {
      const terminal = this._resultFromDelivery(existing, { reason: 'already_complete' });
      return {
        ...terminal,
        mode: 'drip',
        publishingDay,
        articles: [],
        stats: {
          ...this._stats(existing.articleHashes?.length ?? 0, Date.now() - startedAt.getTime()),
          mode: 'drip',
          remaining: 0,
        },
      };
    }
    let sourceHealth = null;
    let selection = null;
    let delivery = existing;
    let article = existing?.articleSnapshot?.[0] ?? (existing ? { title: null } : null);
    if (!delivery) {
      const prepared = await this._prepareArticles({
        force: true,
        dryRun: false,
        limit: runOptions.articleLimit,
      });
      sourceHealth = prepared.sourceHealth;
      selection = prepared.selection;
      if (prepared.articles.length === 0) {
        return withSelection({
          ...emptySourceResult({ publishingDay, sourceHealth, dryRun: false }),
          mode: 'drip',
        }, selection);
      }
      article = prepared.articles[0];
      delivery = await machine.prepareDelivery({
        requestId,
        mode: 'drip',
        publishingDay,
        articles: [article],
        outputs: this.outputs,
        forceKind: runOptions.operatorForce === true ? 'operator' : 'force',
        singleMutation: runOptions.singleMutation === true,
      });
    }
    if (!delivery.deliveryId) {
      return {
        status: delivery.status === 'suppressed' ? 'skipped' : 'failed',
        reason: delivery.reason,
        mode: 'drip',
        publishingDay,
        sourceHealth,
        articles: [],
        stats: { ...this._stats(0, Date.now() - startedAt.getTime()), mode: 'drip', remaining: 0 },
      };
    }

    const result = await this._executeDelivery({
      machine,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId ?? requestId,
      mode: 'drip',
      sourceHealth,
      confirmPausedMutation: runOptions.confirmPausedMutation === true,
      singleMutation: runOptions.singleMutation === true,
    });
    if (result.status === 'success') result.maintenance = await this._drainMaintenance(machine);
    const queue = await this.getQueue({ publishingDay });
    return withSelection({
      status: result.status,
      reason: result.reason,
      deliveryId: result.deliveryId,
      deliveryState: result.deliveryState,
      mode: 'drip',
      publishingDay,
      sourceHealth,
      articles: [{ article: article.title, ...result }],
      stats: {
        ...this._stats(1, Date.now() - startedAt.getTime()),
        mode: 'drip',
        remaining: queue.remaining,
        blocked: queue.blocked,
      },
    }, selection);
  }

  async _runDripCarryover({ machine, deliveries, publishingDay, startedAt, delayMs }) {
    const itemResults = [];
    for (let index = 0; index < deliveries.length; index++) {
      const delivery = deliveries[index];
      const result = await this._executeDelivery({
        machine,
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        mode: 'drip',
        sourceHealth: null,
      });
      const originalBatchId = await opaqueId(
        'day-batch', this.options.channelId, delivery.publishingDay, 'drip',
      );
      await machine.syncBatchItem(originalBatchId, delivery.deliveryId);
      itemResults.push({
        deliveryId: delivery.deliveryId,
        article: delivery.articleSnapshot[0]?.title,
        carriedFromPublishingDay: delivery.publishingDay,
        ...result,
      });
      if (index < deliveries.length - 1 && delayMs > 0) await sleep(delayMs);
    }
    const status = aggregateItemStatuses(itemResults);
    if (status === 'success' || status === 'partial') await this._drainMaintenance(machine);
    const active = (await machine.queryDeliveries({
      state: [...NON_TERMINAL_DELIVERY_STATES],
    })).filter(delivery => delivery.mode === 'drip');
    return {
      status,
      reason: status === 'success' ? undefined : 'cross_day_carryover',
      mode: 'drip',
      publishingDay,
      articles: itemResults,
      sourceHealth: null,
      stats: {
        ...this._stats(itemResults.length, Date.now() - startedAt.getTime()),
        mode: 'drip',
        remaining: active.length,
        blocked: active.filter(delivery => itemStateFromDelivery(delivery.state) === 'blocked').length,
      },
    };
  }

  async getQueue({ publishingDay } = {}) {
    const instant = this._captureInstant();
    const day = publishingDay ?? publishingDayFor(instant, this.options.timezone);
    if (!this.deliveryStore) return { date: day, remaining: 0, blocked: 0, articles: [] };
    const machine = await this._ensureMachine();
    const batchId = await opaqueId('day-batch', this.options.channelId, day, 'drip');
    const items = await machine.listBatchItems(batchId);
    const articles = [];
    let remaining = 0;
    let blocked = 0;
    for (const item of items) {
      const delivery = await machine.getDelivery(item.deliveryId);
      if (!delivery) continue;
      const state = itemStateFromDelivery(delivery.state);
      if (!['delivered', 'suppressed'].includes(state)) remaining += 1;
      if (state === 'blocked') blocked += 1;
      const article = delivery.articleSnapshot[0] ?? {};
      articles.push({
        id: article.id,
        title: article.title,
        url: article.url,
        source: article.source,
        state,
        deliveryId: delivery.deliveryId,
      });
    }
    return { date: day, remaining, blocked, articles };
  }

  async fetchAll() {
    this._validateSources();
    return (await this._fetchAllDetailed()).articles;
  }

  async generate(options = {}) {
    return this.run({ ...options, dryRun: true });
  }

  async close() {
    if (this.deliveryStore?.close) await this.deliveryStore.close();
    if (this.cache?.disconnect) await this.cache.disconnect();
  }

  async _executeDelivery({ machine, deliveryId, requestId, mode, sourceHealth, confirmPausedMutation = false, singleMutation = false }) {
    let delivery = await machine.getDelivery(deliveryId);
    let aiUsage = null;
    const runOutputResults = [];
    const topologyCheck = await machine.validateOutputTopology(deliveryId, this.outputs);
    if (topologyCheck.status !== 'valid') {
      return this._resultFromDelivery(topologyCheck.delivery, {
        sourceHealth,
        reason: topologyCheck.reason ?? 'output_topology_changed',
      });
    }
    delivery = topologyCheck.delivery;
    const enforceSingleMutation = delivery.singleMutation === true || singleMutation;

    if (['pending_generation', 'generation_retry_pending', 'manual_generation_retry_pending'].includes(delivery.state)) {
      const claim = await machine.claimGeneration(deliveryId, { requestId, confirmPausedMutation });
      if (claim.status === 'claimed') {
        try {
          const generated = await this._summarize(delivery.articleSnapshot, mode);
          aiUsage = generated.usage ?? null;
          delivery = await machine.commitGeneration(claim.attempt.attemptId, { content: generated.text });
        } catch (error) {
          console.error('[AI] Generation failed', {
            channelId: this.options.channelId,
            deliveryId,
            error: sanitizeError(error),
          });
          delivery = await machine.failGeneration(claim.attempt.attemptId, error, { retryDisposition: 'automatic' });
          return this._resultFromDelivery(delivery, {
            sourceHealth,
            reason: delivery.state === 'generation_exhausted' ? 'generation_attempts_exhausted' : 'generation_retry_scheduled',
          });
        }
      } else if (claim.status !== 'ready') {
        return this._resultFromDelivery(delivery, { sourceHealth, reason: claim.reason });
      }
    }

    delivery = await machine.getDelivery(deliveryId);
    if (!delivery.generatedContent) return this._resultFromDelivery(delivery, { sourceHealth });
    while (true) {
      const claim = await machine.claimNextOutput(deliveryId, { requestId, confirmPausedMutation });
      if (claim.status === 'complete') break;
      if (claim.status !== 'claimed') {
        delivery = await machine.getDelivery(deliveryId);
        return this._resultFromDelivery(delivery, {
          sourceHealth,
          content: delivery.generatedContent,
          outputs: runOutputResults,
          aiUsage,
          reason: claim.reason === 'channel_blocked_ambiguous'
            ? 'output_needs_reconciliation'
            : claim.reason,
        });
      }
      const output = this.outputs[claim.output.ordinal];
      const configuredTarget = topologyCheck.topology.outputs[claim.output.ordinal];
      if (!output
        || output.id !== claim.output.providerId
        || configuredTarget?.outputKey !== claim.output.outputKey
        || configuredTarget.providerId !== claim.output.providerId) {
        return {
          status: 'failed',
          reason: 'output_topology_changed',
          deliveryId,
          sourceHealth,
        };
      }
      let normalized;
      try {
        const outputTimeoutMs = Math.min(
          positiveInteger(this.options.outputTimeoutMs, 'outputTimeoutMs'),
          Math.max(1, positiveInteger(this.options.attemptTimeoutMs, 'attemptTimeoutMs') - 100),
        );
        const sent = await withOperationTimeout(signal => output.send(
          enforceSingleMutation ? claim.content : this._fitToOutput(claim.content, output),
          {
            articles: delivery.articleSnapshot,
            article: mode === 'drip' ? delivery.articleSnapshot[0] : undefined,
            deliveryId,
            attemptId: claim.attempt.attemptId,
            singleMutation: enforceSingleMutation,
            signal,
          },
        ), outputTimeoutMs, `Output ${output.id}`);
        normalized = normalizeSendResult(sent, { now: this._captureInstant().getTime() });
      } catch (error) {
        normalized = normalizeSendResult(null, { error, now: this._captureInstant().getTime() });
      }
      try {
        const committed = await machine.commitOutput(claim.attempt.attemptId, normalized);
        runOutputResults.push({
          id: output.id,
          name: output.name,
          outputKey: claim.output.outputKey,
          ...committed.result,
        });
        delivery = committed.delivery;
      } catch (error) {
        return {
          status: 'ambiguous',
          reason: 'state_commit_failed',
          deliveryId,
          content: claim.content,
          sourceHealth,
          outputs: runOutputResults,
          error: sanitizeError(error),
        };
      }
      if (normalized.meta.deliveryState !== 'success') break;
    }
    delivery = await machine.getDelivery(deliveryId);
    return this._resultFromDelivery(delivery, {
      sourceHealth,
      content: delivery.generatedContent,
      outputs: runOutputResults,
      aiUsage,
    });
  }

  async _prepareArticles({ force, dryRun, limit, exclude }) {
    const fetched = await this._fetchAllDetailed();
    let articles = fetched.articles;
    // Per-run counts make over-filtering visible without exposing article content.
    const selection = { fetched: articles.length };
    if (!force) articles = await this._dedup(articles, { dryRun });
    selection.fresh = articles.length;
    if (exclude) {
      const candidates = articles;
      articles = exclude(articles);
      selection.uncovered = articles.length;
      await this._reportCoveredStories(candidates, articles);
    }
    selection.relevant = articles.length;
    for (const middleware of this.middlewares) {
      articles = await middleware(articles);
      if (middleware.label === 'tech-relevance') selection.relevant = articles.length;
    }
    selection.ranked = articles.length;
    if (limit !== undefined) articles = articles.slice(0, positiveInteger(limit, 'articleLimit'));
    return { articles, sourceHealth: fetched.sourceHealth, selection };
  }

  /**
   * Diagnostics only: hand the candidates a radar scan skipped as already-covered
   * stories to the optional `onCoveredStoriesExcluded` observer. The observer
   * cannot change the selection, and its failures are logged, never raised.
   */
  async _reportCoveredStories(candidates, kept) {
    const observer = this.options.onCoveredStoriesExcluded;
    if (typeof observer !== 'function' || kept.length === candidates.length) return;
    const keptArticles = new Set(kept);
    try {
      await observer(candidates.filter(article => !keptArticles.has(article)));
    } catch (error) {
      console.warn('[Radar] Covered-story observer failed', {
        channelId: this.options.channelId,
        error: sanitizeError(error),
      });
    }
  }

  async _prepareDripDeliveries(machine, articles, publishingDay) {
    const deliveries = [];
    for (const article of articles) {
      const itemRequestId = await opaqueId('drip-item', this.options.channelId, publishingDay, article.source, article.id);
      const delivery = await machine.prepareDelivery({
        requestId: itemRequestId,
        mode: 'drip',
        publishingDay,
        articles: [article],
        outputs: this.outputs,
        singleMutation: false,
      });
      if (delivery.deliveryId) deliveries.push(delivery);
    }
    return deliveries;
  }

  async _fetchAllDetailed() {
    const { concurrency, maxArticlesPerSource, maxRetries } = this.options;
    const since = this.options.since === null || this.options.since === undefined
      ? new Date(this._captureInstant().getTime() - positiveNumber(this.options.sourceWindowHours, 'sourceWindowHours') * 60 * 60 * 1_000)
      : validDate(this.options.since, 'since');
    const articles = [];
    const diagnostics = [];
    const identities = new Map();
    for (let index = 0; index < this.sources.length; index += concurrency) {
      const batch = this.sources.slice(index, index + concurrency);
      const results = await Promise.all(batch.map(source => (
        this._fetchWithRetry(source, { limit: maxArticlesPerSource, since }, maxRetries)
      )));
      for (const result of results) {
        const accepted = [];
        const pending = new Map();
        let collision = false;
        for (const article of result.articles) {
          const snapshot = projectArticle(article);
          const identity = `${result.diagnostic.sourceId}:${snapshot.id}`;
          const serialized = JSON.stringify(snapshot);
          const known = pending.get(identity) ?? identities.get(identity);
          if (known !== undefined) {
            if (known !== serialized) {
              collision = true;
              break;
            }
            continue;
          }
          pending.set(identity, serialized);
          accepted.push(article);
        }
        // Two different articles under one id are ambiguous; drop that source for this pass only.
        if (collision) {
          diagnostics.push(identityCollisionDiagnostic(result.diagnostic));
          continue;
        }
        diagnostics.push(result.diagnostic);
        for (const [identity, serialized] of pending) identities.set(identity, serialized);
        articles.push(...accepted);
      }
      if (index + concurrency < this.sources.length) await sleep(50);
    }
    const failed = diagnostics.filter(value => value.status === 'failed').length;
    const unknown = diagnostics.filter(value => value.status === 'unknown').length;
    const healthy = diagnostics.filter(value => ['success', 'empty'].includes(value.status)).length;
    return {
      articles,
      diagnostics,
      sourceHealth: {
        total: diagnostics.length,
        healthy,
        failed,
        unknown,
        degraded: failed > 0 || unknown > 0,
        allFailed: articles.length === 0 && failed === diagnostics.length && diagnostics.length > 0,
        exhaustionEligible: diagnostics.length > 0 && failed === 0 && unknown === 0,
        diagnostics,
      },
    };
  }

  async _fetchWithRetry(source, options, maxRetries) {
    let lastDiagnostic = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fetched = await withOperationTimeout(
          signal => source.fetchWithDiagnostics({ ...options, signal }),
          positiveInteger(this.options.sourceTimeoutMs, 'sourceTimeoutMs'),
          `Source ${source.id}`,
        );
        if (!fetched || !Array.isArray(fetched.articles) || !fetched.diagnostic) {
          throw new Error('source diagnostic result is invalid');
        }
        const normalized = fetched.articles.map(article => ({
          ...article,
          id: article.id || article.url || `${source.id}:${article.title}`,
          source: article.source || source.name,
        }));
        lastDiagnostic = sanitizeSourceDiagnostic(source, fetched.diagnostic, normalized.length);
        if (lastDiagnostic.status !== 'failed' || attempt === maxRetries) {
          return { articles: normalized, diagnostic: lastDiagnostic };
        }
      } catch (error) {
        lastDiagnostic = {
          sourceId: source.id,
          sourceName: source.name,
          status: 'failed',
          articleCount: 0,
          failureType: 'exception',
          sanitizedError: sanitizeError(error),
        };
        if (attempt === maxRetries) return { articles: [], diagnostic: lastDiagnostic };
      }
      await sleep(Math.min(1_000, 100 * (attempt + 1)));
    }
    return { articles: [], diagnostic: lastDiagnostic };
  }

  async _dedup(articles, { dryRun }) {
    const now = this._captureInstant();
    const fresh = [];
    for (const article of articles) {
      const projected = projectArticle(article);
      const hash = await channelArticleHash(this.options.channelId, projected);
      const compatibilityHash = legacyHash(projected.id);
      const compatibilityId = await opaqueId(
        'legacy-seen-compat',
        this.options.channelId,
        compatibilityHash,
      );
      const [record, legacyCompat] = this.deliveryStore
        ? await Promise.all([
          this.deliveryStore.get('articles', hash),
          this.deliveryStore.get('legacy_seen_compat', compatibilityId),
        ])
        : [null, null];
      if (record?.activeDeliveryId || record?.terminalState || record?.safetySuppressed) continue;
      if (legacyCompat?.legacyHash === compatibilityHash && legacySeenIsActive(legacyCompat, now)) continue;
      const key = `seen:${compatibilityHash}`;
      const seen = dryRun ? await this.cache.peek(key) : await this.cache.peek(key);
      if (seen === null) fresh.push(article);
    }
    return fresh;
  }

  async _summarize(articles, mode) {
    if (!this.ai) throw new Error('AI plugin is required to generate Vietnamese output with diacritics');
    const generationTimeoutMs = Math.min(
      positiveInteger(this.options.generationTimeoutMs, 'generationTimeoutMs'),
      Math.max(1, positiveInteger(this.options.attemptTimeoutMs, 'attemptTimeoutMs') - 100),
    );
    const result = await withOperationTimeout(
      signal => this.ai.summarize(articles, {
        language: this.options.language || 'vi',
        style: this.options.style,
        audience: this.options.audience,
        platform: this.options.platform,
        ...(this.options.customSystemPrompt && { customSystemPrompt: this.options.customSystemPrompt }),
        deliveryMode: mode,
        signal,
      }),
      generationTimeoutMs,
      `AI ${this.ai.id}`,
    );
    if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('AI returned empty content');
    return result;
  }

  async _drainMaintenance(machine, limit = 100) {
    if (this.cache instanceof NoopCache) return { succeeded: 0, pending: (await machine.listOutbox(value => value.state !== 'succeeded')).length };
    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < limit; index++) {
      const row = await machine.claimMaintenance();
      if (!row) break;
      try {
        await this.cache.set(row.targetKey, row.targetValue, row.kind === 'legacy_digest' ? 30 * 24 * 60 * 60 * 1_000 : 7 * 24 * 60 * 60 * 1_000);
        await machine.commitMaintenance(row.outboxId, { success: true });
        succeeded += 1;
      } catch (error) {
        await machine.commitMaintenance(row.outboxId, { success: false, error });
        failed += 1;
      }
    }
    return { succeeded, failed };
  }

  /**
   * An output that ended ambiguous blocks its channel until someone proves what happened. When the
   * destination itself can show the post arrived (`OutputPlugin.findDelivered`), confirm the output
   * through the same audited path an operator uses and let the run continue. Nothing is ever sent
   * here, and any doubt (no proof, a changed destination, an error) leaves the output ambiguous; a
   * block that stays is reported to the optional `onChannelBlocked` observer.
   * @returns {Promise<boolean>} true when an ambiguous output was confirmed
   */
  async _reconcileAmbiguousOutput(machine) {
    let block = null;
    try {
      block = await this._blockingOutput(machine);
      if (!block) return false;
      if (await this._confirmFromDestination(machine, block)) return true;
    } catch (error) {
      // Includes losing a race with an operator who confirmed the same output first.
      console.warn('[Reconcile] Could not confirm an ambiguous send', {
        channelId: this.options.channelId,
        error: sanitizeError(error),
      });
    }
    if (block) await this._reportBlockedChannel(machine, block);
    return false;
  }

  /** The attempt, delivery, and output that hold an `ambiguous` block on this channel, or null. */
  async _blockingOutput(machine) {
    const channel = await machine.getChannelState();
    // A paused channel is deliberately idle, so it is neither reconciled nor reported.
    if (channel?.paused || channel?.mutationState !== 'blocked_ambiguous' || !channel.activeOutputAttemptId) return null;
    const attempt = await machine.getAttempt(channel.activeOutputAttemptId);
    if (attempt?.kind !== 'output') return null;
    const [delivery, output] = await Promise.all([
      machine.getDelivery(attempt.deliveryId),
      machine.getOutput(attempt.deliveryId, attempt.outputKey),
    ]);
    if (!delivery || output?.state !== 'needs_reconciliation' || output.activeAttemptId !== attempt.attemptId) return null;
    return { attempt, delivery, output };
  }

  async _confirmFromDestination(machine, { attempt, delivery, output }) {
    // Earlier parts of a multi-part send are certain, so a post carrying the link says nothing about the rest.
    if (output.partialMutation) return false;
    // Only look in the destination the ambiguous attempt used: a changed topology proves nothing.
    const topology = await buildOutputTopology(this.outputs);
    const configured = topology.outputs[output.ordinal];
    if (delivery.topologyFingerprint !== topology.fingerprint
      || configured?.outputKey !== output.outputKey
      || configured.providerId !== output.providerId) return false;

    const plugin = this.outputs[output.ordinal];
    // The post can only have been made while the attempt ran; a later post of the same link is not it.
    const deadline = Date.parse(attempt.deadlineAt);
    const ended = Date.parse(attempt.completedAt ?? attempt.deadlineAt);
    const found = await withOperationTimeout(signal => plugin.findDelivered({
      articles: delivery.articleSnapshot,
      since: new Date(attempt.startedAt),
      until: new Date(Math.min(ended, deadline)),
      signal,
    }), positiveInteger(this.options.reconcileLookupTimeoutMs, 'reconcileLookupTimeoutMs'), `Reconcile ${plugin.id}`);
    if (!found?.messageId) return false;

    await machine.reconcile({
      action: 'confirm-delivered',
      deliveryId: delivery.deliveryId,
      outputKey: output.outputKey,
      expectedVersion: output.version,
      operatorId: RECONCILE_OPERATOR_ID,
      reason: `The destination shows the post (message ${found.messageId}); confirmed without sending again`,
      idempotencyKey: `${RECONCILE_OPERATOR_ID}:${attempt.attemptId}`,
      messageId: found.messageId,
    });
    this.logger(`[Reconcile] ${this.options.channelId}: confirmed an ambiguous send as delivered (message ${found.messageId})`);
    return true;
  }

  /**
   * Tell the optional `onChannelBlocked` observer that this channel stays blocked after a reconcile
   * attempt, so a person can step in. Failures are logged, never raised.
   */
  async _reportBlockedChannel(machine, { attempt, delivery }) {
    const observer = this.options.onChannelBlocked;
    if (typeof observer !== 'function') return;
    try {
      // An operator may have confirmed it while the lookup ran; only a block that still stands is news.
      const channel = await machine.getChannelState();
      if (channel?.mutationState !== 'blocked_ambiguous' || channel.activeOutputAttemptId !== attempt.attemptId) return;
      const article = delivery.articleSnapshot?.[0];
      await observer({
        channelId: this.options.channelId,
        attemptId: attempt.attemptId,
        deliveryId: delivery.deliveryId,
        article: article ? { title: article.title, url: article.url } : null,
      });
    } catch (error) {
      console.warn('[Reconcile] Blocked-channel observer failed', {
        channelId: this.options.channelId,
        error: sanitizeError(error),
      });
    }
  }

  async _validateMutation() {
    if (this.outputs.length === 0) throw new Error('Non-dry delivery requires at least one output');
    assertDeliveryStore(this.deliveryStore, { allowEphemeral: this.options.allowEphemeralDelivery });
    await this._initializeStore();
  }

  _validateBase() {
    this._validateSources();
    if (!this.ai) throw new Error('AI plugin is required');
  }

  _validateSources() {
    if (this.sources.length === 0) throw new Error('No sources registered');
  }

  async _initializeStore() {
    if (!this.deliveryStore || this._storeInitialized) return;
    if (typeof this.deliveryStore.initialize === 'function') await this.deliveryStore.initialize();
    this._storeInitialized = true;
  }

  async _ensureMachine() {
    await this._initializeStore();
    if (!this._machine) {
      this._machine = new DeliveryStateMachine({
        store: this.deliveryStore,
        channelId: this.options.channelId,
        clock: this.options.clock,
        attemptTimeoutMs: this.options.attemptTimeoutMs,
        maxGenerationAttempts: this.options.maxGenerationAttempts,
        maxOutputAttempts: this.options.maxOutputAttempts,
        allowEphemeral: this.options.allowEphemeralDelivery,
      });
    }
    return this._machine;
  }

  _resultFromDelivery(delivery, options = {}) {
    const state = delivery.state;
    let status;
    let reason = options.reason;
    if (state === 'succeeded') status = 'success';
    else if (state === 'needs_reconciliation') { status = 'ambiguous'; reason ??= 'output_needs_reconciliation'; }
    else if (['partial_retryable', 'output_manual_retry_required', 'output_exhausted'].includes(state)) {
      const knownResults = options.outputs ?? [];
      const aggregation = knownResults.length ? aggregateSendResults(knownResults) : null;
      const durableSuccesses = Number(delivery.outputSummary?.succeeded ?? 0);
      status = durableSuccesses > 0 || aggregation?.successCount > 0 ? 'partial' : 'failed';
      reason ??= state;
    } else if (state === 'blocked_topology') { status = 'failed'; reason ??= 'output_topology_changed'; }
    else if (state === 'abandoned') { status = 'failed'; reason ??= 'abandoned'; }
    else { status = 'failed'; reason ??= state; }
    return {
      status,
      reason,
      deliveryId: delivery.deliveryId,
      publishingDay: delivery.publishingDay,
      content: options.content ?? delivery.generatedContent ?? undefined,
      sourceHealth: options.sourceHealth ?? undefined,
      aiUsage: options.aiUsage ?? null,
      outputs: options.outputs ?? [],
      deliveryState: state,
      stats: this._stats(delivery.articleHashes?.length ?? 0, 0),
    };
  }

  _fitToOutput(content, output) {
    if (content.length <= output.maxLength) return content;
    const truncated = content.substring(0, Math.max(0, output.maxLength - 50));
    const lastBreak = truncated.lastIndexOf('\n\n');
    return (lastBreak > content.length * 0.5 ? truncated.substring(0, lastBreak) : truncated) + '\n\n[...]';
  }

  _stats(articleCount, durationMs) {
    return {
      sources: this.sources.length,
      articles: articleCount,
      outputs: this.outputs.length,
      ai: this.ai?.name || null,
      durationMs,
    };
  }

  _captureInstant(value) {
    const instant = value === undefined ? this.options.clock() : value;
    const date = instant instanceof Date ? new Date(instant) : new Date(instant);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid request instant');
    return date;
  }
}

class NoopCache extends CachePlugin {}

function sanitizeSourceDiagnostic(source, diagnostic, articleCount) {
  const allowedStatuses = new Set(['success', 'empty', 'failed', 'unknown']);
  const status = allowedStatuses.has(diagnostic.status) ? diagnostic.status : 'unknown';
  const result = {
    sourceId: String(source.id).slice(0, 100),
    sourceName: String(source.name).slice(0, 200),
    status,
    articleCount,
  };
  if (diagnostic.failureType) result.failureType = String(diagnostic.failureType).slice(0, 80);
  if (Number.isInteger(diagnostic.httpStatus)) result.httpStatus = diagnostic.httpStatus;
  if (diagnostic.sanitizedError) result.sanitizedError = sanitizeError(diagnostic.sanitizedError);
  return result;
}

function emptySourceResult({ publishingDay, sourceHealth, dryRun }) {
  if (sourceHealth.allFailed || (sourceHealth.healthy === 0 && (sourceHealth.failed > 0 || sourceHealth.unknown > 0))) {
    return { status: 'failed', reason: 'sources_failed', publishingDay, sourceHealth, stats: { articles: 0 } };
  }
  return {
    status: dryRun ? 'dry_run' : 'skipped',
    reason: 'no_articles',
    publishingDay,
    sourceHealth,
    stats: { articles: 0 },
  };
}

/** Attach the run's article selection counts to its stats when this run prepared articles. */
function withSelection(result, selection) {
  if (!selection) return result;
  return { ...result, stats: { ...result.stats, selection } };
}

/** Calendar arithmetic on the publishing-day string stays correct across DST changes. */
function previousPublishingDay(publishingDay) {
  return new Date(Date.parse(`${publishingDay}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Publishing days whose deliveries can still cover a story the source window returns: the
 * window plus one day, so a 24-hour window checks today and yesterday and a 48-hour one
 * adds the day before.
 */
function coveragePublishingDays(publishingDay, windowHours) {
  const count = Math.ceil(positiveNumber(windowHours, 'sourceWindowHours') / 24) + 1;
  const days = [publishingDay];
  while (days.length < count) days.push(previousPublishingDay(days[days.length - 1]));
  return days;
}

function coveredArticles(deliveries) {
  return deliveries.flatMap(delivery => (Array.isArray(delivery.articleSnapshot) ? delivery.articleSnapshot : []));
}

function identityCollisionDiagnostic(diagnostic) {
  return {
    sourceId: diagnostic.sourceId,
    sourceName: diagnostic.sourceName,
    status: 'failed',
    articleCount: 0,
    failureType: 'identity_collision',
    sanitizedError: 'Source returned different articles with the same id',
  };
}

function pausedRunResult({ publishingDay, mode }) {
  return {
    status: 'skipped',
    reason: 'channel_paused',
    mode,
    publishingDay,
    stats: { articles: 0, outputs: 0 },
  };
}

async function normalizeMutationRunOptions(options, { channelId, dryRun, force }) {
  if (dryRun) return options;
  const operatorForce = options.operatorForce === true;
  const confirmPausedMutation = options.confirmPausedMutation === true;
  const singleMutation = options.singleMutation === true;
  if (operatorForce && (!force || !confirmPausedMutation || !singleMutation)) {
    throw new Error('Operator force requires force, confirmPausedMutation, and singleMutation');
  }
  if (confirmPausedMutation && !(force && operatorForce && singleMutation)) {
    throw new Error('confirmPausedMutation is reserved for an operator single-mutation canary');
  }
  if (!force) return options;
  const idempotencyKey = requiredRunIdentity(options.idempotencyKey, 'Force idempotencyKey');
  const requestId = requiredRunIdentity(options.requestId, 'Force requestId');
  return {
    ...options,
    idempotencyKey: await opaqueId('engine-force-idempotency', channelId, idempotencyKey),
    requestId: await opaqueId('engine-force-request', channelId, requestId, idempotencyKey),
  };
}

function isAuthorizedPausedMutation(options) {
  return options.force === true
    && options.operatorForce === true
    && options.confirmPausedMutation === true
    && options.singleMutation === true;
}

function requiredRunIdentity(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > 500) throw new Error(`${label} exceeds 500 characters`);
  return text;
}

function aggregateItemStatuses(results) {
  if (results.some(result => result.status === 'ambiguous')) return 'ambiguous';
  const successes = results.filter(result => result.status === 'success').length;
  if (successes === results.length && results.length > 0) return 'success';
  if (successes > 0) return 'partial';
  return results.length === 0 ? 'skipped' : 'failed';
}

function itemStateFromDelivery(state) {
  if (state === 'succeeded') return 'delivered';
  if (state === 'abandoned') return 'suppressed';
  if (['pending_generation', 'ready'].includes(state)) return 'queued';
  if (['generating', 'delivering'].includes(state)) return 'running';
  if (['generation_retry_pending', 'partial_retryable'].includes(state)) return 'retryable';
  return 'blocked';
}

function legacyHash(value) {
  let hash = 0;
  const string = String(value);
  for (let index = 0; index < string.length; index++) {
    hash = ((hash << 5) - hash) + string.charCodeAt(index);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}

function legacySeenIsActive(record, now) {
  const explicitExpiry = Date.parse(record.expiresAt ?? '');
  if (Number.isFinite(explicitExpiry)) return explicitExpiry > now.getTime();
  const importedAt = Date.parse(record.importedAt ?? '');
  return Number.isFinite(importedAt) && importedAt + 7 * 24 * 60 * 60 * 1_000 > now.getTime();
}

function stableSourceSelection(options, middlewares) {
  const sourceWindow = options.since === null || options.since === undefined
    ? { sourceWindowHours: positiveNumber(options.sourceWindowHours, 'sourceWindowHours') }
    : { since: validDate(options.since, 'since').toISOString() };
  return JSON.stringify({
    maxArticlesPerSource: positiveInteger(options.maxArticlesPerSource, 'maxArticlesPerSource'),
    ...sourceWindow,
    middlewares: middlewares.map((middleware, index) => (
      middleware.selectionKey ?? `custom:${index}:${String(middleware)}`
    )),
  });
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 8_760) {
    throw new Error(`${label} must be between 0 and 8760`);
  }
  return number;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function integerInRange(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer in range ${minimum}-${maximum}`);
  }
  return number;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withOperationTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
