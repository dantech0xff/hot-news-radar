# System Architecture

## Overview

Content Radar is a composable delivery engine that scans technology content and posts it to social channels. Sources, AI providers, outputs, and caches are plugins. Delivery correctness depends on a durable state machine and a durable store, not on best-effort cache writes.

Two runtimes share the engine:

| Runtime | Entry point | Channel configuration | Delivery store | Role |
|---|---|---|---|---|
| Dashboard app | `src/app/server.js` | SQLite (`app_channels`), edited in the dashboard | `SQLiteDeliveryStore` on `node:sqlite`, one file in `DATA_DIR` | Production engine on Dokploy since the 2026-10-03 cutover |
| Node CLI | `src/adapters/node.js` | `defineChannels()` from the environment | `LocalFileDeliveryStore` | Manual runs, cron daemon, preview, local recovery |

The previous production runtime, the Cloudflare Worker `news-engine`, was retired and deleted on 2026-10-04 (`docs/deployment.md`).

## Topology

```text
Dashboard app ─┐
Node CLI ──────┴─> runChannels() / buildEngine()  (src/channels/runner.js)
                     │
                     ▼
               ContentRadar -> DeliveryStateMachine -> delivery store -> output plugins
```

Deployment of the dashboard app (live since 2026-10-03; see `docs/deployment.md`):

```text
Browser ──HTTPS──> Cloudflare Access ──> Dokploy's Traefik (VPS, 443) ──> Dokploy application (1 container)
                                                                         src/app/server.js
                                                                         ├─ /api/*   Access JWT → role → routes
                                                                         ├─ /*       web/dist (React UI), JWT required
                                                                         ├─ /healthz liveness, no data
                                                                         ├─ scheduler (lease) → channel runs
                                                                         └─ /data volume: content-radar.db, backups/, news.json
```

Traefik also answers requests sent straight to the VPS address, so the app's own Access JWT check on every route except `/healthz` is what stops a request that skips Cloudflare. The server raises Node's per-address connection attempt timeout to 2.5 s at startup: with the 250 ms default, connections to hosts more than about 250 ms away (api.telegram.org from the VPS) were cut short and failed.

## Core Pipeline

1. Fetch all sources in bounded batches.
2. Collect source diagnostics and classify failures separately from empty feeds.
3. Deduplicate against delivery state and legacy compatibility data.
4. For radar scans (drip mode only), exclude articles covering a story already delivered to the channel in the current publishing day or the two before it: the radar reads source posts from the last 48 hours, and the lookback is that window plus one day.
5. Apply middlewares: a technology-relevance gate, then scoring and semantic dedup. The dashboard app puts its `notBefore` cutover filter ahead of the tech gate.
6. Summarize with AI.
7. Claim one output at a time in configured topology order.
8. Commit each output result durably before the next output attempt starts.
9. Mark article and maintenance state only after successful completion.

The pipeline never claims exactly-once delivery. It provides bounded, operator-assisted recovery.

## Delivery State Model

### Dashboard App

The app persists delivery state with `SQLiteDeliveryStore` (`src/core/sqlite-delivery-store.js`):

- requests, deliveries, attempts, outputs, batches, reservations, maintenance rows, and operator actions live in physical per-domain tables (see State Tables)
- request and operator mutations are idempotent and versioned
- the store creates and migrates its own schema; `news_schema_migrations` is its additive migration ledger, and the later migrations moved legacy generic rows into the domain tables, materialized hot query fields, and added exact indexes for retention, status, and queue queries

The store was written against the SQL storage API of a Cloudflare Durable Object, the retired Worker's runtime. On Node, `createNodeSqlStorage()` (`src/app/db/node-sql-storage.js`) gives a `node:sqlite` connection that same surface: the `sql.exec()` cursor and `transactionSync()`, which runs `BEGIN IMMEDIATE … COMMIT` and nests with savepoints.

### Local Node CLI

The CLI uses `LocalFileDeliveryStore`:

- one owned local state file
- atomically published unique-owner lock plus a canonical compatibility link to prevent multiple writers
- process identity includes the process start instant when the platform exposes it, preventing a reused PID from inheriting a stale writer lock
- stale legacy canonical-lock conversion requires every older runtime sharing the file to be stopped and drained before the upgrade starts
- a failed atomic save reloads the renamed durable snapshot or quarantines the store instead of allowing memory and disk to diverge
- read-only initialization for preview paths
- synchronous transactions only

