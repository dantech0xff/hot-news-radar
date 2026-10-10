/**
 * Runtime scheduler: one node-cron job per enabled channel (in the channel's
 * timezone), a single global queue that runs one job at a time, and the
 * single-instance runtime lease that gates both.
 *
 * - The scheduler works only while it holds the lease. A heartbeat renews it;
 *   when renewal fails the cron jobs stop and queued jobs are dropped until
 *   the lease is acquired again.
 * - Cron ticks are re-checked with `shouldRun()` against the tick instant, so
 *   a run that waits in the queue keeps the schedule it was due for.
 * - A tick for a channel that is already running or queued is skipped and logged.
 * - `reloadChannel()` re-registers one channel's cron job after a config
 *   change, without a restart.
 * - `stop()` stops accepting work and waits (bounded) for the job in flight.
 *   Work in flight is never cut short: the lease stays renewed until it
 *   finishes and is released then; `drain()` settles at that point, and only
 *   then may the database be closed.
 *
 * The engine has no cooperative stop between output claims (the only in-run
 * gate is the durable `paused` flag, which would outlive the restart), so a run
 * in flight at shutdown runs to completion.
 */

import { randomUUID } from 'node:crypto';

import { sanitizeRuntimeError, shouldRun } from '../../channels/runner.js';
import { RuntimeError } from './errors.js';

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
/**
 * How long `stop()` waits for work in flight by default. It covers one drip
 * item end to end (generation up to `DEFAULT_GENERATION_TIMEOUT_MS` and output
 * up to `DEFAULT_OUTPUT_TIMEOUT_MS`, plus store commits) with room for a source
 * scan; the container stop grace period must be longer (see
 * `SHUTDOWN_WAIT_SECONDS` in `config/env.js`).
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 120_000;

const DEFAULT_TIMERS = Object.freeze({
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
});

/**
 * @typedef {object} QueuedJob
 * @property {string} key Dedup key: a channel id, or `maintenance`.
 * @property {string|null} channelId
 * @property {string|null} runId
 * @property {string} label
 * @property {() => Promise<unknown>} execute
 * @property {(value: unknown) => void} resolve
 */

