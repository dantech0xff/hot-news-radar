# Content Radar — Agent Guide

`CLAUDE.md` and `AGENTS.md` are identical copies of this guide; edit both together.

## Project Overview

**Content Radar** is a plugin-based engine that scans technology content from any data source, filters it for tech relevance, summarizes it with any AI model, and posts results to social output channels. The architecture is fully modular — every component is a swappable plugin.

Three runtimes share the engine:

- **Dashboard app** (`src/app/` + `web/`) — one Node process: React dashboard, API, channel scheduler, and SQLite. Telegram channels, sources, prompts, AI providers, and encrypted credentials are configured in the dashboard without a redeploy. It is the primary engine, deployed on Dokploy and served by Dokploy's Traefik behind Cloudflare Access; the production cutover happened on 2026-10-03 (`docs/deployment.md`).
- **Cloudflare Worker** `news-engine` — the previous production runtime; its `telegram-main` channel was paused, not deleted, at the cutover so it stays available for rollback.
- **Node CLI** (`src/adapters/node.js`) — channels from environment variables. Telegram is active today; X, Facebook, and Threads exist and activate once their environment variables are configured.

This is NOT a monolithic app. It's a **composable engine** with a plugin registry pattern; the runtimes are thin layers around it.

Kept identifiers: the Cloudflare Worker, its AI Gateway ID, `NEWS_*` bindings/env vars, the `news:{channelId}` cache prefix, and other production-facing names still use `news-engine`/`news` on purpose — see README.md's "Kept Production Identifiers" for what they are and why renaming them breaks durable state.

## Architecture

```
src/
├── core/                    # Engine core (NEVER depends on plugins)
│   ├── contracts.js         # 4 plugin interfaces: SourcePlugin, AIPlugin, OutputPlugin, CachePlugin
│   ├── engine.js            # ContentRadar orchestrator — fluent builder, pipeline executor
│   ├── caches.js            # 4 cache implementations: Memory, File, CloudflareKV, Redis
│   ├── delivery-state-machine.js / delivery-store.js / sqlite-delivery-store.js  # Durable delivery state
│   ├── tech-relevance.js    # Tech relevance gate — createTechRelevanceMiddleware(), scoreTechRelevance()
│   ├── story-dedup.js       # Story dedup — excludeCoveredStories(), pickDistinctStories() for radar scans
│   └── index.js             # Barrel exports
│
├── sources/                 # Source plugins (each extends SourcePlugin)
│   ├── rss.js               # RSSSource + createRSSSources() batch helper
│   ├── html-scraper.js      # HTMLScraperSource (regex-based, no cheerio)
│   ├── hackernews.js        # HackerNewsSource (Algolia API, no auth)
│   ├── reddit.js            # RedditSource (JSON API; Reddit now answers unauthenticated requests with 403)
│   ├── devto.js             # DevToSource + JSONAPISource (generic JSON adapter)
│   ├── github-trending.js   # GitHubTrendingSource
│   └── index.js
│
├── ai/                      # AI plugins (each extends AIPlugin)
│   ├── claude.js            # ClaudeAI (Anthropic native API)
│   ├── openai-compat.js     # OpenAICompatibleAI + factory helpers: openai(), groq(), gemini(), ollama(), openRouter(), togetherAI()
│   ├── create-ai.js         # createAI() — shared provider factory for every runtime
│   ├── _prompts.js          # Shared prompt builder — buildPrompt(articles, {language, style, audience, customSystemPrompt})
│   └── index.js
│
├── outputs/                 # Output plugins (each extends OutputPlugin)
│   ├── telegram.js          # TelegramOutput (auto-split, markdown→plaintext fallback)
│   ├── channels.js          # SlackOutput, DiscordOutput, EmailOutput, WebhookOutput, MarkdownFileOutput
│   └── index.js
│
├── presets/                 # Pre-configured source bundles
│   └── index.js             # bigTechBlogs(), communitySources(), aiMLBlogs(), aiNewsSources(), aiDeepDiveSources(), devopsSources(), mobileSources()
│
├── channels/                # Env-defined channels (CLI + Worker) and the shared runner
│   ├── definitions.js       # defineChannels(env)
│   └── runner.js            # buildEngine(), runChannels(), listUnresolvedTargets(), sanitizeRuntimeError()
│
├── app/                     # Dashboard app (Node ≥22.13, node:sqlite) — see docs/system-architecture.md
│   ├── server.js            # Process lifecycle: env → DB → migrations → vault → seed → listen → lease; graceful shutdown
│   ├── create-app.js        # Express app: security headers, /healthz, Access JWT, roles, API routes, static UI
│   ├── config/env.js        # loadAppConfig() — validates every variable, fails fast without echoing values
│   ├── auth/                # access-jwt.js (jose), roles.js (viewer/operator), access-middleware.js
│   ├── api/                 # Routes (health, meta, channels, credentials, operations, content, stats, SSE events), http.js guards, redaction.js
│   ├── db/                  # node-sql-storage.js, open-database.js, app-migrations.js (+ VACUUM INTO backups), runtime-lease.js, run/content/stats repositories
│   ├── channels/            # config-schema.js, source-factories.js (PRESET_FACTORIES), build-channel.js, channel-repository.js, seed.js
│   ├── secrets/             # vault.js (AES-256-GCM), credential-repository.js (write-only)
│   └── runtime/             # create-runtime.js, scheduler.js, run-channel.js, controls.js, content-sync.js, retention.js, not-before.js, cutover-guard.js
│
└── adapters/                # Runtime adapters (thin wrappers around ContentRadar)
    ├── cloudflare.js        # Cloudflare Worker: scheduled() + fetch() handlers
    ├── cloudflare-channel-coordinator.js  # One Durable Object per channel
    └── node.js              # Node.js CLI: run | cron | preview | recovery commands; executeRecoveryControl()

web/                         # Dashboard UI: React + Vite + TypeScript (the only TypeScript), built to web/dist
scripts/
└── dev-access-token.mjs     # Signs local Cloudflare Access JWTs for development (npm run dev:token)
tests/                       # *.test.js Node suites (tests/app = dashboard app), tests/workers (Vitest pool), tests/e2e (*.e2e.js, Playwright)
```

