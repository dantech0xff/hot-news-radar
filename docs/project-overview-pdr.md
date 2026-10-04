# Project Overview - Content Radar

## Summary

Content Radar is a plugin-based engine that actively scans technology content from swappable sources, filters it for technology relevance, summarizes it with a configurable AI provider, and sends the result through swappable outputs. The current implementation is delivery-state driven: content generation, output sending, recovery, and maintenance replay all flow through a durable state machine.

The production runtime is the dashboard app: one Node process (React dashboard, API, scheduler, SQLite) deployed on Dokploy and served by Dokploy's Traefik behind Cloudflare Access, where operators manage Telegram channels without redeploying. It has been the only engine posting since the cutover on 2026-10-03; the previous runtime, a Cloudflare Worker, was deleted on 2026-10-04.

## Product Goal

Actively scan and deliver curated technology content that is:

- configurable by source, model, output, schedule, and audience
- filtered for technology relevance before it reaches AI summarization or an output channel
- safe to retry after crashes, timeouts, or partial provider mutation
- observable and operable through the dashboard and the CLI
- runnable on Node.js, as the CLI or as the dashboard app in Docker, on one unchanged core engine

## In Scope

| Area | Requirement |
|---|---|
| Source ingestion | RSS, HTML scrape, Hacker News, Reddit, Dev.to, GitHub trending, and generic JSON sources |
| AI summarization | Claude or OpenAI-compatible providers selected by config |
| Delivery | Telegram, Facebook, Slack, Discord, Email, webhook, and file outputs (the dashboard app manages Telegram channels only) |
| Reliability | Durable claim/call/commit flow, sequential outputs, retry classification, operator recovery |
| Runtime | Node CLI and the Node dashboard app |
| Administration | Dashboard: channel configuration, write-only secrets, operations, content library, statistics |
| Maintenance | Legacy compatibility replay remains separate from authoritative delivery |

## Product Requirements

### Functional

1. A run must collect articles, apply middleware, summarize with AI, and send to configured outputs.
2. Output attempts must be processed sequentially and committed durably before the next output begins.
3. A crash, timeout, or ambiguous provider result must leave recoverable state instead of silently dropping work.
4. `run` bypasses cron gating; `cron` and `daemon` use the configured per-channel schedules.
5. `preview` is read-only and must not mutate delivery state.
6. Operator recovery must be idempotent and versioned.
7. Drip mode must preserve queue state across days and re-scan sources for new content whenever the batch has open slots, the channel's daily limit is not reached, and a scan is due; a failed scan must back off without blocking items already queued.
8. Every collected article must pass a technology-relevance gate — a topic filter, not a trust boundary — before AI summarization; radar scans read posts from the last 48 hours and must also skip articles covering a story already delivered to the channel in the current publishing day or the two before it.
9. The dashboard app must let operators add, edit, enable/disable, and delete Telegram channels without a redeploy: sources, AI provider and model, prompt (language, style, audience, custom system prompt that keeps the safety rules), cron and timezone, mode, and limits.
10. Channel secrets (bot token, chat ID, AI key, AI Gateway token) are entered in the dashboard, encrypted at rest with the master key, and write-only: the dashboard only shows whether a value is set.
11. Operators can see channel status, queue, run history with per-source health, and unresolved items, and can run now, preview, pause, resume, and apply the recovery actions the state machine allows.
12. The content library lists scanned and posted articles (title, source, link, AI summary, status, rejection reason, message ID) with filters and paging; posted articles are kept forever.
13. Statistics show posts per day and channel, source health over time, AI and output failure rates, and token usage.
14. Every dashboard channel starts paused, and the seeded `telegram-main` cannot deliver until its cutover instant (`notBefore`) is set; articles published before it are never posted.

### Non-Functional

1. Node.js runtime `>=18` for the CLI and core; Node.js `>=22.13` for the dashboard app (`node:sqlite`).
2. No build step for core execution; only the dashboard UI (`web/`, the one TypeScript package) is built.
3. Persistent delivery storage is required for any output-capable command.
4. Public status and recovery surfaces must redact secrets, private URLs, and generated content.
5. The dashboard app verifies the Cloudflare Access JWT on every request except `/healthz`, has no authentication bypass, maps identities to `viewer` or `operator`, and refuses to start on invalid configuration without echoing values.
6. Rollout to production remains approval-gated: every push to `master` deploys, so changes merge through pull requests with the tests green, and two engines are never active on the same chat.
7. The SQLite delivery store's hot paths must use indexed physical domain tables; permanent replay/suppression tombstones must not retain article bodies, generated content, or raw operator reasons.
8. The dashboard app runs as one instance (runtime lease plus a `stop-first` update order) and backs up its database before every schema migration.

## Current Runtime Model

| Runtime | Storage | Notes |
|---|---|---|
| Node CLI | `LocalFileDeliveryStore` + file cache | Single-process, owned local state file; channels from environment variables |
| Dashboard app (`src/app/`) | `SQLiteDeliveryStore` on `node:sqlite` + app tables + file cache, one database in `DATA_DIR` | Channels and encrypted credentials in SQLite; Access JWT with `viewer`/`operator` roles; scheduler behind a runtime lease. Production engine on Dokploy since the 2026-10-03 cutover |

The SQLite delivery store uses physical domain tables plus `news_schema_migrations`. Bulky terminal delivery data is removed after 30 days, ordinary request detail after 90 days, and operator audit data is minimized/compacted while unresolved records and permanent idempotency/safety tombstones remain. The dashboard app copies deliveries into its content library before that compaction.

## Acceptance Criteria

- AI generation is required for preview and delivery runs.
- Outputs are attempted sequentially with durable acknowledgement between calls.
- Source failures are diagnosed separately from genuine empty feeds.
- `MemoryCache` is not a production output-path store.
- Community-sourced articles (Hacker News, and Reddit through its JSON source) keep their original external link, while the AI news preset's Reddit RSS source links to the Reddit thread; the technology-relevance gate filters by topic only, not link safety (accepted risk).
- `preview` never applies the drip daily limit or story-coverage exclusion.
- Dashboard: requests without a valid Access JWT get 401 (only `/healthz` is open); viewers cannot change anything (403); every change needs the exact public origin and a JSON body.
- Dashboard: credential values never appear in responses, events, runs, the library, or logs.
- Dashboard: preview sends nothing and changes no delivery state; `telegram-main` cannot resume, run, or retry an output before `notBefore` is set.
- Dashboard: the browser E2E suite covers credentials, channel creation (paused), prompt and AI edits, preview, resume and run, the library, statistics, pause/resume, the viewer role, and unauthenticated access.

## Rollout Policy

Every dashboard channel starts paused and resumes only through an audited operator action, after its credentials are entered. Rollback is pause-first: pause the channel, then revert the code, and restore the database from its pre-migration snapshot only when the earlier build cannot open it. There is no second engine to fall back to. See `docs/deployment.md`.

## Success Metrics

- Tests pass offline without live provider calls
- Docs match the current runtime and config surface
- Recovery commands are exact, versioned, and idempotent
- Protected routes remain redacted and no-store
- Production rollout stays behind explicit approval gates
- The dashboard app posts on each channel's schedule, and nothing published before a channel's cutover instant (`notBefore`) is posted
