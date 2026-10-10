# Content Radar

Content Radar scans technology content from swappable sources, filters it for technology relevance, summarizes it with AI, and posts the result to social channels.

Two runtimes share one engine (`src/core`) and one delivery state machine:

- **Dashboard app** (`src/app/` + `web/`): one Node process that serves a React dashboard and its API, schedules channels, and keeps everything in SQLite. Telegram channels, sources, prompts, AI providers, and encrypted credentials are configured in the dashboard, so changes need no redeploy. It is the production engine, deployed on Dokploy and served by Dokploy's Traefik behind Cloudflare Access.
- **Node CLI** (`src/adapters/node.js`): manual runs, a cron daemon, read-only previews, and recovery commands for channels defined in environment variables. The Telegram channel turns on once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, and the Facebook channel once `FB_PAGE_TOKEN` and `FB_PAGE_ID` are set.

The dashboard app at `https://radar.dantech.academy` has been the only engine posting to `telegram-main` since the production cutover on 2026-10-03. The previous production runtime, the Cloudflare Worker `news-engine`, was deleted on 2026-10-04, so there is no Worker fallback. The Dokploy deployment, the cutover record, and the rollback runbook are in [docs/deployment.md](./docs/deployment.md).

Delivery model, in every runtime:

- AI generation is required for any real delivery or preview run.
- Output attempts are sequential, not parallel, and each durable acknowledgement is committed before the next output starts.
- Delivery state is durable. The engine does not promise exactly-once delivery.
- `MemoryCache` is for tests and dry-run paths only. Output-capable commands require a persistent cache and a durable delivery store.

## Quick Start

### Install

```bash
npm install
npm run web:install   # dashboard dependencies (npm ci in web/)
cp .env.example .env
```

### Validate

```bash
npm test   # Node suite, offline
```

### Run the dashboard locally

Every request to the app needs a signed Cloudflare Access JWT; there is no authentication bypass. Locally, `npm run dev:token` signs one with a development key that it creates once under `.cache/dev-access/` (gitignored). The app accepts that key only when `NODE_ENV` is `development` or `test`.

```bash
# In both terminals: the development Access issuer and audience (shell values win over .env)
export ACCESS_TEAM_DOMAIN=https://dev-access.content-radar.invalid ACCESS_AUD=content-radar-dev

# Terminal 2, first: create the dev key and sign a token (stderr shows the settings the backend needs)
export DEV_ACCESS_TOKEN="$(npm run -s dev:token -- --email you@example.com)"

# Terminal 1: the backend on http://127.0.0.1:3000, restarted on change
NODE_ENV=development ACCESS_JWKS_FILE=.cache/dev-access/jwks.json \
APP_OPERATOR_EMAILS=you@example.com PUBLIC_ORIGIN=http://localhost:5173 \
DATA_DIR=.cache/app-data CACHE_PATH=.cache/app-data/news.json \
npm run app:dev

# Terminal 2: the dashboard with hot reload on http://localhost:5173
npm run web:dev
```

- Put `APP_MASTER_KEY` in your local `.env` once (`openssl rand -base64 32`) and keep it. It encrypts the credentials stored under `DATA_DIR`; a different key refuses to start.
- `PUBLIC_ORIGIN` must be the Vite origin. The Vite proxy forwards the browser's `Origin` unchanged and adds `Cf-Access-Jwt-Assertion` from `DEV_ACCESS_TOKEN`.
- Give the app its own `DATA_DIR` and `CACHE_PATH`. The app also loads `.env`, so without the override it would share the CLI's cache file.
- The first start seeds `telegram-main` with the production settings the retired Worker ran, paused and without credentials. It cannot resume or run until its cutover instant (`notBefore`) is set.

`web/vite.config.ts` describes the same setup. `npm run app` (alias: `npm run dashboard`) starts the backend without watching and serves the built UI from `web/dist` (`npm run web:build`).

### Run the CLI

```bash
npm run preview    # read-only preview, fetch + summarize, no send
npm run start      # manual run
npm run start:cron # exact per-channel cron daemon
```