## Key Design Decisions

1. **Plugin contracts in `core/contracts.js`** — 4 abstract base classes. Every plugin must extend one. The engine type-checks plugins at registration time.
2. **Engine never imports from plugin directories** — `core/` has zero imports from `sources/`, `ai/`, `outputs/`. All wiring happens in adapters, `src/app/`, or user code.
3. **Fluent builder API** — `engine.addSource().useAI().addOutput().useCache().configure()` — all chainable, all return `this`.
4. **Pipeline flow** — `Fetch → Ledger dedup → (drip scans only) story-coverage exclusion → Middleware (tech relevance → scoring → semantic dedup) → AI Summarize → Sequential output delivery`. Middleware is `(articles) => articles` transform functions injected via `.use()`; outputs are claimed and committed one at a time, never in parallel. The dashboard app puts its `notBefore` cutover filter ahead of the tech gate.
5. **Zero external dependencies for core parsing** — RSS/HTML parsers use regex, no cheerio/xml2js. This keeps it Cloudflare Worker compatible.
6. **AI prompt system** — `_prompts.js` exports `buildPrompt()` which generates a `{system, user}` pair from language (`vi`/`en`), style, audience, and platform. A per-channel `customSystemPrompt` replaces only the style section; the output-language, source-data, and platform rules always stay. All AI plugins consume this.
7. **Presets are just factory functions** — they return `SourcePlugin[]` arrays. Users spread them into `.addSource()`.
8. **The dashboard app reuses the engine, unchanged** — stored channels are built into the `defineChannels()` shape and run through `runChannels()`/`buildEngine()`; controls call the CLI's `executeRecoveryControl()`; the Worker's `SQLiteDeliveryStore` runs on `node:sqlite` through `createNodeSqlStorage()`.
9. **Dashboard security** — Cloudflare Access JWT verified on every request except `GET /healthz` (no bypass); `viewer`/`operator` roles from env; mutations need operator + exact `PUBLIC_ORIGIN` + JSON + bounded body; secrets are write-only; every channel starts paused; one instance via a SQLite lease.

## Plugin Contracts

### SourcePlugin (sources must implement)
```
get id → string
get name → string  
get icon → string (emoji, default '📰')
fetch({ limit?, since?, config? }) → Promise<Article[]>
```

### Article Schema (all sources must return this)
```
{ id, title, url, content, source, category?, author?, publishedAt?, meta? }
```

### AIPlugin (AI providers must implement)
```
get id → string
get name → string
summarize(articles, { language?, style?, audience?, platform?, customSystemPrompt?, systemPrompt?, maxTokens?, signal? }) → Promise<{ text, usage?, model? }>
```

