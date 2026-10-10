import test from 'node:test';
import assert from 'node:assert/strict';

import { runAppMigrations } from '../../src/app/db/app-migrations.js';
import { createNodeSqlStorage } from '../../src/app/db/node-sql-storage.js';
import { RuntimeLease } from '../../src/app/db/runtime-lease.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, RuntimeScheduler } from '../../src/app/runtime/scheduler.js';
import { ContentRadar } from '../../src/core/engine.js';
import { FakeCron, FakeTimers, mutableClock } from './helpers/runtime-fixture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const TTL_MS = 60_000;

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function channel(id, overrides = {}) {
  return { id, enabled: true, cron: '0 * * * *', timezone: 'Asia/Singapore', ...overrides };
}

async function leaseStorage(t) {
  const workspace = await createTempDataDir(t);
  const db = workspace.open();
  runAppMigrations({ db, dataDir: workspace.dataDir });
  return createNodeSqlStorage(db);
}

function createScheduler({ storage, clock, ownerId = 'owner-a', channels = [], maintenance = null, onLeaseAcquired } = {}) {
  const registry = new Map(channels.map(entry => [entry.id, entry]));
  const runs = [];
  const logs = [];
  const cron = new FakeCron();
  const timers = new FakeTimers();
  const executeRun = request => {
    const gate = deferred();
    runs.push({ request, gate });
    return gate.promise;
  };
  const scheduler = new RuntimeScheduler({
    lease: new RuntimeLease({ storage, clock }),
    ownerId,
    cron,
    timers,
    clock,
    getChannel: id => registry.get(id) ?? null,
    listChannels: () => [...registry.values()],
    executeRun,
    maintenance,
    onLeaseAcquired,
    logger: { log: message => logs.push(String(message)), warn: message => logs.push(String(message)), error: message => logs.push(String(message)) },
    leaseTtlMs: TTL_MS,
    heartbeatMs: 15_000,
    shutdownTimeoutMs: 5_000,
  });
  return { scheduler, registry, runs, logs, cron, timers };
}

test('cron jobs are registered for enabled channels only, each in its own timezone', async t => {
  const storage = await leaseStorage(t);
  const env = createScheduler({
    storage,
    clock: mutableClock(),
    channels: [channel('sg'), channel('utc', { cron: '30 6 * * 1', timezone: 'UTC' }), channel('off', { enabled: false })],
  });

  assert.deepEqual(await env.scheduler.start(), { leased: true });

  assert.deepEqual(env.cron.tasks.map(task => [task.expression, task.options.timezone, task.options.name]), [
    ['0 * * * *', 'Asia/Singapore', 'channel:sg'],
    ['30 6 * * 1', 'UTC', 'channel:utc'],
  ]);
  assert.deepEqual(env.scheduler.describe().scheduledChannels, ['sg', 'utc']);
  await env.scheduler.stop();
});

test('reloadChannel re-registers a changed schedule and removes disabled or deleted channels without a restart', async t => {
  const storage = await leaseStorage(t);
  const env = createScheduler({ storage, clock: mutableClock(), channels: [channel('ops'), channel('news')] });
  await env.scheduler.start();
  const [opsTask, newsTask] = env.cron.tasks;

  env.registry.set('ops', channel('ops', { cron: '15 9 * * *', timezone: 'Asia/Ho_Chi_Minh' }));
  env.scheduler.reloadChannel('ops');
  env.registry.set('news', channel('news', { enabled: false }));
  env.scheduler.reloadChannel('news');
  env.registry.set('fresh', channel('fresh'));
  env.scheduler.reloadChannel('fresh');
  env.registry.delete('fresh');
  env.scheduler.reloadChannel('fresh');

  assert.equal(opsTask.stopped && opsTask.destroyed, true);
  assert.equal(newsTask.stopped, true);
  const active = env.cron.active();
  assert.deepEqual([...active.keys()], ['ops']);
  assert.deepEqual([active.get('ops').expression, active.get('ops').options.timezone], ['15 9 * * *', 'Asia/Ho_Chi_Minh']);
  await env.scheduler.stop();
});

test('one global queue runs jobs one at a time, in order', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('first'), channel('second')] });
  await env.scheduler.start();

  env.cron.fire('first');
  env.cron.fire('second');
  await flush();
  assert.deepEqual(env.runs.map(run => run.request.channelId), ['first']);
  assert.deepEqual(env.scheduler.describe().queued.map(job => job.channelId), ['second']);

  env.runs[0].gate.resolve({ status: 'success' });
  await flush();
  assert.deepEqual(env.runs.map(run => run.request.channelId), ['first', 'second']);
  env.runs[1].gate.resolve({ status: 'success' });
  await flush();
  assert.equal(env.scheduler.describe().running, null);
  await env.scheduler.stop();
});

