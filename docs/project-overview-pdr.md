# Project Overview - Content Radar

## Summary

Content Radar is a plugin-based engine that actively scans technology content from swappable sources, filters it for technology relevance, summarizes it with a configurable AI provider, and sends the result through swappable outputs. The current implementation is delivery-state driven: content generation, output sending, recovery, and maintenance replay all flow through a durable state machine.

The primary runtime is the dashboard app: one Node process (React dashboard, API, scheduler, SQLite) deployed on Dokploy and served by Dokploy's Traefik behind Cloudflare Access, where operators manage Telegram channels without redeploying. Since the cutover on 2026-10-03 the Cloudflare Worker's channel is paused and the Worker is kept for rollback.

## Product Goal

Actively scan and deliver curated technology content that is:

- configurable by source, model, output, schedule, and audience
- filtered for technology relevance before it reaches AI summarization or an output channel
- safe to retry after crashes, timeouts, or partial provider mutation
- observable and operable through the Worker, the CLI, and the dashboard
- deployable on Node.js (CLI, or the dashboard app in Docker) or Cloudflare Workers without changing the core engine

## In Scope

| Area | Requirement |
|---|---|
| Source ingestion | RSS, HTML scrape, Hacker News, Reddit, Dev.to, GitHub trending, and generic JSON sources |
| AI summarization | Claude or OpenAI-compatible providers selected by config |
| Delivery | Telegram, X, Facebook, Threads, Slack, Discord, Email, webhook, and file outputs (the dashboard app manages Telegram channels only) |
| Reliability | Durable claim/call/commit flow, sequential outputs, retry classification, operator recovery |
| Runtime | Node CLI, Cloudflare Worker, and the Node dashboard app |
| Administration | Dashboard: channel configuration, write-only secrets, operations, content library, statistics |
| Maintenance | Legacy compatibility replay and token-maintenance remain separate from authoritative delivery |

## Product Requirements

### Functional

1. A run must collect articles, apply middleware, summarize with AI, and send to configured outputs.
2. Output attempts must be processed sequentially and committed durably before the next output begins.
3. A crash, timeout, or ambiguous provider result must leave recoverable state instead of silently dropping work.
4. `run` bypasses cron gating; `cron` and `daemon` use the configured per-channel schedules.
5. `preview` is read-only and must not mutate delivery state.
6. Cloudflare manual trigger, force, canary, and recovery routes must use distinct trigger/operator authority.
7. Operator recovery must be idempotent and versioned.
8. Drip mode must preserve queue state across days and re-scan sources for new content whenever the batch has open slots, the channel's daily limit is not reached, and a scan is due; a failed scan must back off without blocking items already queued.
9. Every collected article must pass a technology-relevance gate — a topic filter, not a trust boundary — before AI summarization; radar scans must also skip articles covering a story already delivered to the channel in the current or previous publishing day.
10. Aggregate status must expose a durable last-request pointer, source/queue/unresolved warnings, and paginated redacted records; exact request status must remain pollable after retention compaction.
11. The dashboard app must let operators add, edit, enable/disable, and delete Telegram channels without a redeploy: sources, AI provider and model, prompt (language, style, audience, custom system prompt that keeps the safety rules), cron and timezone, mode, and limits.
12. Channel secrets (bot token, chat ID, AI key, AI Gateway token) are entered in the dashboard, encrypted at rest with the master key, and write-only: the dashboard only shows whether a value is set.
13. Operators can see channel status, queue, run history with per-source health, and unresolved items, and can run now, preview, pause, resume, and apply the recovery actions the state machine allows.
14. The content library lists scanned and posted articles (title, source, link, AI summary, status, rejection reason, message ID) with filters and paging; posted articles are kept forever.
15. Statistics show posts per day and channel, source health over time, AI and output failure rates, and token usage.
16. Every dashboard channel starts paused, and the seeded `telegram-main` cannot deliver until its cutover instant (`notBefore`) is set; articles published before it are never posted.

### Non-Functional