### OutputPlugin (outputs must implement)
```
get id → string
get name → string
get maxLength → number (default Infinity)
send(content, options?) → Promise<{ success, messageId?, error?, meta? }>
```

### CachePlugin (caches must implement)
```
get(key) → Promise<string|null>
set(key, value, ttlMs?) → Promise<void>
has(key) → Promise<boolean>
delete(key) → Promise<void>
```

## Code Conventions

- **ES Modules only** — all files use `import/export`, `"type": "module"` in package.json
- **No TypeScript** — plain JS with JSDoc annotations for types. The one exception is `web/` (React + Vite + TypeScript, `strict`)
- **No build step** — runs directly via Node 18+ or Cloudflare Workers; only the dashboard UI in `web/` is built (Vite → `web/dist`). The dashboard app needs Node ≥22.13
- **Naming**: plugins use PascalCase class names, factory helpers use camelCase (`groq()`, `ollama()`); files are kebab-case
- **Config injection** — plugins receive config in constructor, store as `this._config`
- **Error handling** — fetch operations use try/catch and return empty arrays on failure rather than throwing. AI and output plugins throw on failure (engine catches).
- **Concurrency** — engine batches source fetches by `options.concurrency`, uses `Promise.allSettled`, 500ms delay between batches
- **Secrets** — never print, log, or commit environment values or secrets (no `printenv`/`env`, no `docker compose config` without `--no-env-resolution`); dashboard credentials are write-only
- **UI** — Vietnamese text (technical terms in English); CSP-safe: no inline scripts or runtime `<style>` injection, no `dangerouslySetInnerHTML`, external links with `rel="noopener noreferrer"`

## Working With This Codebase

### Adding a new source plugin

1. Create `src/sources/my-source.js`
2. Export a class extending `SourcePlugin`
3. Implement `get id`, `get name`, `async fetch(options)`
4. `fetch()` must return `Article[]` matching the schema
5. Export from `src/sources/index.js`
6. Optionally add to a preset in `src/presets/index.js`
7. To offer it as a typed source in the dashboard, add it to `TYPED_SOURCES` in `src/app/channels/source-factories.js` and its field spec in `src/app/api/meta-routes.js` (`tests/app/api-meta.test.js` checks they agree)

### Adding a new AI provider

1. If OpenAI-compatible API → add a new factory helper in `openai-compat.js` + register in `create-ai.js`
2. If custom API → create `src/ai/my-ai.js`, extend `AIPlugin`, implement `summarize()`
3. Use `buildPrompt()` from `_prompts.js` for consistent prompt formatting (supports `audience` and `customSystemPrompt`)
4. Export from `src/ai/index.js`
5. Add provider to `createAI()` switch in `src/ai/create-ai.js` (shared factory used by all adapters)
6. For the dashboard, add it to `AI_PROVIDERS` (and its credential policy in `aiCredentialRequirements()`) in `src/app/channels/config-schema.js`; `/api/meta` serves the list to the UI

### Adding a new output channel

1. Create class extending `OutputPlugin` in `src/outputs/channels.js` or new file
2. Implement `get id`, `get name`, `get maxLength`, `async send(content)`
3. Engine auto-truncates content to `maxLength` before calling `send()`
4. If the output has message size limits (Telegram 4096, Discord 2000), implement splitting inside `send()`
5. Export from `src/outputs/index.js`
6. The dashboard app manages Telegram channels only; other outputs run through the CLI or the Worker

### Adding a new prompt style

1. Edit `src/ai/_prompts.js`
2. Add entry to `STYLES` object: `myStyle: { vi: (audience) => '...', en: (audience) => '...' }`
3. Use via `engine.configure({ style: 'myStyle' })`; the dashboard lists it automatically (`PROMPT_STYLES` → `/api/meta`)
4. Available built-in styles: `digest`, `bullet`, `thread`, `newsletter`, `weekly`, `mustread`

### Using content intelligence middlewares

```js
import { createTechRelevanceMiddleware, createScoringMiddleware, createSemanticDedupMiddleware } from './src/core/index.js';

engine
  .use(createTechRelevanceMiddleware())                // Keep only technology-relevant articles
  .use(createScoringMiddleware({ maxArticles: 20 }))   // Score & rank
  .use(createSemanticDedupMiddleware({ threshold: 0.65 })); // Remove cross-source duplicates
```