test('a tick for a channel that is already running or queued is skipped and logged', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('busy')] });
  await env.scheduler.start();

  env.cron.fire('busy');
  await flush();
  env.cron.fire('busy');
  const manual = env.scheduler.enqueueRun({ channelId: 'busy', runId: 'manual-1', triggerType: 'manual', requestedAt: clock() });
  await flush();

  assert.equal(env.runs.length, 1);
  assert.deepEqual(manual, { status: 'skipped', reason: 'channel_busy' });
  assert.ok(env.logs.some(line => /busy: scheduled tick skipped \(channel_busy\)/.test(line)));
  env.runs[0].gate.resolve({ status: 'success' });
  await flush();
  await env.scheduler.stop();
});

test('ticks are checked against the channel schedule at the tick instant', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:07:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('hourly')] });
  await env.scheduler.start();

  env.cron.fire('hourly');
  await flush();
  assert.equal(env.runs.length, 0, 'a tick at :07 does not match "0 * * * *"');
  assert.ok(env.logs.some(line => /hourly: tick at .* is not due/.test(line)));

  env.cron.fire('hourly', '2026-10-03T10:00:00.000Z');
  await flush();
  assert.equal(env.runs.length, 1);
  assert.deepEqual(env.runs[0].request.requestedAt, new Date('2026-10-03T10:00:00.000Z'));
  assert.equal(env.runs[0].request.triggerType, 'scheduled');
  env.runs[0].gate.resolve({ status: 'success' });
  await flush();
  await env.scheduler.stop();
});

test('only the lease holder schedules; another instance takes over once the lease is released', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const a = createScheduler({ storage, clock, ownerId: 'owner-a', channels: [channel('ops')] });
  const b = createScheduler({ storage, clock, ownerId: 'owner-b', channels: [channel('ops')] });

  assert.deepEqual(await a.scheduler.start(), { leased: true });
  assert.deepEqual(await b.scheduler.start(), { leased: false });
  assert.equal(b.cron.tasks.length, 0);
  assert.deepEqual(
    b.scheduler.enqueueRun({ channelId: 'ops', runId: 'r', triggerType: 'manual', requestedAt: clock() }),
    { status: 'skipped', reason: 'runtime_not_leased' },
  );
  assert.ok(b.logs.some(line => /Waiting for the runtime lease/.test(line)));

  assert.deepEqual(await a.scheduler.stop(), { released: true, timedOut: false });
  await b.timers.runIntervals();

  assert.equal(b.scheduler.active, true);
  assert.deepEqual([...b.cron.active().keys()], ['ops']);
  await b.scheduler.stop();
});

test('a lost lease stops scheduling and drops queued work until it is re-acquired', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const a = createScheduler({ storage, clock, ownerId: 'owner-a', channels: [channel('first'), channel('second')] });
  await a.scheduler.start();
  a.cron.fire('first');
  a.cron.fire('second');
  await flush();

  // owner-a stalls past its TTL and owner-b takes the expired lease.
  clock.advance(TTL_MS + 1);
  const b = createScheduler({ storage, clock, ownerId: 'owner-b' });
  assert.deepEqual(await b.scheduler.start(), { leased: true });

  a.runs[0].gate.resolve({ status: 'success' });
  await flush();
  assert.equal(a.runs.length, 1, 'the queued job re-checks the lease and does not run');
  assert.equal(a.scheduler.active, false);
  assert.equal(a.cron.active().size, 0);
  assert.ok(a.logs.some(line => /Runtime lease lost/.test(line)));

  await b.scheduler.stop();
  await a.timers.runIntervals();
  assert.equal(a.scheduler.active, true, 'the heartbeat re-acquires a released lease');
  await a.scheduler.stop();
});

test('shutdown waits for the run in flight, drops queued runs, and then releases the lease', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('first'), channel('second')] });
  await env.scheduler.start();
  env.cron.fire('first');
  const queued = env.scheduler.enqueueRun({ channelId: 'second', runId: 'second-run', triggerType: 'manual', requestedAt: clock() });
  await flush();

  const stopping = env.scheduler.stop();
  await flush();
  assert.deepEqual(await queued.done, { status: 'skipped', reason: 'runtime_stopped' });
  assert.equal(env.cron.active().size, 0);
  assert.equal(new RuntimeLease({ storage, clock }).current().ownerId, 'owner-a', 'the lease is held while the run is in flight');

  env.runs[0].gate.resolve({ status: 'success' });
  assert.deepEqual(await stopping, { released: true, timedOut: false });
  assert.equal(new RuntimeLease({ storage, clock }).current(), null);
  assert.equal(env.runs.length, 1);
  assert.deepEqual(
    env.scheduler.enqueueRun({ channelId: 'first', runId: 'late', triggerType: 'manual', requestedAt: clock() }),
    { status: 'skipped', reason: 'runtime_stopped' },
  );
  await assert.rejects(env.scheduler.start(), /stopped/);
});