The CLI and core engine support Node.js `>=18`. The dashboard app needs Node.js `>=22.13` for `node:sqlite` (the Docker image runs Node 24), and the dashboard build needs `>=22.12`.

## Dashboard App

The app (`src/app/server.js`) runs Telegram channels stored in SQLite through the same `runChannels()`/`buildEngine()` path as the CLI, so it keeps the same guarantees: sequential outputs, durable delivery state, ambiguous outputs never resent automatically, read-only preview, the tech gate, story dedup, and the daily limit.

| Area | What the dashboard offers |
|---|---|
| Overview and operations | Channel status, queue by day, run history with per-source health, unresolved items; run now, preview (never sends), pause/resume, and the recovery actions the state machine allows |
| Channels | Create, edit, enable/disable, and delete Telegram channels: sources (presets and typed sources), AI provider and model (Gemini through AI Gateway, Claude, OpenAI-compatible), prompt (language, style, audience, custom system prompt), cron and timezone, mode, limits, and the cutover instant |
| Credentials | Bot tokens, chat IDs, AI keys, and AI Gateway tokens, encrypted at rest and write-only: the UI only shows whether a value is set |
| Content library | Scanned and posted articles with title, source, link, AI summary, status, rejection reason, and Telegram message ID |
| Statistics | Posts per day and channel, source health over time, AI and output failure rates, token usage |

- Cloudflare Access authenticates people (email) and service tokens; the app verifies the Access JWT on every request except `GET /healthz` and maps identities to `viewer` (read-only) or `operator` (everything) through `APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS`, and `APP_SERVICE_TOKEN_ROLES`.
- Every channel starts paused; resuming is an audited operator action.
- One instance runs at a time: a lease in SQLite gates the scheduler, manual runs, and every control except pause.
- Startup validates the environment and fails fast without echoing values. See `.env.example` and `src/app/config/env.js`.

Architecture, data, and the security model are in [docs/system-architecture.md](./docs/system-architecture.md).

## Runtime Modes

CLI commands (`node src/adapters/node.js <command>`; `help` lists every command and flag):

| Command | Behavior | Notes |
|---|---|---|
| `run` | Manual run that bypasses cron gating | Not the same as force |
| `drip` | Alias of `run` | Each channel keeps its configured mode |
| `cron` | Exact per-channel cron daemon | Uses each channel timezone and schedule |
| `daemon` | Alias of `cron` | Same behavior |
| `preview` | Read-only preview | Mode-aware and non-mutating |
| `status` | Read-only list of one channel's unresolved recovery targets | Requires `--channel`; pages with `--limit` and `--offset` |
| `pause` / `resume` | Operator recovery controls | Require exact version, idempotency key, and reason |
| `retry-generation` / `retry-output` | Retry one exact unresolved item | Require exact target IDs and expected version |
| `restore-topology` | Clear one topology blocker after configuration is restored | Versioned and audited; matching configuration alone never clears the blocker |
| `confirm-delivered` / `abandon` | Resolve ambiguous or blocked items | Operator-only recovery actions |
| `retry-maintenance` | Replay one dead-letter maintenance mirror | Replay stays separate from authoritative delivery commits |

Force semantics are explicit:

- CLI force is `node src/adapters/node.js run --force --channel <id> --idempotency-key <key> --operator-id <key-id> --reason <reason> --confirm-duplicate-risk` (`OPERATOR_KEY_ID` can supply the operator id)
- The dashboard app has no force: a manual run is an ordinary run outside the schedule
- Scheduled runs remain schedule-driven; force does not silently change cron semantics

## Delivery Model

