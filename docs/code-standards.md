# Code Standards

## Runtime Baseline

- Use ES modules only.
- Target Node.js `>=18` for the CLI and core engine.
- The dashboard app (`src/app/`) needs Node.js `>=22.13` for `node:sqlite`; the Docker image runs Node 24. Use only `node:sqlite` APIs available in both.
- Avoid a build step for runtime code. The one exception is the dashboard UI in `web/`, which Vite builds to `web/dist`.
- Keep core behavior runnable with native `fetch()` only.

## Languages

- Backend, engine, plugins, scripts, and tests are plain JavaScript with JSDoc types. No TypeScript there.
- **Exception:** `web/` is React + Vite + TypeScript with `strict` on. It has its own `package.json`; `npm run test:web` runs `tsc -b` and Vitest. The exception does not extend to anything outside `web/`.

## Naming

| Element | Convention | Example |
|---|---|---|
| Files | `kebab-case` | `openai-compat.js`, `channel-edit-page.tsx` |
| Classes | PascalCase | `ContentRadar`, `TelegramOutput` |
| Factories | `camelCase` | `groq()`, `buildPrompt()` |
| Private fields | `_` prefix | `this._config` |
| Internal helper files | `_` prefix | `_prompts.js` |
| Node tests | `*.test.js` | `tests/app/api-auth.test.js` |
| Browser E2E specs | `*.e2e.js` (never `*.test.js`, which the Node runner collects) | `tests/e2e/dashboard-flow.e2e.js` |

## Plugin Contracts

Every plugin extends one of the four base classes in `src/core/contracts.js`.

```javascript
class MySource extends SourcePlugin {
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return 'my-source'; }
  get name() { return 'My Source'; }
  async fetch(options = {}) { /* return Article[] */ }
}
```

Rules:

- source plugins return no more than the requested bounded `Article[]` and propagate the supplied AbortSignal through all provider I/O
- AI plugins summarize the exact bounded article selection they receive, honor the supplied AbortSignal, and return `{ text, usage?, model? }`
- output plugins honor operation identity, bounded article snapshots, AbortSignal, and `singleMutation`, then return a classified `SendResult` object
- cache plugins must support `get`, `set`, `has`, and `delete`
- output plugins expose a stable `deliveryKey`; set `supportsSingleMutation=true` only when one call can guarantee at most one provider mutation

### Plugin Operation Context

- `signal` is the engine-owned operation deadline. Source, AI, and output plugins must pass it to provider requests and response readers, stop retry/sleep loops, and settle promptly after abort.
- `requestId`, `deliveryId`, and `attemptId`, when supplied, are opaque durable correlation identities. Use `attemptId` as a provider idempotency key when the provider supports it; never parse identities or use them as credentials.
- AI receives an engine-selected bounded article set. Real delivery/recovery output calls receive the durable projected `articles` snapshot and, for drip mode, the matching `article` view. Plugins treat snapshots as read-only and must not refetch content to expand them.
- `singleMutation=true` is an output-only safety contract: no splitting, fallback, or internal retry may issue a second provider mutation. A plugin that cannot guarantee this must fail before mutation; `supportsSingleMutation` must remain false.
- Abort is cooperative and cannot undo provider work already accepted. A non-cooperative provider-side late completion cannot be cancelled or committed after the engine deadline; it remains conservatively ambiguous and blocks automatic resend until operator reconciliation.
- Canonical output results classify `meta.deliveryState` as `success`, `definitive_failure`, or `ambiguous`, and `meta.retryDisposition` as `automatic`, `manual`, or `never`. Legacy/unclassified failures fail closed as ambiguous/manual; the state machine alone decides retry behavior.

## Reliability Rules

| Layer | Standard |
|---|---|
| Source fetch | Honor the operation signal; catch failures and return an empty result or bounded diagnostic failure instead of throwing |
| Source diagnostics | Prefer bounded diagnostics over silent failures |
| AI summarize | Honor the operation signal and exact bounded selection; throw on failure so the engine can classify the durable attempt |
| Output send | Honor signal and single-mutation policy; throw or return a classified result, with timeout/unknown completion treated as ambiguous |
| Delivery store | Use synchronous transactions only; do not perform external I/O inside a transaction |
| Durable queries | Use allowlisted `query`/`count` filters and bounded indexed pages on hot paths; reserve full-table iteration for compatibility tooling only |
| Local lock upgrade | Stop and drain every older process sharing the store before stale canonical-lock conversion; never perform this compatibility migration during a rolling mixed-version start |
| Output order | Sequential, not parallel; commit each attempt before the next call |
| Retry handling | Respect `deliveryState` and `retryDisposition`; do not invent extra semantics |
| App schema | Add app tables and columns only through a new entry in `APP_MIGRATIONS` (append-only; never edit an applied entry); migrations run after a `VACUUM INTO` backup |