test('a run that outlives the shutdown wait keeps the lease renewed and releases it once it finishes', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('slow')] });
  await env.scheduler.start();
  env.cron.fire('slow');
  await flush();

  const stopping = env.scheduler.stop();
  await flush();
  env.timers.fireTimeouts();
  assert.deepEqual(await stopping, { released: false, timedOut: true });
  assert.ok(env.logs.some(line => /still in flight .*lease is kept until it finishes/.test(line)));

  // Past the TTL the run had at shutdown, the lease is still this instance's.
  const lease = new RuntimeLease({ storage, clock });
  clock.advance(TTL_MS - 1_000);
  await env.timers.runIntervals();
  clock.advance(TTL_MS - 1_000);
  assert.equal(lease.current().ownerId, 'owner-a');
  assert.equal(new RuntimeLease({ storage, clock }).acquire('owner-b', TTL_MS).acquired, false, 'no other instance can start a run mid-send');
  assert.equal(env.cron.active().size, 0, 'renewing the lease does not schedule anything again');

  let drained = null;
  const draining = env.scheduler.drain().then(result => { drained = result; });
  await flush();
  assert.equal(drained, null, 'drain waits for the run in flight');
  env.runs[0].gate.resolve({ status: 'success' });
  await draining;
  assert.deepEqual(drained, { released: true });
  assert.equal(lease.current(), null, 'the lease is released once the run finishes');
  assert.equal(env.timers.intervals.size, 0, 'no timer is left behind');
  assert.equal(env.runs.length, 1);
});

test('a lease taken over during shutdown is not released by the stopping instance', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('slow')] });
  await env.scheduler.start();
  env.cron.fire('slow');
  await flush();
  const stopping = env.scheduler.stop();
  await flush();
  env.timers.fireTimeouts();
  await stopping;

  // The keeper did not run in time (a stalled process): the lease expired and owner-b took it.
  clock.advance(TTL_MS + 1);
  assert.equal(new RuntimeLease({ storage, clock }).acquire('owner-b', TTL_MS).acquired, true);
  await env.timers.runIntervals();
  assert.ok(env.logs.some(line => /lease lost while waiting/.test(line)));

  env.runs[0].gate.resolve({ status: 'success' });
  assert.deepEqual(await env.scheduler.drain(), { released: false });
  assert.equal(new RuntimeLease({ storage, clock }).current().ownerId, 'owner-b');
});

test('shutdown also waits for operator operations tracked while it waits', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const env = createScheduler({ storage, clock, channels: [channel('first')] });
  await env.scheduler.start();
  env.cron.fire('first');
  await flush();

  let stopped = false;
  const stopping = env.scheduler.stop().then(result => { stopped = true; return result; });
  const pause = deferred();
  env.scheduler.track(pause.promise);
  env.runs[0].gate.resolve({ status: 'success' });
  await flush();
  await flush();
  assert.equal(stopped, false, 'a pause tracked during shutdown is still in flight');
  pause.resolve();
  assert.deepEqual(await stopping, { released: true, timedOut: false });

  // A pause tracked after the wait (while the HTTP server closes) is covered by drain().
  const late = deferred();
  env.scheduler.track(late.promise);
  let drained = false;
  const draining = env.scheduler.drain().then(() => { drained = true; });
  await flush();
  assert.equal(drained, false);
  late.resolve();
  await draining;
  assert.equal(drained, true);
});

test('lease acquisition runs the start-up hook once and queues maintenance; the heartbeat queues it when due', async t => {
  const storage = await leaseStorage(t);
  const clock = mutableClock('2026-10-03T09:00:00.000Z');
  const maintenanceRuns = [];
  let due = false;
  const hooks = [];
  const env = createScheduler({
    storage,
    clock,
    maintenance: {
      isDue: () => due,
      execute: async options => { maintenanceRuns.push(options); },
    },
    onLeaseAcquired: context => hooks.push(context),
  });

  await env.scheduler.start();
  await flush();
  assert.deepEqual(hooks, [{ first: true, inFlightRunIds: [] }]);
  assert.deepEqual(maintenanceRuns, [{ fullSync: true }]);

  await env.timers.runIntervals();
  await flush();
  assert.equal(maintenanceRuns.length, 1, 'not due yet');
  due = true;
  await env.timers.runIntervals();
  await flush();
  assert.deepEqual(maintenanceRuns, [{ fullSync: true }, { fullSync: false }]);
  await env.scheduler.stop();
});

test('scheduler options are validated', async t => {
  const storage = await leaseStorage(t);
  const base = {
    lease: new RuntimeLease({ storage }),
    ownerId: 'owner',
    cron: new FakeCron(),
    getChannel: () => null,
    listChannels: () => [],
    executeRun: async () => {},
  };
  assert.throws(() => new RuntimeScheduler({ ...base, lease: {} }), TypeError);
  assert.throws(() => new RuntimeScheduler({ ...base, cron: {} }), TypeError);
  assert.throws(() => new RuntimeScheduler({ ...base, executeRun: null }), TypeError);
  assert.throws(() => new RuntimeScheduler({ ...base, leaseTtlMs: 10_000, heartbeatMs: 10_000 }), TypeError);
});

test('the default shutdown wait covers one drip item and still leaves room for a source scan', () => {
  const { generationTimeoutMs, outputTimeoutMs } = new ContentRadar().options;
  const sourceScanRoomMs = 30_000;

  assert.ok(
    generationTimeoutMs + outputTimeoutMs + sourceScanRoomMs <= DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'a deploy would otherwise stop the process in the middle of a send',
  );
});