Category grouping is automatic in `buildPrompt()` when articles have mixed categories.

### Modifying the pipeline

The engine pipeline in `engine.js` (`run()` for digest mode, `runDrip()` for radar scans) is:
```
1. Resolve or create the delivery record for this request (dedup against in-flight/completed deliveries)
2. _fetchAllDetailed() — batched fetch from all sources (with retry)
3. _dedup() — filter via the delivery ledger and legacy compatibility data
4. (drip scans only) exclude articles covering a story already delivered in the current/previous publishing day
5. middlewares — tech relevance gate → scoring → semantic dedup → any custom `.use()` transforms (the app prepends its notBefore filter)
6. ai.summarize() — with audience context, grouped articles (throws if no AI is configured)
7. output.send() — one output at a time, in configured topology order; each result is committed durably before the next output starts
8. mark the article/delivery state as terminal on completion
```

Shared modules (`src/core`, `src/ai`, `src/channels`) also run in the Worker: keep changes backward compatible and `npm run test:workers` green. Do not change `src/adapters/cloudflare*.js` or `wrangler*.toml` without an explicit request.

### Adding a new preset

1. Edit `src/presets/index.js` — add factory function returning `SourcePlugin[]`
2. Register it in `PRESET_FACTORIES` in `src/app/channels/source-factories.js` (`tests/app/source-factories.test.js` fails until every exported preset is registered); the dashboard lists it through `/api/meta`
3. Export from `src/presets/index.js`
4. Available presets: `bigTechBlogs`, `communitySources`, `aiMLBlogs`, `aiNewsSources`, `aiDeepDiveSources`, `devopsSources`, `mobileSources`

### Working on the dashboard app

- Routes: reads use `guards.viewer`; every mutation uses `guards.mutation()` (operator, same origin, JSON, body limit). Take the actor from `req.auth.actor`, never from the body.
- Schema: add a new entry to `APP_MIGRATIONS` in `src/app/db/app-migrations.js`; never edit an applied one (a `VACUUM INTO` backup runs first).
- Responses go through allowlist projections (`src/app/api/redaction.js`); provider text through `sanitizeRuntimeError()`.
- Tests: `tests/app/helpers/` starts the real app with fake plugins (`startTestApp`) or a runtime fixture (`createRuntimeFixture`); production code has no test flags.

### Testing locally

```bash
# Test suites (all offline)
npm test                 # Node + Workers
npm run test:web         # dashboard typecheck + unit tests (after npm run web:install)
npx playwright install chromium   # once
npm run test:e2e         # builds web/dist, Playwright against the real app on 127.0.0.1:4310

# CLI preview — fetch + summarize, no sending
node src/adapters/node.js preview
node src/adapters/node.js preview --channel telegram-main

# CLI force (explicit operator, reason, and duplicate-risk acknowledgement)
node src/adapters/node.js run --force --channel telegram-main --idempotency-key <key> \
  --operator-id <key-id> --reason "<why>" --confirm-duplicate-risk

# Test individual preset fetch
node -e "
import { aiNewsSources } from './src/presets/index.js';
for (const src of aiNewsSources()) {
  const a = await src.fetch({ limit: 2 });
  console.log(src.name, '—', a.length, 'articles');
}
"

# Dashboard app (development; README "Run the dashboard locally" has the details)
export ACCESS_TEAM_DOMAIN=https://dev-access.content-radar.invalid ACCESS_AUD=content-radar-dev
export DEV_ACCESS_TOKEN="$(npm run -s dev:token -- --email you@example.com)"
NODE_ENV=development ACCESS_JWKS_FILE=.cache/dev-access/jwks.json APP_OPERATOR_EMAILS=you@example.com \
  PUBLIC_ORIGIN=http://localhost:5173 DATA_DIR=.cache/app-data CACHE_PATH=.cache/app-data/news.json \
  npm run app:dev        # APP_MASTER_KEY from .env; npm run dashboard is an alias of npm run app
npm run web:dev          # second terminal, same DEV_ACCESS_TOKEN; http://localhost:5173

# App image (Compose service news-engine, volume data, 127.0.0.1:3000)
npm run docker:build && npm run docker:run

# Cloudflare dev mode
npx wrangler dev
# Then: curl http://localhost:8787/health
```

## File-Level Reference