`MemoryDeliveryStore` exists for tests and ephemeral inspection, not for real output paths.

## State Tables

| Table | Purpose |
|---|---|
| `channel_state` | Per-channel pause and mutation lease |
| `requests` | Accepted operator retry requests |
| `deliveries` | High-level delivery lifecycle |
| `attempts` | Generation and output attempts |
| `delivery_outputs` | Per-output result state |
| `articles` | Article ownership and terminal status |
| `delivery_reservations` | Digest request reservation and recovery |
| `day_batches` | Drip queue state and refill tracking |
| `batch_items` | Drip queue item order |
| `maintenance_outbox` | Legacy compatibility cache mirror (`seen:` and digest keys) and its replay |
| `operator_actions` | Idempotent operator audit records |
| `legacy_seen_compat` / `legacy_digest_compat` | Read-only legacy dedup compatibility |
| `coordinator_meta` / `canary_state` / `migration_state` | Written only by the retired Worker's coordinator; the schema still creates them, and nothing writes them now |
| `retention_state` | Once-per-day compaction marker |
| `news_schema_migrations` | Additive SQLite migration ledger |

Known runtime domains map to their own physical SQLite tables. `delivery_records` remains as a bounded compatibility table for migrating older generic rows and for non-domain test records; normal hot paths do not scan it. Store queries allowlisted materialized fields, cap individual pages at 1,000 rows, and use table-specific state/deadline/request/retention indexes. Aggregate status counts indexed state groups and reads only its requested page; the latest-batch summary is an indexed SQL aggregate rather than a capped item scan.

## Retention And Idempotency

- unresolved deliveries, attempts, requests, and referenced operator actions do not expire by age
- ordinary bulky terminal delivery data is removed after 30 days
- force/canary delivery records become compact replayable tombstones after 30 days
- ordinary completed request detail is removed after 90 days; force/canary/operator-retry requests become compact tombstones
- operator reasons are hashed before persistence; audit results contain bounded IDs/state only and become compact tombstones after 365 days
- permanent article dedup, safety suppression, and mutation-idempotency tombstones are independent of bulky-history retention

## Dashboard App Runtime

### Process

`src/app/server.js` is one Node process: Express API and static UI, the channel scheduler, and one SQLite connection. Startup fails fast and nothing listens until the database and the master key are known good:

```text
validate env → load Access signing keys → open DB → back up before a delivery-store upgrade →
init SQLiteDeliveryStore → app migrations (backup first) → vault key check → create runtime →
seed telegram-main (paused) → listen → acquire the runtime lease and start the scheduler
```

Listening before the lease keeps `/healthz` alive while a previous instance's lease expires.

### Data

One file, `${DATA_DIR}/content-radar.db`, opened with WAL journaling, foreign keys, a 5 s busy timeout, and `synchronous=FULL`. `FULL` makes the claim committed before each Telegram send survive a host crash or power loss; with `NORMAL` a lost claim could send the same post twice. The data directory is created `0700`.

App tables sit next to the delivery-store tables:

| Table | Purpose |
|---|---|
| `app_schema_migrations` | App migration ledger (separate from `news_schema_migrations`) |
| `app_settings` | Master-key fingerprint and the last retention run |
| `app_channels` | Channel config: scalar columns plus `config_json` (sources, prompt, AI, Telegram credential slots, limits), `version`, `not_before`, `cutover_required` |
| `app_credentials` | Encrypted credential values (ciphertext, IV, tag) with label, kind, and audit metadata |
| `app_runs` / `app_source_health` | Run history and per-source health of each run |
| `app_content_items` | Content library: one row per channel article |
| `app_runtime_lease` | Single-instance runtime lease |

Migrations (`src/app/db/app-migrations.js`) are append-only and run in one transaction. Before any pending migration on a database that holds data, the app writes a `VACUUM INTO` snapshot to `${DATA_DIR}/backups/content-radar-<UTC timestamp>-v<from>.db` (mode `0600`); a failed backup aborts the migration. The same happens before the delivery store upgrades an older schema (`…-delivery-v<from>.db`). The newest 10 backups are kept, a brand-new database is never backed up, and a database migrated by a newer build is refused.

### Channels

