import { SQLiteDeliveryStore } from '../../core/sqlite-delivery-store.js';
import {
  DEFAULT_BACKUP_RETENTION,
  assertBackupRetention,
  createDatabaseBackup,
  databaseHasUserData,
} from './database-backup.js';
import { createNodeSqlStorage } from './node-sql-storage.js';
import { closeDatabase, openMemoryDatabase, resolveDataDir } from './open-database.js';

const APP_LEDGER_TABLE = 'app_schema_migrations';
const DELIVERY_LEDGER_TABLE = 'news_schema_migrations';
const MIGRATION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CREATE_APP_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS app_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

// Migrations are append-only: never edit an applied entry, add a new version.
// Plain CREATE statements make an unexpected pre-existing object fail loudly;
// the ledger is what keeps re-runs idempotent.
export const APP_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'create-app-tables',
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE app_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        platform TEXT NOT NULL DEFAULT 'telegram',
        mode TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        config_json TEXT NOT NULL,
        not_before TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE app_credentials (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE app_runs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        stats_json TEXT,
        ai_input_tokens INTEGER,
        ai_output_tokens INTEGER,
        outputs_total INTEGER,
        outputs_succeeded INTEGER,
        outputs_failed INTEGER,
        error_text TEXT
      );
      CREATE INDEX app_runs_channel_started
        ON app_runs(channel_id, started_at);

      CREATE TABLE app_source_health (
        run_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT,
        status TEXT NOT NULL,
        article_count INTEGER NOT NULL DEFAULT 0,
        error_class TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, source_id)
      );
      CREATE INDEX app_source_health_channel_observed
        ON app_source_health(channel_id, observed_at);
      CREATE INDEX app_source_health_source_observed
        ON app_source_health(source_id, observed_at);

      CREATE TABLE app_content_items (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        article_key TEXT NOT NULL,
        title TEXT,
        url TEXT,
        source_id TEXT,
        source_name TEXT,
        category TEXT,
        published_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        reject_reason TEXT,
        delivery_id TEXT,
        summary_text TEXT,
        message_id TEXT,
        delivered_at TEXT,
        run_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (channel_id, article_key)
      );
      CREATE INDEX app_content_items_channel_status_seen
        ON app_content_items(channel_id, status, last_seen_at);
      CREATE INDEX app_content_items_channel_delivered
        ON app_content_items(channel_id, delivered_at);
      CREATE INDEX app_content_items_published
        ON app_content_items(published_at);
      CREATE INDEX app_content_items_source
        ON app_content_items(source_id);

      CREATE TABLE app_runtime_lease (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  }),
  // `cutover_required` is system-managed (never taken from API input): such a
  // channel may not start delivering until `not_before` is set. The seed sets
  // it for `telegram-main`, which took over from the retired Cloudflare Worker; a
  // `telegram-main` row written before this column existed gets it too while
  // its cutoff is still unset.
  Object.freeze({
    version: 2,
    name: 'add-channel-cutover-guard',
    sql: `
      ALTER TABLE app_channels ADD COLUMN cutover_required INTEGER NOT NULL DEFAULT 0;
      UPDATE app_channels SET cutover_required = 1 WHERE id = 'telegram-main' AND not_before IS NULL;
    `,
  }),
]);

/**
 * @typedef {object} AppMigrationResult
 * @property {number} fromVersion App schema version before this call.
 * @property {number} toVersion App schema version after this call.
 * @property {{ version: number, name: string }[]} applied
 * @property {string | null} backupPath Backup taken before applying, if any.
 */

/**
 * Apply pending app schema migrations in order inside one transaction and
 * record each in `app_schema_migrations`. When anything is pending and the
 * database already holds data, a `VACUUM INTO` backup named
 * `content-radar-<UTC timestamp>-v<from>.db` is written first; a backup failure
 * aborts the migration. Refuses databases migrated by a newer build.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dataDir: string,
 *   migrations?: readonly { version: number, name: string, sql: string }[],
 *   keepBackups?: number,
 *   now?: Date,
 * }} options
 * @returns {AppMigrationResult}
 */
