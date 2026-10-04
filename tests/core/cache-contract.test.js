import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsPromises from 'node:fs/promises';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileCache, MemoryCache, RedisCache } from '../../src/core/caches.js';
import { PrefixedCache } from '../../src/core/prefixed-cache.js';

function createBoundaryFailingFs(targetPath) {
  let failurePoint = null;
  const fail = message => Object.assign(new Error(message), { code: 'EIO' });
  return {
    fs: {
      ...fsPromises,
      async rename(from, to) {
        if (failurePoint === 'before-rename' && to === targetPath) {
          failurePoint = null;
          throw fail('injected failure before rename');
        }
        return fsPromises.rename(from, to);
      },
      async open(path, flags, mode) {
        const handle = await fsPromises.open(path, flags, mode);
        if (flags !== 'r' || !['after-rename', 'after-rename-reload'].includes(failurePoint)) {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                failurePoint = failurePoint === 'after-rename-reload' ? 'recovery-read' : null;
                throw fail('injected failure after rename');
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      async readFile(path, ...args) {
        if (failurePoint === 'recovery-read' && path === targetPath) {
          failurePoint = null;
          throw fail('injected recovery read failure');
        }
        return fsPromises.readFile(path, ...args);
      },
    },
    failOnceAt(point) {
      failurePoint = point;
    },
  };
}

test('peek observes expiry without mutating memory cache', async () => {
  let now = 1_000;
  const cache = new MemoryCache({ now: () => now });
  await cache.set('key', 'value', 10);
  now = 2_000;
  assert.equal(await cache.peek('key'), null);
  assert.equal(cache._store.has('key'), true);
  assert.equal(await cache.get('key'), null);
  assert.equal(cache._store.has('key'), false);
});

test('file cache peek is byte-identical and corrupt files fail closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cache.json');
  let now = 1_000;
  const cache = new FileCache(path, { now: () => now });
  await cache.set('key', 'value', 10);
  now = 2_000;
  const before = await readFile(path, 'utf8');
  assert.equal(await cache.peek('key'), null);
  assert.equal(await readFile(path, 'utf8'), before);

  await writeFile(path, '{bad', { mode: 0o600 });
  const corrupt = new FileCache(path);
  await assert.rejects(corrupt.peek('key'), /corrupt|invalid/i);
  assert.equal(await readFile(path, 'utf8'), '{bad');
});

test('file cache pure read does not create a missing cache directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-cache-readonly-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'missing');
  const cache = new FileCache(join(nested, 'cache.json'));

  assert.equal(await cache.peek('key'), null);
  await assert.rejects(access(nested), error => error.code === 'ENOENT');

  await cache.set('key', 'value');
  await access(nested);
});

test('file cache reloads disk after failures before and after rename without losing committed keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-cache-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cache.json');
  const injected = createBoundaryFailingFs(path);
  const cache = new FileCache(path, { fs: injected.fs });
  await cache.set('base', 'base', 0);

  injected.failOnceAt('before-rename');
  await assert.rejects(cache.set('not-committed', 'bad', 0), /before rename/i);
  assert.equal(await cache.peek('not-committed'), null);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  await cache.set('after-pre-failure', 'safe', 0);

  injected.failOnceAt('after-rename');
  await assert.rejects(cache.set('committed', 'committed', 0), /after rename/i);
  assert.equal(await cache.peek('committed'), 'committed');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  await cache.set('after-post-failure', 'safe', 0);

  const durable = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(durable.base.v, 'base');
  assert.equal(durable['after-pre-failure'].v, 'safe');
  assert.equal(durable.committed.v, 'committed');
  assert.equal(durable['after-post-failure'].v, 'safe');
  assert.equal(durable['not-committed'], undefined);
});

test('file cache quarantines itself when a failed save cannot reload the durable snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'news-cache-quarantine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cache.json');
  const injected = createBoundaryFailingFs(path);
  const cache = new FileCache(path, { fs: injected.fs });

  injected.failOnceAt('after-rename-reload');
  const failedSave = cache.set('committed', 'committed', 0);
  const queuedSave = cache.set('overwrite', 'unsafe', 0);
  await assert.rejects(failedSave, /quarantined/i);
  await assert.rejects(queuedSave, /quarantined/i);
  await assert.rejects(cache.peek('committed'), /quarantined/i);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).committed.v, 'committed');

  const reopened = new FileCache(path);
  assert.equal(await reopened.peek('committed'), 'committed');
});

test('prefixed cache forwards pure reads and capabilities', async () => {
  const inner = new MemoryCache();
  const cache = new PrefixedCache(inner, 'channel:a');
  await cache.set('one', '1');
  assert.equal(await cache.peek('one'), '1');
  assert.deepEqual(cache.capabilities, inner.capabilities);
});

test('Redis cache awaits set and delete client operations', async () => {
  const events = [];
  const client = {
    isOpen: true,
    async get() { return null; },
    async set() { await Promise.resolve(); events.push('set'); return 'OK'; },
    async del() { await Promise.resolve(); events.push('delete'); return 1; },
    async quit() {},
  };
  const cache = new RedisCache('redis://unused', { client });
  assert.equal(await cache.set('key', 'value'), 'OK');
  assert.equal(await cache.delete('key'), 1);
  assert.deepEqual(events, ['set', 'delete']);
  assert.equal(cache.capabilities.deliveryStore, false);
});