- Sources fetch into a bounded article set, then middlewares can score or filter it.
- The default Telegram mix combines official AI labs, established technology publications, engineering blogs, community discovery, and curated deep dives. The [preset factories](./src/presets/index.js) and [channel definitions](./src/channels/definitions.js) own the current inventory for the CLI; dashboard channels store their own source lists, and the seeded `telegram-main` uses the same presets.
- AI summarizes the selected articles using the configured language, style, audience, and platform rules.
- Outputs are processed one at a time in configured topology order.
- Telegram single-article news posts use a short standard photo caption, target 2–3 summary sentences, and preserve the full source link. Normal captions are capped at 700 characters; links or image content that cannot fit a Telegram caption use the standard photo-plus-text flow. Rich messages are not used.
- After each output send, the state machine commits the result before the next output starts.
- Failures become classified states such as retryable, manual-retry-required, ambiguous, or exhausted.
- A Telegram request that fails before it is sent (a DNS or connect error) and a Telegram rate limit retry automatically on a later run, up to three attempts; after that the item waits for an operator while newer articles keep posting. A request that times out or drops after it may have reached Telegram is ambiguous, and the channel sends nothing more until it is resolved. The next run first checks whether the post arrived: for a public channel it reads the channel's web preview and looks for the article link, and when it finds the post it confirms the output with the message ID (recorded as `auto-reconcile`) and carries on, never resending. When it cannot prove delivery (a private channel, no matching post), an operator resolves it in the dashboard (Queue & vận hành), using "Xác nhận đã gửi" when the post is already in the channel; with `ALERT_TELEGRAM_CHAT_ID` set, the app also sends that chat one message per such block. Telegram requests wait up to 45 s before they count as timed out.
- Drip mode is a continuous radar: it persists a day batch, can carry unresolved items across days, and scans sources again whenever the batch has open slots under the channel's daily limit (`DRIP_DAILY_LIMIT`, Telegram default 18) and its scan interval has elapsed (default 15 minutes, which only throttles back-to-back scans). A scan runs under a renewable claim; losing that claim mid-scan creates no deliveries. A scan counts as failed only when it throws, or when no source is healthy and it queued nothing; failures are logged as `[Radar] Scan failed`, surface as `scanError` in the dashboard's run details, and back off (capped at an hour) without blocking articles already queued. Before queuing, a scan re-reads delivered stories so a forced drip posted during its fetch is not repeated.
- Radar scans read posts from the last 48 hours (digest runs read 24), skip stories already covered by this channel's deliveries from the current publishing day or the two before it, and queue at most one article per story. The dashboard app's `notBefore` cutover filter still drops anything published before the cutover. See [`src/core/story-dedup.js`](./src/core/story-dedup.js) for the matching rules.
- The technology-relevance gate ([`src/core/tech-relevance.js`](./src/core/tech-relevance.js)) is a topic filter, not a trust boundary — it does not vet link safety. Community articles from Hacker News and the JSON Reddit source keep their original external link, and the AI news preset's Reddit RSS source links to the Reddit thread (accepted risk).
- `preview` never applies the daily limit or story-coverage exclusion, and stays read-only in every mode. Each scan fetches every configured source (with retries) plus up to `maxArticlesPerSource` og:image lookups per RSS/Hacker News source (production default 3).
- Legacy `seen:*` and digest compatibility data are read conservatively and preserved during migration.
- Pausing blocks new claims. It does not cancel an external call that has already been issued.
- The SQLite delivery store (dashboard app) uses physical per-domain tables and indexed bounded queries; the generic record table is retained only for schema migration and non-domain compatibility.
- Status reads count indexed recovery groups and fetch only the requested page. Queue summaries use one indexed aggregate, so neither path truncates after 1,000 records or performs one delivery read per batch item.
- Bulky terminal delivery detail is pruned after 30 days, ordinary terminal request detail after 90 days, and operator audit detail is minimized/compacted while permanent idempotency and safety tombstones remain replayable. The dashboard app copies deliveries into its content library before that pruning.

Before upgrading an existing local file store to the unique-owner lock protocol, stop and drain every older Node process that can open the same store. The new runtime retains a canonical compatibility link while it owns the store, but converting a stale legacy canonical lock is intentionally a quiescence-only migration.

## Library Example