- Channels are Telegram-only and live in `app_channels`. `src/app/channels/config-schema.js` is the single validation step for API input, stored rows, and the seed; every update carries the current `version` (stale versions get 409).
- Sources are preset bundles (`PRESET_FACTORIES` in `src/app/channels/source-factories.js`, which covers every export of `src/presets/index.js`) or typed sources: `rss`, `hackernews`, `reddit`, `devto`, `github-trending`, `html`, `json`.
- AI: `claude`, `openai`, `groq`, `gemini` (optionally through Cloudflare AI Gateway), `qwen`, `deepseek`, `ollama`, `openrouter`, `together`, or `custom` (operator-supplied `baseUrl`).
- Prompt: language `vi` or `en`, a built-in style, audience, and an optional custom system prompt (up to 8,000 characters). The custom prompt replaces only the style section; the output-language rules, the source-data (prompt-injection) rules, and the platform rules are always kept.
- `src/app/channels/build-channel.js` turns a stored channel and its decrypted credentials into the same object `defineChannels()` returns, so the shared runner executes it.
- Every channel is paused in the delivery store before its row is written; resume is refused until all of its credentials resolve.
- First start seeds `telegram-main` with the production settings the retired Worker ran (presets `bigTechBlogs`, `aiNewsSources`, `aiDeepDiveSources`; Gemini `gemini-3.5-flash-lite` through the `news-engine` AI Gateway; drip, daily limit 18; cron `0 0-17 * * *` UTC; Vietnamese digest prompt), paused, without credentials, and marked `cutoverRequired`.

### Scheduler And Runs

- **Lease:** `app_runtime_lease` holds one owner (60 s TTL, renewed every 15 s). Only the holder schedules; manual runs and every control except pause need the lease (503 `runtime_not_leased`). Pause is always allowed because it only stops delivery, and read-only preview does not need the lease. On Dokploy the `stop-first` update order keeps a second container from starting during a redeploy; the lease is the second line of defence.
- **Schedule:** one `node-cron` job per enabled channel, in the channel's own IANA timezone. A tick is re-checked against the schedule at its instant; a tick for a channel that is already running or queued is skipped and logged. Config changes re-register the channel's job without a restart.
- **Sequential runs:** one global queue runs one channel at a time; a manual run of a busy channel answers 409 `channel_busy`. `batchSize × delayMs` is capped at 10 minutes so one channel cannot hold the queue.
- **Runs:** each run builds the channel fresh from the database and calls `runChannels()` with the SQLite delivery store and the app's file cache (`news:{channelId}` keys), so the CLI's guarantees hold: sequential outputs, ambiguous outputs never resent automatically, tech gate, story dedup, daily limit. Each run writes `app_runs` (trigger, status, counts, AI usage, bounded output results, sanitized errors) and `app_source_health`.
- **Preview** reuses the CLI's read-only preview: it fetches and summarizes, but sends nothing and writes no delivery state, run, or library row.
- **Controls** (`pause`, `resume`, `retry-generation`, `retry-output`, `restore-topology`, `confirm-delivered`, `abandon`, `retry-maintenance`) call the CLI's `executeRecoveryControl()`: exact `expectedVersion`, durable `idempotencyKey` replay, bounded reason, and the authenticated identity as `operatorId`. Targets must belong to the channel in the URL, and output retries re-check the configured output topology before any provider call.
- **Events:** run started/finished, control applied, and channel or credential changes go to `GET /api/events` (server-sent events) with identifiers and statuses only.

### Content Library And Statistics

- `app_content_items` has one row per channel article, keyed by the delivery store's canonical article key. Each run records what its selection chain saw: `selected`, or `rejected` with a reason (`before_cutoff`, `not_tech`, `low_score`, or `duplicate`, which also covers stories already delivered). Delivery projections copy the delivery state, AI summary, Telegram message ID, and delivery time onto the same row. Scans never downgrade a delivery status.
- The library syncs incrementally after every run and every control, plus a full sync at startup and during daily maintenance, so a crash between a run and its sync is repaired.
- Statistics are SQL aggregates over the app tables: posts per day and channel, source health per day and source, AI generation and output failure rates, and AI token usage. Ranges are at most 400 days; `utcOffsetMinutes` sets the day boundary (the dashboard sends 420, Vietnam time).

### Retention

A maintenance job runs at most once a day:

| Data | Kept |
|---|---|
| Delivered library items | Forever |
| Library items still in a delivery state | Until they settle |
| Scanned items never delivered (selected, rejected, abandoned) | `CONTENT_SCAN_RETENTION_DAYS` (default 30) after both their last scan and last change |
| `app_runs` and `app_source_health` | `RUN_HISTORY_RETENTION_DAYS` (default 180) |
| Delivery-store detail | The store's own compaction (`compactHistory()`, see above), run only after a full library sync so nothing is dropped before the library copied it |