| File | Exports | Notes |
|------|---------|-------|
| `core/contracts.js` | `SourcePlugin`, `AIPlugin`, `OutputPlugin`, `CachePlugin` | Abstract base classes |
| `core/engine.js` | `ContentRadar` | Main orchestrator — digest + drip radar scanning, retry, durable delivery |
| `core/caches.js` | `MemoryCache`, `FileCache`, `CloudflareKVCache`, `RedisCache` | All extend CachePlugin |
| `core/scoring.js` | `createScoringMiddleware()` | Engagement + recency + credibility scoring |
| `core/semantic-dedup.js` | `createSemanticDedupMiddleware()` | Bigram title similarity dedup |
| `core/tech-relevance.js` | `TRUSTED_TECH_CATEGORIES`, `createTechRelevanceMiddleware()`, `scoreTechRelevance()` | Topic filter gating technology relevance, not a trust boundary |
| `core/story-dedup.js` | `storySignature()`, `isSameStory()`, `excludeCoveredStories()`, `pickDistinctStories()` | Deterministic cross-source story dedup for radar scans |
| `core/grouping.js` | `groupByCategory()` | Groups articles by category for structured prompts |
| `sources/rss.js` | `RSSSource`, `createRSSSources()`, `cleanHTML()` | Zero-dep XML parsing; `maxResponseBytes` raises the 2 MiB response cap (at most 8 MiB) for feeds that embed full post text; `cleanHTML(html, { escapedMarkup })` also strips tags that arrive escaped (`&lt;p&gt;`) in article bodies |
| `sources/html-scraper.js` | `HTMLScraperSource` | Regex-based HTML extraction |
| `sources/hackernews.js` | `HackerNewsSource` | Algolia API, configurable minPoints |
| `sources/reddit.js` | `RedditSource` | JSON API with subreddit + minUpvotes; Reddit returns 403 to unauthenticated `.json` requests (checked 2026-10-04), so `aiNewsSources()` reads Reddit through one RSS source (`top.rss`, no scores, links to the thread) |
| `sources/devto.js` | `DevToSource`, `JSONAPISource` | Dev.to API + generic JSON adapter |
| `sources/github-trending.js` | `GitHubTrendingSource` | GitHub Search API, recently active popular repos |
| `ai/claude.js` | `ClaudeAI` | Anthropic native `/v1/messages` endpoint |
| `ai/openai-compat.js` | `OpenAICompatibleAI`, `openai()`, `groq()`, `gemini()`, `ollama()`, `openRouter()`, `togetherAI()` | One class, many providers |
| `ai/create-ai.js` | `createAI()` | Shared factory for all adapters |
| `ai/_prompts.js` | `buildPrompt()`, `PROMPT_STYLES`, `PROMPT_LANGUAGES` | Editorial prompts with audience, grouping, 6 styles, `vi`/`en`, custom system prompt |
| `outputs/telegram.js` | `TelegramOutput` | Auto-split, markdown fallback |
| `outputs/channels.js` | `SlackOutput`, `DiscordOutput`, `EmailOutput`, `WebhookOutput`, `MarkdownFileOutput` | All extend OutputPlugin |
| `presets/index.js` | `bigTechBlogs()`, `communitySources()`, `aiMLBlogs()`, `aiNewsSources()`, `aiDeepDiveSources()`, `devopsSources()`, `mobileSources()` | Return SourcePlugin[] |
| `channels/runner.js` | `buildEngine()`, `runChannels()`, `createDefaultMiddlewares()`, `listUnresolvedTargets()`, `sanitizeRuntimeError()`, `shouldRun()` | Shared by the CLI and the dashboard app |
| `adapters/cloudflare.js` | default export (Worker) | Thin wrapper: creates engine from env |
| `adapters/node.js` | CLI entry point, `executeRecoveryControl()`, `preview()` | Commands: run, cron, preview, recovery |
| `app/server.js` | `startServer()` | App process: startup order, SIGTERM handling, shutdown wait |
| `app/create-app.js` | `createApp()` | Express pipeline: headers, `/healthz`, Access JWT, roles, routes, static UI |
| `app/config/env.js` | `loadAppConfig()`, `AppConfigError` | Every app env variable and its rule |
| `app/auth/access-jwt.js` | `createAccessVerifier()`, `createAccessKeySet()`, `readAccessToken()` | RS256, issuer, AUD, exp; header `Cf-Access-Jwt-Assertion` only |
| `app/auth/roles.js` | `createRoleResolver()`, `identityFromClaims()`, `actorFor()` | Email or service-token client ID → viewer/operator |
| `app/db/node-sql-storage.js` | `createNodeSqlStorage()` | Durable Object SQL surface over `node:sqlite` |
| `app/db/app-migrations.js` | `APP_MIGRATIONS`, `runAppMigrations()`, `backupBeforeDeliveryStoreUpgrade()` | Append-only app schema, `VACUUM INTO` backups |
| `app/db/runtime-lease.js` | `RuntimeLease` | Single-instance lease |
| `app/secrets/vault.js` | `SecretVault`, `parseMasterKey()` | AES-256-GCM, key fingerprint check |
| `app/secrets/credential-repository.js` | `CredentialRepository` | Write-only credentials |
| `app/channels/config-schema.js` | `validateChannelConfig()`, `AI_PROVIDERS`, `LIMIT_RANGES` | One validation step for API input, stored rows, and the seed |
| `app/channels/source-factories.js` | `PRESET_FACTORIES`, `SOURCE_TYPES`, `createSourcePlugins()` | Preset registry and typed sources |
| `app/channels/build-channel.js` | `buildChannelFromConfig()` | Stored channel + credentials → `defineChannels()` shape |
| `app/channels/seed.js` | `seedDefaultChannels()`, `telegramMainSeedConfig()` | Paused `telegram-main` with the Worker's production settings |
| `app/runtime/create-runtime.js` | `createRuntime()` | Service the API calls: channels, credentials, runs, preview, controls, status, library, stats |
| `app/runtime/scheduler.js` | `RuntimeScheduler` | Per-channel cron in its timezone, one global queue, lease gating, shutdown wait |
| `app/runtime/controls.js` | `ChannelControls`, `CONTROL_ACTIONS` | Pause/resume and recovery actions through `executeRecoveryControl()` |
| `app/runtime/not-before.js` / `cutover-guard.js` | `createNotBeforeMiddleware()` / `assertCutoverReady()` | Cutover cutoff filter and the `cutoverRequired` guard |