```javascript
import { ContentRadar, FileCache, LocalFileDeliveryStore, createTechRelevanceMiddleware } from './src/core/index.js';
import { bigTechBlogs } from './src/presets/index.js';
import { ClaudeAI } from './src/ai/index.js';
import { TelegramOutput } from './src/outputs/index.js';

const engine = new ContentRadar()
  .addSource(...bigTechBlogs())
  .useAI(new ClaudeAI({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .addOutput(new TelegramOutput({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  }))
  .useCache(new FileCache(process.env.CACHE_PATH))
  .useDeliveryStore(new LocalFileDeliveryStore(process.env.DELIVERY_STORE_PATH))
  .use(createTechRelevanceMiddleware())
  .configure({
    channelId: 'telegram-main',
    language: 'vi',
    style: 'digest',
    platform: 'telegram',
  });

await engine.run();
```

## Layout

```text
src/
├── core/      Delivery contracts, state machine, caches, delivery stores
├── sources/   RSS, HTML scraper, Hacker News, Reddit, Dev.to, GitHub trending
├── ai/        Claude + OpenAI-compatible providers and prompt builder
├── outputs/   Telegram, Facebook, Slack, Discord, Email, webhook, file
├── presets/   Source bundle factories
├── channels/  Env-defined channels and the shared channel runner
├── app/       Dashboard app: server, API, Access auth, SQLite, vault, scheduler
└── adapters/  Node CLI entry point
web/           Dashboard UI (React + Vite + TypeScript), built to web/dist
scripts/       dev-access-token.mjs (local Access JWTs), deploy/ (npm run deploy:*)
tests/         Node suites, browser E2E (tests/e2e)
```

## Recovery Commands

Exact local recovery commands use the same CLI and must include a stable idempotency key, an expected version, and a bounded reason:

```bash
node src/adapters/node.js pause \
  --channel telegram-main \
  --idempotency-key pause-telegram-main-001 \
  --expected-version 7 \
  --reason "Pause for recovery"

node src/adapters/node.js resume \
  --channel telegram-main \
  --idempotency-key resume-telegram-main-001 \
  --expected-version 8 \
  --reason "Resume after recovery"

node src/adapters/node.js retry-generation \
  --channel telegram-main \
  --idempotency-key retry-generation-001 \
  --expected-version 12 \
  --delivery-id <delivery-id> \
  --reason "Retry generation after timeout"

node src/adapters/node.js retry-output \
  --channel telegram-main \
  --idempotency-key retry-output-001 \
  --expected-version 12 \
  --delivery-id <delivery-id> \
  --output-key <output-key> \
  --reason "Retry output after ambiguous result"
```

`confirm-delivered`, `abandon`, and `retry-maintenance` follow the same pattern and require the exact target id plus the expected version.

`restore-topology` additionally verifies that the current configured destination fingerprint matches the delivery's durable fingerprint. A config match is read-only until this explicit operator action commits; it never auto-unblocks or calls a provider.

The dashboard runs the same recovery code (`executeRecoveryControl`) behind `POST /api/channels/:id/control/:action`, with the authenticated identity as the operator.

## Testing

```bash
npm test                       # Node suite (npm run test:node)
npm run test:web               # dashboard typecheck + Vitest unit tests (needs npm run web:install)
npx playwright install chromium   # once, for the browser tests
npm run test:e2e               # builds web/dist, then Playwright against the real app on 127.0.0.1:4310
node --check src/core/engine.js
node --check src/adapters/node.js
```

Every suite runs offline: Node tests load `tests/helpers/deny-network.js`, and the E2E harness refuses every non-loopback connection and injects fake sources, AI, and Telegram. E2E specs are named `*.e2e.js` so the Node runner never collects them.

## Docker

The `Dockerfile` builds the dashboard app image that Dokploy also builds: the web build stage plus a `node:24-alpine` runtime that runs `node src/app/server.js` as the unprivileged `node` user. No `.env` or local state enters the image (`.dockerignore`).

```bash
npm run docker:build   # docker build -t news-engine:local .
npm run docker:run     # docker compose up -d
curl http://127.0.0.1:3000/healthz   # "ok"; every other route needs an Access JWT
```