### Shutdown

On SIGTERM or SIGINT the app stops taking runs and ticks, waits up to `SHUTDOWN_WAIT_SECONDS` (default 120) for the run in flight, then ends event streams and closes the HTTP server. A run is never cut short: past the wait the process keeps renewing the lease until the run commits, then releases the lease, closes the database, and exits on its own. The container stop grace period must be at least the wait plus 15 s (135 s by default); a kill in the middle of a send leaves that output ambiguous for an operator to reconcile. A drip item's generation call (up to 25 s) and output call (up to 60 s) plus a source scan have to fit inside the wait, so keep it at 120 s or more.

## Run Modes

| Mode | Behavior |
|---|---|
| `run` | Manual delivery run that bypasses cron gating |
| `cron` / `daemon` | Exact per-channel schedule execution |
| `preview` | Read-only delivery preview |
| `pause` / `resume` | Versioned channel state change |
| `retry-*` | Exact target recovery actions |
| `restore-topology` | Audited, versioned release of one config-matched topology blocker |

## Channel Scheduling

For the CLI, `src/channels/definitions.js` builds channel configs from environment variables, and `src/channels/runner.js` executes due channels sequentially. The dashboard app schedules its stored channels itself (see above) and calls the same runner.

Important details:

- `BROADCAST_MODE` controls `digest` vs `drip`
- `CRON_SCHEDULE` and the per-channel cron overrides are exact five-field expressions
- source fetches are batched, but channel execution is sequential
- drip mode is a continuous radar: it carries unresolved work across days, and re-scans sources whenever the batch has open slots under the channel's daily limit (`DRIP_DAILY_LIMIT`, default 18) and its scan interval has elapsed (default 15 minutes, which only throttles back-to-back scans)
- each scan runs under a renewable lease, so a claim lost mid-scan creates no deliveries; a scan counts as failed only when it throws, or when no source is healthy and it queued nothing; failures are logged, back off exponentially (capped at an hour), and never block articles already queued
- `preview` never applies the daily limit or story-coverage exclusion; it stays read-only in every mode

## Security Model

### Dashboard App

**Authentication.** Cloudflare Access sits in front of the app, and the app verifies the Access JWT itself on every request (defense in depth: other containers on the Docker network can reach it directly).

- Only `GET /healthz` (container liveness, body `ok`) is served without a token. Everything else, including `/api/health`, the static UI, and the event stream, needs a valid token.
- The token is read only from the `Cf-Access-Jwt-Assertion` header; the `CF_Authorization` cookie and the `Cf-Access-Authenticated-User-Email` header are never trusted. Checks: RS256 signature by a key of the team JWKS selected by `kid`, issuer equal to `ACCESS_TEAM_DOMAIN`, an audience in `ACCESS_AUD`, and an unexpired `exp` (30 s clock tolerance).
- An unreachable JWKS answers 503 and is logged without URLs; it never falls back to accepting requests.
- `ACCESS_JWKS_FILE` (local signing keys for development and tests) is accepted only when `NODE_ENV` is exactly `development` or `test`; any other value, including an unset `NODE_ENV`, refuses to start.

**Roles.** Identities are people (`email` claim) or service tokens (`common_name` claim = client ID).

| Role | Granted by | Allows |
|---|---|---|
| `viewer` | `APP_VIEWER_EMAILS`, or `<client-id>:viewer` in `APP_SERVICE_TOKEN_ROLES` | Every read, the UI, and the event stream |
| `operator` | `APP_OPERATOR_EMAILS`, or `<client-id>:operator` | Everything a viewer can, plus every mutation and preview (which calls the AI) |
| none | A valid token that is not mapped | `GET /api/health` only; everything else is 403 |

Audit identities (`operatorId`, `updatedBy`) are the email, or `service:<clientId>` for a service token, always taken from the verified token and never from a request body.

**Mutations** need the operator role, an `Origin` exactly equal to `PUBLIC_ORIGIN`, `Content-Type: application/json`, and a body of at most 8 KB (64 KB for channel create and update, which carry the custom prompt). Express does not trust proxy headers, so `Host` and `X-Forwarded-*` never influence these checks.