## Environment Variables

```
# CLI / Worker (depends on which plugins you use)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GROQ_API_KEY=
CACHE_TYPE=file          # file | redis | memory (CLI)
CACHE_PATH=.cache/news.json
REDIS_URL=redis://localhost:6379
CRON_SCHEDULE=0 7 * * *  # 7:00 UTC = 14:00 VN
SUMMARY_LANGUAGE=vi
MAX_ARTICLES_PER_SOURCE=3
CONCURRENCY_LIMIT=5
DRIP_DAILY_LIMIT=18      # Telegram radar's daily article limit; other channels use fixed limits

# Dashboard app (rules in src/app/config/env.js; channel secrets are entered in the UI, not env)
DATA_DIR=                # content-radar.db, backups/, cache (/data in Docker)
APP_MASTER_KEY=          # base64 of 32 random bytes; keep a copy in a password manager
ACCESS_TEAM_DOMAIN=      # https://<team>.cloudflareaccess.com
ACCESS_AUD=              # Access application AUD tag(s)
APP_OPERATOR_EMAILS=
APP_VIEWER_EMAILS=
APP_SERVICE_TOKEN_ROLES= # <client-id>:operator|viewer
PUBLIC_ORIGIN=           # exact origin users open
CONTENT_SCAN_RETENTION_DAYS=30
RUN_HISTORY_RETENTION_DAYS=180
SHUTDOWN_WAIT_SECONDS=120   # container stop grace ≥ this + 15 s
ACCESS_JWKS_FILE=        # development only; needs NODE_ENV=development or test
```

The app also loads `.env`; give it its own `CACHE_PATH` inside `DATA_DIR` rather than the CLI cache file.

## Dependencies

### Required
- `node-cron` — cron scheduling for the CLI daemon and the dashboard scheduler
- `express` — dashboard app server
- `jose` — Cloudflare Access JWT verification

### Optional  
- `dotenv` — .env file loading
- `redis` — only if using RedisCache
- `wrangler` — only for Cloudflare Workers deployment (dev dependency)
- `@playwright/test` — browser E2E suite (dev dependency); the UI's own dependencies live in `web/package.json`

### Zero deps for core
The core engine, all source parsers, AI clients, and output senders use only `fetch()` (native in Node 18+, CF Workers, Bun, Deno).