- `docker-compose.yml` runs the image in production mode (`NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data`, `CACHE_PATH=/data/news.json`), publishes the port on `127.0.0.1` only, and mounts the named volume `data` at `/data`.
- Required in `.env` (or the environment): `APP_MASTER_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `PUBLIC_ORIGIN` (`http://127.0.0.1:3000` for Compose), and at least one of `APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS`, or `APP_SERVICE_TOKEN_ROLES`. Production mode refuses `ACCESS_JWKS_FILE`, so tokens are verified against the real Access team.
- On SIGTERM the app waits up to `SHUTDOWN_WAIT_SECONDS` (120) for a run in flight and never closes the database under it; Compose sets `stop_grace_period: 135s`.

## Environment Overview

See `.env.example` for the full list. The important groups are:

- AI provider selection and API keys
- Cloudflare AI Gateway BYOK for Gemini: `CF_AIG_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `AI_GATEWAY_ID` together (a partial set is refused), plus the optional `AI_GATEWAY_BYOK_ALIAS`, send Gemini calls through the gateway with the provider key stored there instead of `GEMINI_API_KEY`; dashboard channels configure the same path per channel
- Telegram and the optional Facebook channel credentials
- cache and delivery-store paths for the CLI
- `OPERATOR_KEY_ID`, the audit identity of CLI recovery commands
- the dashboard app: `DATA_DIR`, `APP_MASTER_KEY`, Cloudflare Access (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), roles (`APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS`, `APP_SERVICE_TOKEN_ROLES`), `PUBLIC_ORIGIN`, retention (`CONTENT_SCAN_RETENTION_DAYS`, `RUN_HISTORY_RETENTION_DAYS`), `SHUTDOWN_WAIT_SECONDS`, the optional `ALERT_TELEGRAM_CHAT_ID` (one Telegram message to that chat when a channel stays blocked by a send the app could not confirm; start the channel's bot in the chat first), and the development-only `ACCESS_JWKS_FILE`
- drip batch sizing and `DRIP_DAILY_LIMIT` (Telegram radar's daily article limit, default 18; other channels use fixed limits)

Dashboard channel secrets are not environment variables: operators enter them in the dashboard. Keep a copy of `APP_MASTER_KEY` in a password manager; losing it means re-entering every stored secret.

## Kept Production Identifiers

The Content Radar rename is code- and docs-level only. These production identifiers keep their `news-engine`/`news` names on purpose; renaming any of them is a breaking change, not a cosmetic edit:

- The `news-engine` Docker Compose service and `news-engine:local` image tag, which package the dashboard app. The Compose volume is `data` (mounted at `/data`, holding `content-radar.db`, its `backups/`, and the app cache).
- The AI Gateway `news-engine`, a Cloudflare account resource that outlived the Worker: the seeded `telegram-main` and `AI_GATEWAY_ID` refer to it by this ID.
- `NEWS_BUILD_VERSION`, the version the dashboard app reports in `/api/health`.
- The `news:{channelId}` cache key prefix — changing it loses the dedup history kept under it and can repost already-delivered articles. The dashboard app keeps it in its cache file (`/data/news.json`), the CLI in `.cache/news.json`.
- The `news_schema_migrations` table, the delivery store's migration ledger in every existing database.

These Worker identifiers no longer exist: the Worker name and its `workers.dev` hostname, the `NEWS_CACHE` and `NEWS_COORDINATOR` bindings, and the `NEWS_RUNTIME_MODE` and `NEWS_DEFAULT_PAUSED` variables. The KV namespace once bound as `NEWS_CACHE` is still an account resource, but nothing in this repository reads it.

## Dependencies

- `node-cron` for the CLI cron daemon and the dashboard scheduler
- `express` for the dashboard app server
- `jose` for Cloudflare Access JWT verification
- `dotenv` optional for local `.env` loading
- `redis` optional for `RedisCache`
- `@playwright/test` (development) for the browser E2E suite; the dashboard UI keeps its own dependencies in `web/package.json` (React, React Router, TanStack Query, Tailwind CSS, Vite, TypeScript, Vitest)

The core engine, parsers, AI clients, and outputs use native `fetch()` only.