export class RuntimeScheduler {
  /**
   * @param {{
   *   lease: import('../db/runtime-lease.js').RuntimeLease,
   *   ownerId: string,
   *   cron: { schedule: (expression: string, callback: (context?: { date?: Date }) => unknown, options: { timezone: string, name?: string }) => { stop?: () => void, destroy?: () => void } },
   *   getChannel: (channelId: string) => { id: string, enabled: boolean, cron: string, timezone: string }|null,
   *   listChannels: () => { id: string, enabled: boolean, cron: string, timezone: string }[],
   *   executeRun: (request: { channelId: string, runId?: string, triggerType: 'scheduled'|'manual', requestedAt: Date, triggeredBy?: string|null }) => Promise<unknown>,
   *   onLeaseAcquired?: (context: { first: boolean, inFlightRunIds: string[] }) => unknown,
   *   maintenance?: { isDue: () => boolean, execute: (options: { fullSync: boolean }) => Promise<unknown> },
   *   clock?: () => Date,
   *   logger?: Pick<Console, 'log'|'warn'|'error'>,
   *   timers?: Partial<typeof DEFAULT_TIMERS>,
   *   leaseTtlMs?: number,
   *   heartbeatMs?: number,
   *   shutdownTimeoutMs?: number,
   * }} options
   */
  constructor({
    lease, ownerId, cron, getChannel, listChannels, executeRun, onLeaseAcquired = () => {}, maintenance = null,
    clock = () => new Date(), logger = console, timers = {},
    leaseTtlMs = DEFAULT_LEASE_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS, shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  }) {
    if (typeof lease?.acquire !== 'function' || typeof lease.renew !== 'function' || typeof lease.release !== 'function') {
      throw new TypeError('RuntimeScheduler requires a runtime lease');
    }
    if (typeof cron?.schedule !== 'function') throw new TypeError('RuntimeScheduler requires a cron implementation');
    for (const [name, value] of Object.entries({ getChannel, listChannels, executeRun, onLeaseAcquired, clock })) {
      if (typeof value !== 'function') throw new TypeError(`RuntimeScheduler ${name} must be a function`);
    }
    for (const [name, value] of Object.entries({ leaseTtlMs, heartbeatMs, shutdownTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`RuntimeScheduler ${name} must be a positive integer`);
    }
    if (heartbeatMs >= leaseTtlMs) throw new TypeError('RuntimeScheduler heartbeat must be shorter than the lease TTL');
    this._lease = lease;
    this._ownerId = ownerId;
    this._cron = cron;
    this._getChannel = getChannel;
    this._listChannels = listChannels;
    this._executeRun = executeRun;
    this._onLeaseAcquired = onLeaseAcquired;
    this._maintenance = maintenance;
    this._clock = clock;
    this._logger = logger;
    this._timers = resolveTimers(timers);
    this._leaseTtlMs = leaseTtlMs;
    this._heartbeatMs = heartbeatMs;
    this._shutdownTimeoutMs = shutdownTimeoutMs;

    this._started = false;
    this._accepting = false;
    this._leased = false;
    this._everLeased = false;
    this._heartbeat = null;
    /** @type {Map<string, { task: { stop?: () => void, destroy?: () => void }, cron: string, timezone: string }>} */
    this._tasks = new Map();
    /** @type {QueuedJob[]} */
    this._queue = [];
    /** @type {QueuedJob|null} */
    this._current = null;
    this._worker = null;
    /** @type {Set<Promise<unknown>>} */
    this._operations = new Set();
    this._stopping = null;
    /** @type {Promise<{ released: boolean }>|null} */
    this._drained = null;
    this._beating = null;
  }

  /** Whether this instance holds the runtime lease and accepts work. */
  get active() {
    return this._accepting && this._leased;
  }

  /**
   * Start the heartbeat and make the first lease attempt. When another owner
   * holds the lease, the heartbeat keeps retrying until it can be taken.
   * @returns {Promise<{ leased: boolean }>}
   */
  async start() {
    if (this._stopping) throw new RuntimeError('runtime_stopped', 'The runtime scheduler is stopped');
    if (!this._started) {
      this._started = true;
      this._accepting = true;
      // `_beat()` never rejects; returning it lets injected test timers await a beat.
      this._heartbeat = this._timers.setInterval(() => this._beat(), this._heartbeatMs);
      this._heartbeat?.unref?.();
    }
    await this._beat();
    return { leased: this._leased };
  }

  /**
   * Re-register a channel's cron job from its current config, or remove the
   * job when the channel was deleted or disabled. A no-op while this
   * instance does not hold the lease (jobs are registered on acquisition).
   * @param {string} channelId
   */
  reloadChannel(channelId) {
    this._unregister(channelId);
    if (!this.active) return;
    const channel = this._getChannel(channelId);
    if (channel?.enabled) this._register(channel);
  }

  /**
   * Queue a run. Returns a skip instead of queueing when the runtime is not
   * active or the channel already has a run running or queued.
   * @param {{ channelId: string, runId: string, triggerType: 'scheduled'|'manual', requestedAt: Date, triggeredBy?: string|null }} request
   * @returns {{ status: 'queued', runId: string, position: number, done: Promise<unknown> } | { status: 'skipped', reason: string }}
   */
  enqueueRun(request) {
    const { channelId, runId } = request;
    if (!this._accepting) return { status: 'skipped', reason: 'runtime_stopped' };
    if (!this._leased) return { status: 'skipped', reason: 'runtime_not_leased' };
    if (this.isBusy(channelId)) return { status: 'skipped', reason: 'channel_busy' };
    const done = this._enqueue({
      key: channelId,
      channelId,
      runId,
      label: `${request.triggerType} run of ${channelId}`,
      execute: () => this._executeRun(request),
    });
    return { status: 'queued', runId, position: this._queue.length + (this._current ? 1 : 0), done };
  }

  /**
   * Queue the maintenance job (library sync + retention) unless it is already queued.
   * @param {{ fullSync?: boolean }} [options]
   * @returns {Promise<unknown>|null} Settles when the job finishes; `null` when not queued.
   */
  enqueueMaintenance({ fullSync = false } = {}) {
    if (!this._maintenance || !this.active || this.isBusy('maintenance')) return null;
    return this._enqueue({
      key: 'maintenance',
      channelId: null,
      runId: null,
      label: 'maintenance',
      execute: () => this._maintenance.execute({ fullSync }),
    });
  }

  /**
   * @param {string} key Channel id, or `maintenance`.
   * @returns {boolean} Whether a job with this key is running or queued.
   */
  isBusy(key) {
    return this._current?.key === key || this._queue.some(job => job.key === key);
  }

  /**
   * Keep shutdown waiting for an operation that mutates delivery state
   * outside the queue (operator controls).
   * @template T
   * @param {Promise<T>} operation
   * @returns {Promise<T>}
   */
  track(operation) {
    const tracked = Promise.resolve(operation);
    const settled = tracked.then(() => {}, () => {});
    this._operations.add(settled);
    settled.then(() => this._operations.delete(settled));
    return tracked;
  }

  /**
   * @returns {{
   *   active: boolean, leased: boolean, ownerId: string,
   *   running: { channelId: string|null, runId: string|null, label: string }|null,
   *   queued: { channelId: string|null, runId: string|null, label: string }[],
   *   scheduledChannels: string[],
   * }}
   */
  describe() {
    const view = job => ({ channelId: job.channelId, runId: job.runId, label: job.label });
    return {
      active: this.active,
      leased: this._leased,
      ownerId: this._ownerId,
      running: this._current ? view(this._current) : null,
      queued: this._queue.map(view),
      scheduledChannels: [...this._tasks.keys()],
    };
  }

  /**
   * Stop accepting work (cron jobs are removed, queued jobs dropped) and wait
   * up to `timeoutMs` for the running job and tracked operations.
   *
   * Nothing in flight is cut short. When the wait times out (`timedOut`), the
   * lease keeps being renewed until the work finishes and is released then;
   * `drain()` settles at that point. Keep the database open until it does.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ released: boolean, timedOut: boolean }>} `released`:
   *   the lease was released within the wait.
   */
  stop({ timeoutMs = this._shutdownTimeoutMs } = {}) {
    if (!this._stopping) this._stopping = this._stop(timeoutMs);
    return this._stopping;
  }

  /**
   * Wait, without a time limit, until nothing started before `stop()` (or a
   * pause tracked since) is in flight; the runtime lease is released by then
   * when this instance still held it. Calls `stop()` first when needed.
   * @returns {Promise<{ released: boolean }>}
   */
  async drain() {
    await this.stop();
    const { released } = await this._drained;
    // A pause tracked after that (while the HTTP server was closing) is waited for too.
    while (this._operations.size > 0) await Promise.allSettled([...this._operations]);
    return { released };
  }

  async _stop(timeoutMs) {
    this._accepting = false;
    if (this._heartbeat !== null) this._timers.clearInterval(this._heartbeat);
    this._heartbeat = null;
    this._unregisterAll();
    this._dropQueued('runtime_stopped');
    this._drained = this._drainInFlight();
    if (!(await this._settleWithin(this._drained, timeoutMs))) {
      this._logger.warn?.(`[Scheduler] Work is still in flight ${timeoutMs} ms after shutdown began; the runtime lease is kept until it finishes`);
      return { released: false, timedOut: true };
    }
    const { released } = await this._drained;
    return { released, timedOut: false };
  }

  // Settles once no job, heartbeat, or tracked operation is in flight, then
  // releases the lease. Never rejects.
  async _drainInFlight() {
    const keeper = this._keepLeaseWhileDraining();
    try {
      // Re-check after each wait: a pause may be tracked while shutdown waits.
      while (this._worker || this._beating || this._operations.size > 0) {
        await Promise.allSettled([this._worker, this._beating, ...this._operations].filter(Boolean));
      }
    } finally {
      if (keeper !== null) this._timers.clearInterval(keeper);
    }
    let released = false;
    if (this._leased) {
      try {
        released = this._lease.release(this._ownerId);
      } catch (error) {
        this._logger.error?.(`[Scheduler] Could not release the runtime lease: ${sanitizeRuntimeError(error)}`);
      }
    }
    this._leased = false;
    return { released };
  }

  // The regular heartbeat is stopped at shutdown (it would also re-acquire the
  // lease and register cron jobs); this one only renews the lease, so another
  // instance cannot start a run while this one is still sending.
  _keepLeaseWhileDraining() {
    if (!this._leased || (!this._worker && this._operations.size === 0)) return null;
    try {
      const handle = this._timers.setInterval(() => this._renewWhileDraining(), this._heartbeatMs);
      handle?.unref?.();
      return handle;
    } catch (error) {
      this._logger.error?.(`[Scheduler] Could not keep renewing the runtime lease during shutdown: ${sanitizeRuntimeError(error)}`);
      return null;
    }
  }

  _renewWhileDraining() {
    if (!this._leased) return;
    try {
      if (this._lease.renew(this._ownerId, this._leaseTtlMs) === null) {
        this._leased = false;
        this._logger.warn?.('[Scheduler] Runtime lease lost while waiting for work in flight; another instance holds it');
      }
    } catch (error) {
      this._logger.error?.(`[Scheduler] Could not renew the runtime lease during shutdown: ${sanitizeRuntimeError(error)}`);
    }
  }

  async _beat() {
    if (!this._accepting) return;
    if (this._beating) return this._beating;
    this._beating = this._beatOnce();
    try {
      return await this._beating;
    } finally {
      this._beating = null;
    }
  }

  async _beatOnce() {
    try {
      if (this._leased) {
        if (this._lease.renew(this._ownerId, this._leaseTtlMs) === null) {
          this._leaseLost('renewal found another owner');
          return;
        }
        this._enqueueMaintenanceIfDue();
        return;
      }
      const { acquired, lease } = this._lease.acquire(this._ownerId, this._leaseTtlMs);
      if (acquired) await this._leaseAcquired();
      else if (!this._everLeased) this._logger.log?.(`[Scheduler] Waiting for the runtime lease held by another instance until ${lease.expiresAt}`);
    } catch (error) {
      this._logger.error?.(`[Scheduler] Lease heartbeat failed: ${sanitizeRuntimeError(error)}`);
      if (this._leased) this._leaseLost('heartbeat error');
    }
  }

  async _leaseAcquired() {
    const first = !this._everLeased;
    this._leased = true;
    this._everLeased = true;
    this._logger.log?.(`[Scheduler] Runtime lease acquired by ${this._ownerId}`);
    try {
      await this._onLeaseAcquired({ first, inFlightRunIds: this._current?.runId ? [this._current.runId] : [] });
    } catch (error) {
      this._logger.error?.(`[Scheduler] Lease start-up hook failed: ${sanitizeRuntimeError(error)}`);
    }
    if (!this.active) return;
    try {
      for (const channel of this._listChannels()) {
        if (channel.enabled) this._register(channel);
      }
    } catch (error) {
      // Keep the lease: channels that did register run, and reloads retry the rest.
      this._logger.error?.(`[Scheduler] Could not list channels to schedule: ${sanitizeRuntimeError(error)}`);
    }
    this.enqueueMaintenance({ fullSync: true });
  }

  _enqueueMaintenanceIfDue() {
    try {
      if (this._maintenance?.isDue()) this.enqueueMaintenance();
    } catch (error) {
      this._logger.error?.(`[Scheduler] Maintenance check failed: ${sanitizeRuntimeError(error)}`);
    }
  }

  _leaseLost(why) {
    this._leased = false;
    this._unregisterAll();
    this._dropQueued('runtime_not_leased');
    this._logger.warn?.(`[Scheduler] Runtime lease lost (${why}); scheduling stopped until it is re-acquired`);
  }

  _register(channel) {
    this._unregister(channel.id);
    try {
      const task = this._cron.schedule(channel.cron, context => this._tick(channel.id, context), {
        timezone: channel.timezone,
        name: `channel:${channel.id}`,
      });
      this._tasks.set(channel.id, { task, cron: channel.cron, timezone: channel.timezone });
      this._logger.log?.(`[Scheduler] ${channel.id}: ${channel.cron} (${channel.timezone})`);
    } catch (error) {
      this._logger.error?.(`[Scheduler] ${channel.id}: could not schedule: ${sanitizeRuntimeError(error)}`);
    }
  }

  _unregister(channelId) {
    const entry = this._tasks.get(channelId);
    if (!entry) return;
    this._tasks.delete(channelId);
    try {
      entry.task.stop?.();
      entry.task.destroy?.();
    } catch (error) {
      this._logger.warn?.(`[Scheduler] ${channelId}: could not stop its cron job: ${sanitizeRuntimeError(error)}`);
    }
  }

  _unregisterAll() {
    for (const channelId of [...this._tasks.keys()]) this._unregister(channelId);
  }

  // node-cron passes the scheduled instant as `context.date`; the clock is the fallback.
  _tick(channelId, context) {
    try {
      const tickAt = context?.date instanceof Date && Number.isFinite(context.date.getTime()) ? context.date : this._clock();
      const channel = this._getChannel(channelId);
      if (!channel?.enabled) return;
      if (!shouldRun(channel.cron, tickAt, channel.timezone)) {
        this._logger.log?.(`[Scheduler] ${channelId}: tick at ${tickAt.toISOString()} is not due; skipped`);
        return;
      }
      const outcome = this.enqueueRun({
        channelId,
        runId: randomUUID(),
        triggerType: 'scheduled',
        requestedAt: tickAt,
        triggeredBy: null,
      });
      if (outcome.status === 'skipped') {
        this._logger.log?.(`[Scheduler] ${channelId}: scheduled tick skipped (${outcome.reason})`);
      }
    } catch (error) {
      this._logger.error?.(`[Scheduler] ${channelId}: tick failed: ${sanitizeRuntimeError(error)}`);
    }
  }

  _enqueue(job) {
    let resolve;
    const done = new Promise(settle => { resolve = settle; });
    this._queue.push({ ...job, resolve });
    if (!this._worker) this._worker = this._work();
    return done;
  }

  async _work() {
    // Yield once so `_worker` is assigned before the loop can finish.
    await null;
    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift();
        this._current = job;
        try {
          job.resolve(await this._runJob(job));
        } catch (error) {
          const message = sanitizeRuntimeError(error);
          this._logger.error?.(`[Scheduler] ${job.label} failed: ${message}`);
          job.resolve({ status: 'error', error: message });
        } finally {
          this._current = null;
        }
      }
    } finally {
      // Cleared in the same turn the loop ends, so a job queued afterwards starts a new worker.
      this._worker = null;
    }
  }

  async _runJob(job) {
    if (!this.active) return { status: 'skipped', reason: this._accepting ? 'runtime_not_leased' : 'runtime_stopped' };
    // Re-confirm ownership right before mutating anything; this also extends the lease for the job.
    if (this._lease.renew(this._ownerId, this._leaseTtlMs) === null) {
      this._leaseLost('renewal before a job found another owner');
      return { status: 'skipped', reason: 'runtime_not_leased' };
    }
    return job.execute();
  }

  _dropQueued(reason) {
    const dropped = this._queue.splice(0);
    for (const job of dropped) job.resolve({ status: 'skipped', reason });
  }

  async _settleWithin(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = this._timers.setTimeout(() => resolve(false), timeoutMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([promise.then(() => true), timeout]);
    } finally {
      if (timer !== null) this._timers.clearTimeout(timer);
    }
  }
}

// Bind each timer function to its owner so injected timer objects (including
// class instances, whose methods live on the prototype) keep their `this`.
function resolveTimers(timers) {
  const source = timers ?? {};
  return Object.fromEntries(Object.entries(DEFAULT_TIMERS).map(([name, fallback]) => [
    name,
    typeof source[name] === 'function' ? source[name].bind(source) : fallback,
  ]));
}
