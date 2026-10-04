# Deployment

The dashboard app is the only production engine. It runs on Dokploy behind Cloudflare Access, served by Dokploy's Traefik, at `https://radar.dantech.academy`, and it has posted to `telegram-main` since the cutover on 2026-10-03 ([Cutover record](#cutover-record-2026-10-03)). Every push to `master` deploys it ([Auto-deploy on push](#auto-deploy-on-push)); the [Rollback Runbook](#rollback-runbook) covers going back.

**Worker retired (2026-10-04).** The previous production runtime, the Cloudflare Worker `news-engine`, was deleted together with its secrets (`OPERATOR_SECRET`, `TRIGGER_SECRET`), its two cron triggers, its Durable Object data, and its `workers.dev` address, and its code left this repository. There is no Worker fallback. The KV namespace it had bound as `NEWS_CACHE` and the AI Gateway `news-engine` are separate account resources and still exist: nothing here reads the KV namespace, and the gateway remains an optional path for Gemini ([README, Environment Overview](../README.md#environment-overview)).

Deploy credentials are only ever passed through environment variables, and channel secrets are entered in the dashboard. Never print them, paste them into chat, or write them to files, logs, docs, or pull requests.

## Dokploy + Cloudflare

> **Status: deployed 2026-10-03** with `scripts/deploy/dokploy-cloudflare.mjs` (no manual clicks). Re-running it is safe: it looks resources up by name, changes only what differs, reuses the existing `APP_MASTER_KEY`, and redeploys the app to pick up new commits.

**Change on 2026-10-03 (user decision): no tunnel.** The Cloudflare Tunnel `content-radar` and the Dokploy application `content-radar-cloudflared` that ran it were deleted, for a simpler setup with one application. The hostname now points to Dokploy's Traefik: its DNS record (same record ID) became a proxied A record to the VPS, and the application `content-radar` got a Traefik domain. The change was applied to production through the APIs; the script now provisions only this setup.

| Resource | Value |
|---|---|
| Public hostname | `https://radar.dantech.academy`: a proxied A record to the VPS (`ORIGIN_IP`) |
| Access | Team domain `small-unit-70a7.cloudflareaccess.com`; self-hosted application "Content Radar" with the reusable policies `content-radar-users` (allow, operator + viewer emails) and `content-radar-agent-service-token` (`non_identity`, the agent service token); one-time PIN login method |
| Dokploy | v0.30.8; project `content-radar`; application `content-radar` (service `content-radar-lm6hl8` on `dokploy-network`), volume `content-radar-data` at `/data`, 1 replica, `stop-first`, stop grace 135 s, health check `/healthz`; Traefik domain `radar.dantech.academy`, path `/`, port 3000, HTTPS |
| TLS | Cloudflare terminates the public TLS and connects to the VPS over HTTPS (zone SSL/TLS mode Full or Full (strict)). There Traefik presents its default certificate, a Cloudflare Origin CA wildcard for `*.dantech.academy`, so the domain requests none (`certificateType: none`) |
| Source | The Dokploy GitHub App provider, repository `dantech0xff/hot-news-radar`, branch `master`, `autoDeploy` on with trigger `push`: every push to `master` deploys ([Auto-deploy on push](#auto-deploy-on-push)) |

The Dokploy panel (`deploy.dantech.academy`) is itself behind Cloudflare Access. To let the deploy script reach its API, the panel's Access application "Dokploy dashboard" also carries the `content-radar-agent-service-token` policy (added 2026-10-03, its existing email policy unchanged), and the operator environment sets `DOKPLOY_BEHIND_ACCESS=true`, which sends the service-token headers to the Dokploy API as well as the app — never to the Cloudflare API. A second Access application covers only `deploy.dantech.academy/api/deploy/github` with a Bypass policy, so the push webhooks of the Dokploy GitHub App reach Dokploy, which verifies their signature itself ([Auto-deploy on push](#auto-deploy-on-push)).

Commands (credentials come from the operator's environment or `.env`; values are never printed). The Cloudflare credentials they need were deleted on 2026-10-04 and must be created again first ([Deploy credentials](#deploy-credentials)):

```bash
npm run deploy:preflight
```

```bash
npm run deploy:dokploy
```

```bash
npm run deploy:verify -- --redeploy-check
```

The app deploys from the GitHub App source, so the operator `.env` sets `DOKPLOY_SOURCE=github` and these commands keep that source ([Auto-deploy on push](#auto-deploy-on-push)). Without it a run moves the app back to the public Git URL and pushes stop deploying. The branch defaults to `master`; `--git-branch <name>` moves the source to another branch, with a warning.

`ORIGIN_IP` is the VPS IPv4 address: the content of the hostname's A record, and the address verify probes. It lives only in the operator `.env`, never in the repository; the scripts print `<origin-ip>` instead, and `verify --origin-ip <ipv4>` overrides it.

Verification history: with the tunnel, the 2026-10-03 run passed 10/10 (Access in front, the service token accepted, the origin answering Traefik's 404 for the hostname, one replica with `stop-first`, a redeploy that kept the channel). Its first attempt hit a 503 because the container's first JWKS fetch exceeded jose's 5 s default; the app now allows 15 s and loads the keys right after it starts listening. After the switch to Traefik, checked by hand: the origin, asked over HTTPS with SNI and Host `radar.dantech.academy`, answers `/healthz` 200, `/api/health` 401 JSON (`unauthenticated`), and `/` 401 HTML; plain HTTP redirects to HTTPS; through Cloudflare, anonymous requests get a 302 to the Access login and the service token gets 200. `npm run deploy:verify` passed 10 of 10 on 2026-10-03 at 16:22 UTC, with `telegram-main` active after the cutover (the channel check accepts a paused channel, or an active one with `notBefore` set).

After the first deploy, copy `APP_MASTER_KEY` from the Environment tab of the Dokploy application `content-radar` into a password manager.

```text
Browser ──HTTPS──> Cloudflare: proxied DNS record + Access (email login or service token)
                     └─HTTPS, SNI radar.dantech.academy──> Traefik on the VPS (ORIGIN_IP, ports 80/443, Origin CA certificate)
                                                             └─> http://<appName>:3000 on dokploy-network
                                                                   Dokploy application: this repository's Dockerfile
                                                                   1 replica, volume at /data, no published port
```

### Dokploy Application

| Setting | Value | Why |
|---|---|---|
| Source | `DOKPLOY_SOURCE=git` (default): this repository over public HTTPS (`saveGitProvider`), deployed when the script runs. `DOKPLOY_SOURCE=github`: the Dokploy GitHub App provider (`saveGithubProvider`), deployed on every push. Branch `master` unless `--git-branch` names another; this deployment uses `github` | The repository is public, so the Git URL needs no deploy key; only the GitHub App sends Dokploy a webhook on push |
| Build | Dockerfile `Dockerfile`, context `.` | Web build stage, then `node:24-alpine`; the `# syntax=docker/dockerfile:1` line and `COPY --chmod` need BuildKit |
| Replicas | 1 | One SQLite file, one scheduler |
| Swarm update config | `{ "Parallelism": 1, "Order": "stop-first" }` | Dokploy applications default to `start-first`, which would briefly run two schedulers on one database; the runtime lease is the second guard |
| Stop grace period | At least 135 s (`SHUTDOWN_WAIT_SECONDS` + 15 s) | SIGTERM waits for the run in flight; a kill in the middle of a send leaves an ambiguous output. Find the Swarm field in the instance's OpenAPI before deploying |
| Volume | A named volume (for example `content-radar-data`) at `/data` | Holds `content-radar.db`, `backups/`, and `news.json` across redeploys |
| Health check | `http://127.0.0.1:3000/healthz` (Swarm intervals are in nanoseconds) | The only unauthenticated route; `/api/health` needs an Access JWT |
| Domain and ports | One Traefik domain: the hostname, path `/`, port 3000, HTTPS, `certificateType: none` (Traefik's default certificate). No published port | Trade-off: Traefik also answers on the VPS IP, so a request that skips Cloudflare (`curl -k --resolve <hostname>:443:<vps-ip> https://<hostname>/`) reaches the app without Access. The app checks the Access JWT itself on every route except `/healthz`, so such a request gets 401 and no data. Optional hardening: allow 80/443 on the VPS only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) |

Environment (names only; values are never committed or printed):

| Variable | Value |
|---|---|
| `NODE_ENV`, `HOST`, `PORT`, `DATA_DIR`, `CACHE_PATH` | Already set by the image: `production`, `0.0.0.0`, `3000`, `/data`, `/data/news.json` |
| `APP_MASTER_KEY` | 32 random bytes in base64, generated once and passed straight to the Dokploy API. The user keeps a copy in a password manager (it is visible in Dokploy's environment tab); losing it means re-entering every secret |
| `ACCESS_TEAM_DOMAIN` | `https://<auth_domain>` from `GET /accounts/{account_id}/access/organizations` |
| `ACCESS_AUD` | The `aud` of the Access application |
| `APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS` | The people allowed in, by role |
| `APP_SERVICE_TOKEN_ROLES` | `<client-id>:operator` for the Access service token in `CF_ACCESS_CLIENT_ID`, written by the deploy |
| `PUBLIC_ORIGIN` | `https://<hostname>` |
| `CONTENT_SCAN_RETENTION_DAYS`, `RUN_HISTORY_RETENTION_DAYS`, `SHUTDOWN_WAIT_SECONDS` | Optional; defaults 30, 180, and 120 |

Dokploy's `saveEnvironment` replaces the whole environment string, and environment, mount, and Swarm changes apply only on the next deploy. Every channel starts paused, so deploying never posts anything.

### Cloudflare

Access exists before DNS, and the app is deployed before Traefik routes to it, so the hostname is never reachable unprotected:

1. Team domain: `GET /accounts/{account_id}/access/organizations` returns `auth_domain`. The Zero Trust organization must already exist.
2. Login method: add a one-time PIN identity provider if the organization has none.
3. Reusable Access policies: allow by email (operators and viewers), plus a `non_identity` policy for the agent's service token.
4. A self-hosted Access application for the hostname with both policies; its `aud` becomes `ACCESS_AUD`. The Dokploy application is configured with it and deployed next.
5. The application's Traefik domain in Dokploy (`domain.create`, or `domain.update` when a setting differs): the hostname, path `/`, port 3000, HTTPS, `certificateType: none`. Dokploy rewrites the Traefik configuration at once, without a redeploy. Domains for other hostnames are kept, with a warning.
6. DNS, last: a proxied A record from the hostname to `ORIGIN_IP`. An existing record for the hostname (such as the former tunnel CNAME) is updated in place; several records stop the deploy, which never deletes one.

Traefik on the VPS IP and containers on `dokploy-network` reach the app without passing Access, which is why the app verifies the Access JWT on every request itself (all but `GET /healthz`).

### Deploy credentials

The deploy needs these in the operator's environment: `DOKPLOY_URL` and `DOKPLOY_API_KEY` (Dokploy v0.29.5 or later); `CF_API_TOKEN` with edit rights on Access apps and policies, Access organizations and identity providers, Access service tokens, and Zone DNS (Zone Read is optional: it lets the preflight check that the hostname is in the zone); `CF_ACCOUNT_ID`; `CF_ZONE_ID`; the hostname as `APP_HOSTNAME`; `ORIGIN_IP`, the VPS IPv4 address (operator `.env` only; keep it out of the repository); the operator emails as `APP_OPERATOR_EMAILS`; and the service token as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. Verify needs `CF_API_TOKEN` and `CF_ZONE_ID` as well, for its DNS check. Check variable names only; never echo their values.

Optional:

- `DOKPLOY_BEHIND_ACCESS=true` when the Dokploy panel itself is behind Access: its API then gets the service-token headers too, which makes `CF_ACCESS_CLIENT_SECRET` required for every command.
- `DOKPLOY_SOURCE`: `git` (default) or `github`; see [Auto-deploy on push](#auto-deploy-on-push).
- `DOKPLOY_GITHUB_PROVIDER`: the name of the Dokploy GitHub provider to use when there are several.

**Deleted on 2026-10-04.** After the cutover, the Cloudflare API token and the Access service token these commands used were deleted. A push to `master` still deploys, because push-to-deploy needs neither. Before the next `npm run deploy:*`, create both again:

1. A Cloudflare API token with the rights above, as `CF_API_TOKEN`.
2. An Access service token (Zero Trust → Access → Service credentials), as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Add it by hand to the reusable policy `content-radar-agent-service-token` before the first run: the Dokploy panel is behind Access, and the preflight calls the Dokploy API with this token before the deploy could update that policy. From then on every deploy sets the policy and `APP_SERVICE_TOKEN_ROLES` to the token in `CF_ACCESS_CLIENT_ID`.

### Auto-deploy on push

**Current state (2026-10-03).** Since the dashboard pull request was merged, the application deploys from the Dokploy GitHub App provider (installed with access to this repository), branch `master`, `autoDeploy` on with trigger `push`. Before that it pulled the repository over public HTTPS through Dokploy's custom Git provider (`saveGitProvider`), which gets no webhook, so a push deployed nothing.

The switch, which is also how to restore the source if it ever moves:

```bash
DOKPLOY_SOURCE=github npm run deploy:preflight
DOKPLOY_SOURCE=github npm run deploy:dokploy -- --git-branch master --dry-run
DOKPLOY_SOURCE=github npm run deploy:dokploy -- --git-branch master
```

- The preflight picks the GitHub provider: the only one, or the one named by `DOKPLOY_GITHUB_PROVIDER`. It blocks when there is none, when there are several and none is named, or when the provider cannot see `dantech0xff/hot-news-radar`. It warns, without blocking, when no Access application with a Bypass policy covers `deploy.dantech.academy/api/deploy/github`: the webhook URL Dokploy gave the GitHub App, which the check assumes is on the `DOKPLOY_URL` host.
- The dry run should list exactly two calls: `application.saveGithubProvider` (provider, owner, repository, branch `master`, build path `/`, trigger `push`) and `application.deploy`.
- The deploy saves the source only when it differs, turns `autoDeploy` on if it is off, and deploys once from `master`. The environment, `APP_MASTER_KEY`, volume, Swarm settings, Access, the Traefik domain, and DNS stay as they are. A re-run changes nothing except the usual redeploy.
- Afterwards keep `DOKPLOY_SOURCE=github` in the operator `.env`. The branch defaults to `master`; `--git-branch <name>` moves the source to that branch, with a warning saying which pushes deploy from then on. A run without `DOKPLOY_SOURCE=github` moves the source back to the public Git URL, and pushes to `master` stop deploying.
- After the first push to `master`, check that Dokploy lists a new deployment of `content-radar` for it. If none appears, the GitHub App's Recent Deliveries (its advanced settings on GitHub) show whether the webhook reached Dokploy.
- The repository used to be `dantech0xff/daily-news-broadcast` and was renamed to `hot-news-radar`. Dokploy matches a push on the stored owner and repository name, so after a rename no push deploys until the application's GitHub provider (Dokploy → application → General → Provider) has the renamed repository selected, or the deploy script saves it. GitHub redirects the old name for cloning, so a manual Deploy still builds in the meantime.

What a push to `master` then does:

1. GitHub sends the push event to the GitHub App's webhook, `https://deploy.dantech.academy/api/deploy/github`. Cloudflare Access lets it through because an Access application with a Bypass policy covers exactly that path, and Dokploy verifies the webhook signature with the App's secret.
2. Dokploy queues a deployment for each application whose GitHub source matches the push (provider, owner, repository, branch `master`) and has `autoDeploy` on with trigger `push`.
3. Dokploy builds the image from the Dockerfile on the VPS. If the build fails, the deployment ends in error and the running container keeps serving.
4. Swarm swaps the container `stop-first`. The old container gets SIGTERM, stops scheduling, and waits up to `SHUTDOWN_WAIT_SECONDS` (120 s) for a run in flight; the stop grace period is 135 s. It then releases the runtime lease and closes the database. The new container starts on the same `content-radar-data` volume at `/data`, makes a `VACUUM INTO` backup before any schema migration, serves `/healthz`, and takes the lease before it schedules anything.
5. The Traefik domain and DNS do not change. Traefik routes to the service name on `dokploy-network`, which stays the same, so `https://radar.dantech.academy` answers again as soon as the new container listens.

Keep in mind:

- A push deploys code only. Environment, volume, Swarm, Access, domain, and DNS changes still go through `npm run deploy:dokploy`, with `DOKPLOY_SOURCE=github` in the operator `.env`.
- Watch paths set on the application in Dokploy limit which pushes deploy. The deploy warns about them and clears them only when it saves the source again.
- Every push to `master` goes to production. Merge through pull requests with the tests green. No CI runs `npm test`, so run it locally before merging.
- A new container that fails at startup is not rolled back, because the old one is already stopped. Revert the commit on `master`, which deploys again ([Rollback Runbook](#rollback-runbook)).

### Verification Checklist

- Anonymous requests to `https://<hostname>/` and `/api/health` are stopped by Access: anything but app content is acceptable.
- With the service token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`), `/api/health` returns 200, shows this instance holding the lease, and reports one channel, and `GET /api/channels/telegram-main/status` shows it paused, or active with `notBefore` set.
- Straight to the origin, `curl -k --resolve <hostname>:443:<vps-ip> https://<hostname>/healthz` returns `ok`, `/api/health` returns the app's own 401 (`unauthenticated`) and never data, and plain HTTP redirects to HTTPS. No app port is published on the host.
- The hostname is one proxied A record to the VPS, and the application has exactly one Traefik domain for it, with the settings above.
- A redeploy keeps the data (no new seed, no repeated migration), and two containers never run at once.
- A person signs in through Access and the dashboard loads.

Backups: the app writes `VACUUM INTO` snapshots to `/data/backups/` before schema migrations ([Rollback Runbook](#rollback-runbook) has the restore). Off-site volume backups (Dokploy Volume Backups to S3 or R2) are not set up.

## Cutover record (2026-10-03)

The dashboard app took over `telegram-main` from the Worker:

- The user entered the bot token, the chat ID, and a Gemini API key in the dashboard (this `telegram-main` calls Gemini directly, without AI Gateway) and approved the cutover. A preview then generated texts and delivered nothing.
- The Worker's `telegram-main` was paused at channel version 544 (14:03:30 UTC). The app's cutover mark `notBefore` was set to 2026-10-03T14:03:41.986Z, and the app's channel was resumed.
- The first sends (a manual run at 14:40 UTC, then the 15:00 tick) failed with `fetch failed`. No connection had been established, so nothing reached Telegram; the output was recorded as ambiguous, which blocked the channel, so it was paused and the item abandoned. The cause: Node gives each address of a host 250 ms to connect (`autoSelectFamily`), the TCP handshake from the VPS to api.telegram.org takes about 215 to 260 ms, and the next address (IPv6) fails at once because the container has no IPv6, so the connection failed with ETIMEDOUT. `src/app/server.js` now raises that per-address timeout to 2.5 s at startup.
- The channel was resumed with `notBefore` kept, and a manual run at 16:03:47 UTC delivered Telegram message 1611 (delivery `833249e997354543b64576af4dc207d01c9cf18141f216d94c215b9d47bdeccd`). That met the cutover's acceptance check: a delivered post with a Telegram message ID, and no delivered article published before `notBefore`. The channel has posted on its schedule since.

## Rollback Runbook

There is no other engine to fall back to. Rolling back means stopping the posts, then running an earlier version of the app:

1. Pause `telegram-main` in the dashboard (the API route is `POST /api/channels/telegram-main/control/pause`). Pause never needs the runtime lease, so it works whenever the app answers. To take the dashboard offline as well, stop the Dokploy application `content-radar` or delete the DNS record; the channel stays paused.
2. Revert the faulty commit on `master`. The push deploys the previous code ([Auto-deploy on push](#auto-deploy-on-push)); if that build fails, the running container keeps serving.
3. Only if the reverted build cannot open the database because a newer build migrated it (startup fails, saying the database has an app schema migration this build does not know, or `Unsupported SQLite delivery schema version`), restore the snapshot written before that migration:
   - Before migrating a database that holds data, the app writes a `VACUUM INTO` snapshot to `/data/backups/`: `content-radar-<UTC time>-v<from>.db` before an app schema migration, `content-radar-<UTC time>-delivery-v<from>.db` before a delivery-store upgrade, with the time written like `2026-10-04T06-00-00-000Z`. Only the newest 10 are kept ([`src/app/db/database-backup.js`](../src/app/db/database-backup.js)).
   - Stop the application. In its volume `content-radar-data`, move `content-radar.db` and any `content-radar.db-wal` and `content-radar.db-shm` aside, then copy the snapshot to `content-radar.db` with the snapshot's owner and mode (the app runs as the unprivileged `node` user; `cp -p` keeps both). Start the application again.
   - Everything written after the snapshot is lost, including the record of posts made since then, and the channel is paused or active as it was at the snapshot. Pause it again as soon as the app is up, before its next scheduled tick.
4. Resume the channel in the dashboard once its status, queue, and run history look right.