1. Node.js runtime `>=18` for the CLI and core; Node.js `>=22.13` for the dashboard app (`node:sqlite`); Node.js `>=22` for the pinned Workers development/test toolchain.
2. No build step for core execution; only the dashboard UI (`web/`, the one TypeScript package) is built.
3. Persistent delivery storage is required for any output-capable command.
4. Public status and recovery surfaces must redact secrets, private URLs, and generated content.
5. The dashboard app verifies the Cloudflare Access JWT on every request except `/healthz`, has no authentication bypass, maps identities to `viewer` or `operator`, and refuses to start on invalid configuration without echoing values.
6. Rollout to production remains approval-gated; quiesce and bootstrap artifacts are staged, not casual deploy targets, and the Worker and the dashboard app are never active on the same chat.
7. Cloudflare hot paths must use indexed physical domain tables; permanent replay/suppression tombstones must not retain article bodies, generated content, or raw operator reasons.
8. The dashboard app runs as one instance (runtime lease plus a `stop-first` update order) and backs up its database before every schema migration.

## Current Runtime Model

| Runtime | Storage | Notes |
|---|---|---|
| Node CLI | `LocalFileDeliveryStore` + file cache | Single-process, owned local state file; channels from environment variables |
| Dashboard app (`src/app/`) | `SQLiteDeliveryStore` on `node:sqlite` + app tables + file cache, one database in `DATA_DIR` | Channels and encrypted credentials in SQLite; Access JWT with `viewer`/`operator` roles; scheduler behind a runtime lease. Target primary engine on Dokploy; cutover pending |
| Cloudflare Worker | `SQLiteDeliveryStore` inside one Durable Object | Per-channel coordinator, alarms, request idempotency. Current production; observed in `bootstrap` mode on 2026-10-03; paused (not deleted) at cutover |

The Cloudflare schema uses physical domain tables plus `news_schema_migrations`. Bulky terminal delivery data is removed after 30 days, ordinary request detail after 90 days, and operator audit data is minimized/compacted while unresolved records and permanent idempotency/safety tombstones remain. The dashboard app uses the same delivery-store schema and copies deliveries into its content library before that compaction.

## Acceptance Criteria

- AI generation is required for preview and delivery runs.
- Outputs are attempted sequentially with durable acknowledgement between calls.
- Source failures are diagnosed separately from genuine empty feeds.
- `MemoryCache` is not a production output-path store.
- `TRIGGER_SECRET` and `OPERATOR_SECRET` are distinct; the dashboard app authenticates through Cloudflare Access and shares no secret with the Worker.
- Bootstrap mode allows health, status, queue, and operator pause only; preview is blocked.
- Quiesced mode performs no delivery mutation.
- Token maintenance is a separate switch and does not ride on delivery resume.
- X delivery topology requires the non-secret authenticated `X_DESTINATION_ID`.
- Community-sourced articles (Hacker News, and Reddit through its JSON source) keep their original external link, while the AI news preset's Reddit RSS source links to the Reddit thread; the technology-relevance gate filters by topic only, not link safety (accepted risk).
- `preview` never applies the drip daily limit or story-coverage exclusion.
- Dashboard: requests without a valid Access JWT get 401 (only `/healthz` is open); viewers cannot change anything (403); every change needs the exact public origin and a JSON body.
- Dashboard: credential values never appear in responses, events, runs, the library, or logs.
- Dashboard: preview sends nothing and changes no delivery state; `telegram-main` cannot resume, run, or retry an output before `notBefore` is set.
- Dashboard: the browser E2E suite covers credentials, channel creation (paused), prompt and AI edits, preview, resume and run, the library, statistics, pause/resume, the viewer role, and unauthenticated access.

## Rollout Policy

The repository includes a staged recovery path:

1. quiesce old writers without mutating production delivery state
2. introduce the SQLite Durable Object lifecycle baseline
3. validate a single-channel canary
4. resume only the approved channel

Rollback remains pause-first and state-preserving. The pre-lifecycle Worker is not treated as a casual rollback target once the Durable Object class lifecycle is in place.

The move to the dashboard app follows the same rules: the app's channels stay paused until the user enters the production secrets and approves the cutover; the Worker channel is paused and verified paused before the app resumes; rollback pauses the app first. See `docs/deployment.md`.

## Success Metrics

- Tests pass offline without live provider calls
- Docs match the current runtime and config surface
- Recovery commands are exact, versioned, and idempotent
- Protected routes remain redacted and no-store
- Production rollout stays behind explicit approval gates
- After cutover: the Worker reports `telegram-main` paused, the dashboard app delivers at least one post, and nothing published before the cutover instant is posted