## Concurrency And State

- Source fetches are batched by channel concurrency with a short delay between batches.
- Channels run sequentially in the runner to avoid resource contention; the dashboard app runs one channel at a time through one global queue.
- The Node CLI uses one owned file store per process.
- The dashboard app keeps the delivery store and its own tables in one SQLite file, written only by the instance holding the runtime lease (pause is the one control allowed without it).
- The SQLite delivery store keeps domain records in physical tables with a migration ledger (`news_schema_migrations`) and materialized hot-query columns.
- `MemoryCache` is acceptable for tests and dry-run preview, but not for output-capable paths.
- Preview is read-only for delivery state, not a no-op AI path.
- Retention must preserve unresolved references and compact idempotency/safety tombstones before removing bulky terminal detail.

## Security And Redaction

- Treat article text, URLs, and metadata as untrusted input.
- Redact secrets, private URLs, and large opaque values from status and error surfaces.
- Never print, log, or commit environment values or secrets. Configuration errors name the variable and the rule, never the value. Avoid commands that print resolved environments (`printenv`, `env`, `docker compose config` without `--no-env-resolution`, `docker inspect` environment output).

### Dashboard App Backend

- Every request except `GET /healthz` verifies the Cloudflare Access JWT; never add an authentication bypass or trust identity headers without a verified token.
- Every API response sends `Cache-Control: no-store`. Every mutation needs the `operator` role, the exact `PUBLIC_ORIGIN` as `Origin`, `Content-Type: application/json`, and a bounded body.
- The audit actor (`operatorId`, `updatedBy`) always comes from the authenticated identity, never from a request body.
- Secrets are write-only: the credential store offers create, replace, delete, and metadata. Plaintext is resolved only when a channel is built for a run, preview, or control, and it never reaches responses, logs, events, runs, or the library.
- Project responses through allowlists (`src/app/api/redaction.js`) so new internal fields never leak by default; sanitize provider text with `sanitizeRuntimeError()`.
- New channels start paused, and nothing may create an unpaused channel.

### Dashboard UI (`web/`)

- The UI is in Vietnamese; keep technical terms (cron, preview, queue, provider names) in English.
- Stay inside the Content Security Policy: no inline scripts, no runtime `<style>` injection (no CSS-in-JS that writes styles at run time; Tailwind is compiled at build time), no `style=` attributes, and no remote assets. Everything is bundled.
- Never render raw HTML from articles or AI output (`dangerouslySetInnerHTML` is not used). External links go through `ExternalLink`: http(s) only, `target="_blank"`, `rel="noopener noreferrer"`.
- Keep nothing sensitive in `localStorage` or `sessionStorage`; credential inputs are password fields that are never pre-filled.
- The server decides permissions; the UI only hides or disables controls for viewers. Enumerations and bounds come from `GET /api/meta`, not from a copy in the UI.
- Keep one bundle (no lazily loaded route chunks), so a tab opened before a redeploy does not request chunks that no longer exist.

## Configuration

- Read environment variables in the runtime entry layer (`src/adapters/node.js` for the CLI, `src/app/config/env.js` for the dashboard app); `defineChannels()` receives the environment as an argument instead of reading `process.env`.
- Pass config objects downward into channels and plugins.
- Keep runtime defaults in checked-in code and config, not in ad hoc shell state.
- `DELIVERY_STORE_TYPE=file` is the only local delivery-store mode for the CLI.
- Derive an output's `deliveryKey` from its destination (`destinationDeliveryKey()` in `src/outputs/telegram-client.js`), never from a logical channel label alone.

## Testing And Verification

- Run the narrowest useful test first.
- `npm test` runs the Node suite, `npm run test:node` (every `tests/**/*.test.js`).
- `npm run test:web` typechecks the dashboard and runs its Vitest unit tests.
- `npm run test:e2e` builds `web/dist` and runs the Playwright specs in `tests/e2e/` against the real app on `127.0.0.1:4310`; run `npx playwright install chromium` once first.
- Tests run offline. Node tests load `tests/helpers/deny-network.js`; the E2E harness refuses non-loopback connections. Inject fakes through the existing seams (`channelFactories`, `keySet`, `cron`, `timers`, `clock`); production code has no test flags.
- Use `node --check` on touched runtime files when the change affects execution paths.
- Verify docs against source before publishing them.
- Prefer preserving behavior and fixing the contract rather than weakening tests.