export function runAppMigrations({
  db,
  dataDir,
  migrations = APP_MIGRATIONS,
  keepBackups = DEFAULT_BACKUP_RETENTION,
  now = new Date(),
} = {}) {
  const storage = createNodeSqlStorage(db);
  resolveDataDir(dataDir);
  assertBackupRetention(keepBackups);
  assertValidDate(now);
  validateMigrations(migrations);

  const { fromVersion, pending } = planMigrations(storage.sql, migrations);
  if (pending.length === 0) return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };

  const backupPath = databaseHasUserData(db)
    ? createDatabaseBackup({ db, dataDir, label: `v${fromVersion}`, now, keep: keepBackups })
    : null;
  const appliedAt = now.toISOString();
  const applied = storage.transactionSync(() => {
    storage.sql.exec(CREATE_APP_LEDGER_SQL);
    // Another process may have migrated between planning and taking the write lock.
    const { pending: stillPending } = planMigrations(storage.sql, migrations);
    for (const migration of stillPending) {
      storage.sql.exec(migration.sql);
      storage.sql.exec(
        `INSERT INTO ${APP_LEDGER_TABLE}(version, name, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.name,
        appliedAt,
      );
    }
    return stillPending.map(({ version, name }) => ({ version, name }));
  });
  return { fromVersion, toVersion: migrations.length, applied, backupPath };
}

/**
 * Call before `SQLiteDeliveryStore.initialize()`. The store upgrades its own
 * schema during initialization, so when its migration ledger
 * (`news_schema_migrations`) lacks any migration the current store records and
 * the database already holds data, this writes a
 * `content-radar-<UTC timestamp>-delivery-v<from>.db` backup first.
 *
 * The store does not export its schema version, so the target ledger is read
 * from the unchanged store initialized against a throwaway in-memory database.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, dataDir: string, keepBackups?: number, now?: Date }} options
 * @returns {Promise<{ fromVersion: number, toVersion: number, upgradePending: boolean, backupPath: string | null }>}
 */
export async function backupBeforeDeliveryStoreUpgrade({
  db,
  dataDir,
  keepBackups = DEFAULT_BACKUP_RETENTION,
  now = new Date(),
} = {}) {
  const { sql } = createNodeSqlStorage(db);
  resolveDataDir(dataDir);
  assertBackupRetention(keepBackups);
  assertValidDate(now);

  const targetVersions = await readDeliveryStoreTargetVersions();
  const appliedVersions = readLedgerVersions(sql, DELIVERY_LEDGER_TABLE);
  const fromVersion = Math.max(0, ...appliedVersions);
  const toVersion = Math.max(...targetVersions);
  const upgradePending = [...targetVersions].some(version => !appliedVersions.has(version));
  const backupPath = upgradePending && databaseHasUserData(db)
    ? createDatabaseBackup({ db, dataDir, label: `delivery-v${fromVersion}`, now, keep: keepBackups })
    : null;
  return { fromVersion, toVersion, upgradePending, backupPath };
}

async function readDeliveryStoreTargetVersions() {
  const probe = openMemoryDatabase();
  try {
    const storage = createNodeSqlStorage(probe);
    await new SQLiteDeliveryStore(storage).initialize();
    const versions = readLedgerVersions(storage.sql, DELIVERY_LEDGER_TABLE);
    if (versions.size === 0) throw new Error('SQLiteDeliveryStore recorded no schema migrations');
    return versions;
  } finally {
    closeDatabase(probe);
  }
}

function planMigrations(sql, migrations) {
  const applied = readLedgerVersions(sql, APP_LEDGER_TABLE);
  for (const version of applied) {
    if (!Number.isSafeInteger(version) || version < 1 || version > migrations.length) {
      throw new Error(
        `Database has app schema migration v${version}, which this build does not know (latest v${migrations.length})`,
      );
    }
  }
  return {
    fromVersion: Math.max(0, ...applied),
    pending: migrations.filter(migration => !applied.has(migration.version)),
  };
}

function readLedgerVersions(sql, table) {
  const exists = sql.exec(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  ).toArray().length > 0;
  if (!exists) return new Set();
  return new Set(sql.exec(`SELECT version FROM ${table}`).toArray().map(row => row.version));
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new TypeError('App migrations must be a non-empty array');
  }
  const names = new Set();
  migrations.forEach((migration, index) => {
    if (migration?.version !== index + 1) {
      throw new TypeError('App migrations must be numbered consecutively from 1');
    }
    if (typeof migration.name !== 'string' || !MIGRATION_NAME_PATTERN.test(migration.name) || names.has(migration.name)) {
      throw new TypeError(`App migration v${migration.version} needs a unique kebab-case name`);
    }
    if (typeof migration.sql !== 'string' || migration.sql.trim() === '') {
      throw new TypeError(`App migration v${migration.version} has no SQL`);
    }
    names.add(migration.name);
  });
}

function assertValidDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Migration time must be a valid Date');
  }
}