**Responses.** Everything under `/api` is `Cache-Control: no-store`. Every response carries a Content Security Policy without inline scripts or styles (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. Errors are `{ error, message }` with stable codes; unexpected failures answer `Request failed`. Free text from providers is sanitized (URLs, tokens, provider bodies) before it reaches responses, logs, events, runs, or the library, and credential routes log only the error class.

**Secrets.** Credentials (`telegram_bot_token`, `telegram_chat_id`, `ai_api_key`, `ai_gateway_token`) are encrypted with AES-256-GCM: a 32-byte `APP_MASTER_KEY` (base64), a fresh 12-byte IV per write, and associated data that binds each ciphertext to its credential id and kind, so a sealed value cannot be moved to another row. A keyed fingerprint of the master key is stored on first use; a different key refuses to start. The store is write-only: the API returns metadata (`isSet`, timestamps, `usedBy`) and never a value; plaintext is resolved only when a channel is built for a run, preview, or control. A credential that a channel uses cannot be deleted. The chat ID is treated as a secret.

**Accepted risk: operators are trusted administrators.** Write-only storage prevents displaying a secret, not deliberate misuse. An operator (or a hijacked operator session) can point a `custom` AI provider's `baseUrl` at a server they control and reference a stored `ai_api_key`; the next preview or run sends that key there as a Bearer token. Bot tokens and chat IDs only ever go to `api.telegram.org`. Grant the operator role only to administrators who may hold every secret.

### Cutover Guard

The seeded `telegram-main` was created to take over from the Worker, so it must never post articles published before the cutover.

- `cutoverRequired` is system-managed: the seed sets it on `telegram-main` (migration v2 also sets it on an existing `telegram-main` whose cutoff is unset), API input never sets or clears it, and channels created through the API never have it.
- While such a channel's `notBefore` is unset, resume, manual runs, and `retry-output` answer 409 `cutover_required`, and a scheduled tick (of a channel resumed earlier) is skipped with a warning, before any source is fetched. Preview stays available and sends nothing.
- `notBefore` (operator-only, via `PUT /api/channels/:id`) drops articles whose `publishedAt` is earlier, ahead of the tech gate. Articles without a readable `publishedAt` are kept (accepted risk: their age cannot be proven); a dropped article appears in the library as `rejected` with reason `before_cutoff`.
- **Moving `notBefore` later does not drop items already queued.** The filter runs when a scan selects articles; drip items queued before the change keep their place and still post. To enforce a stricter cutoff on a running channel, pause it and abandon the queued items it should not post. The first cutoff is not affected: a seeded `telegram-main` stays paused from creation and preview writes nothing, so its queue is empty when `notBefore` is first set.

## Delivery Guarantees

- source failures are diagnostic, not silent
- AI generation is required before output delivery
- outputs are sequential with durable acknowledgement between calls
- stale attempts become recoverable states rather than disappearing
- ambiguous output is not automatically resent
- matching output configuration never auto-clears `blocked_topology`; an operator must invoke `restore-topology` or `abandon`
- paused channels do not accept new claims unless an audited paused-mutation override is supplied
- legacy compatibility replay is separate from authoritative delivery commits

## Configuration Notes

`Dockerfile` builds the dashboard app image (`news-engine:local`), and `docker-compose.yml` runs it locally.

The Node CLI relies on:

- `DELIVERY_STORE_TYPE=file`
- `DELIVERY_STORE_PATH`
- `CACHE_TYPE` and `CACHE_PATH`

The dashboard app reads `DATA_DIR`, `APP_MASTER_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS`, `APP_SERVICE_TOKEN_ROLES`, `PUBLIC_ORIGIN`, `CACHE_PATH` (default `DATA_DIR/news.json`; `CACHE_TYPE` must be `file` or unset), `CONTENT_SCAN_RETENTION_DAYS`, `RUN_HISTORY_RETENTION_DAYS`, `SHUTDOWN_WAIT_SECONDS`, `HOST`, `PORT`, `NEWS_BUILD_VERSION`, and the development-only `ACCESS_JWKS_FILE`. `src/app/config/env.js` owns the rules; `.env.example` shows placeholders.

## Operational Boundaries

- Do not treat `MemoryCache` as a delivery store.
- Do not document exactly-once delivery.
- Do not claim parallel output sending.
- Do not route output-capable commands through a non-persistent cache.
- Do not merge rollout and recovery logic into source or output plugins.
- Do not let two engines post to the same chat: the CLI and the dashboard app keep separate delivery state, so neither knows what the other already posted.
