/**
 * Cache implementations
 */

import { CachePlugin } from './contracts.js';
import { isUnsupportedDirectorySyncError } from './delivery-store.js';

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

// ============================================
// In-Memory (works everywhere, no persistence)
// ============================================

export class MemoryCache extends CachePlugin {
  constructor({ now = () => Date.now() } = {}) { super(); this._store = new Map(); this._now = now; }

  get capabilities() { return { persistent: false, nonMutatingRead: true, deliveryStore: false }; }

  async peek(key) {
    const entry = this._store.get(key);
    if (!entry || (entry.exp && this._now() > entry.exp)) return null;
    return entry.v;
  }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (entry.exp && this._now() > entry.exp) { this._store.delete(key); return null; }
    return entry.v;
  }

  async set(key, value, ttl = DEFAULT_TTL) {
    this._store.set(key, { v: value, exp: ttl ? this._now() + ttl : null });
  }

  async delete(key) { this._store.delete(key); }
}

// ============================================
// File-based (Node.js / Bun)
// ============================================

export class FileCache extends CachePlugin {
  constructor(path = './.cache/news.json', { now = () => Date.now(), fs = null } = {}) {
    super();
    this._path = path;
    this._data = null;
    this._now = now;
    this._fs = fs;
    this._tail = Promise.resolve();
    this._durabilityFailure = null;
  }

  get capabilities() { return { persistent: true, nonMutatingRead: true, deliveryStore: false }; }

  async _load() {
    if (this._durabilityFailure) throw this._durabilityFailure;
    if (this._data) return this._data;
    const fs = await this._getFs();
    this._data = await readFileCacheState(fs, this._path);
    return this._data;
  }

  async _save(candidate) {
    const fs = await this._getFs();
    const { basename, dirname, join } = await import('node:path');
    const directory = dirname(this._path);
    const temporary = join(directory, `.${basename(this._path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    let renamed = false;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(candidate, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this._path);
      renamed = true;
      try {
        const dirHandle = await fs.open(directory, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch (error) {
        if (!isUnsupportedDirectorySyncError(error)) throw error;
      }
    } catch (error) {
      try { if (handle) await handle.close(); } catch {}
      try { await fs.unlink(temporary); } catch {}
      try {
        this._data = await readFileCacheState(fs, this._path, { allowMissing: !renamed });
      } catch (recoveryError) {
        this._data = null;
        this._durabilityFailure = new Error(
          'FileCache durable recovery failed; the instance is quarantined and must be replaced',
          { cause: recoveryError },
        );
        throw this._durabilityFailure;
      }
      throw error;
    }
  }

  async _getFs() {
    return this._fs ?? await import('node:fs/promises');
  }

  async peek(key) {
    await this._tail;
    const d = await this._load();
    const e = d[key];
    if (!e || (e.exp && this._now() > e.exp)) return null;
    return e.v;
  }

  async get(key) {
    return this._enqueue(async () => {
      const d = await this._load();
      const e = d[key];
      if (!e) return null;
      if (e.exp && this._now() > e.exp) {
        const candidate = structuredClone(d);
        delete candidate[key];
        await this._save(candidate);
        this._data = candidate;
        return null;
      }
      return e.v;
    });
  }

  async set(key, value, ttl = DEFAULT_TTL) {
    return this._enqueue(async () => {
      const d = await this._load();
      const candidate = structuredClone(d);
      candidate[key] = { v: value, exp: ttl ? this._now() + ttl : null };
      await this._save(candidate);
      this._data = candidate;
    });
  }

  async delete(key) {
    return this._enqueue(async () => {
      const d = await this._load();
      const candidate = structuredClone(d);
      delete candidate[key];
      await this._save(candidate);
      this._data = candidate;
    });
  }

  _enqueue(operation) {
    const current = this._tail.then(operation);
    this._tail = current.catch(() => {});
    return current;
  }
}

async function readFileCacheState(fs, path, { allowMissing = true } = {}) {
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return {};
    throw new Error(`FileCache state is corrupt or unreadable: ${error.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('cache root must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`FileCache state is corrupt or unreadable: ${error.message}`);
  }
}

// ============================================
// Redis
// ============================================

export class RedisCache extends CachePlugin {
  constructor(url = 'redis://localhost:6379', { client = null } = {}) {
    super();
    this._url = url;
    this._client = client;
  }

  get capabilities() {
    return { persistent: Boolean(this._client?.isOpen), nonMutatingRead: true, deliveryStore: false };
  }

  async _connect() {
    if (this._client) return this._client;
    const { createClient } = await import('redis');
    this._client = createClient({ url: this._url });
    await this._client.connect();
    return this._client;
  }

  async get(key) { return (await this._connect()).get(key); }
  async peek(key) { return this.get(key); }
  async set(key, value, ttl = DEFAULT_TTL) {
    return await (await this._connect()).set(key, typeof value === 'string' ? value : JSON.stringify(value), {
      EX: Math.floor(ttl / 1000),
    });
  }
  async delete(key) { return await (await this._connect()).del(key); }
  async disconnect() { if (this._client) await this._client.quit(); }
}
