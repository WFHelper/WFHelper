# Backend Worker

A Cloudflare Worker that caches the Warframe Market data WFHelper uses. How it works at runtime,
and the rules the code relies on, are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Endpoints

Public:

- `GET /healthz`
- `GET /v1/bootstrap`
- `GET /v1/snapshot`
- `GET /v1/wfm-items`, the Warframe Market item catalog
- `GET /v1/prices/:slug`
- `GET /v1/price-history/:slug`, archived daily prices and nullable sales volume
- `GET /v1/meta/:slug`
- `GET /v1/order-summary/:slug`, with `?subtype=` for relic refinements
- `GET /v1/supporters`
- `GET /v1/top-traded`, the 100 most traded items over the last seven days
- `GET /v1/baro-history`, recorded visits, last-seen dates and nullable historical prices
- `GET /v1/adversary-vendors`, the Coda and Tenet weapon tables from the wiki
- `GET /v1/nightwave-offerings`, the Nightwave shop offerings from the wiki
- `POST /v1/feedback`, anonymous bug reports and feature requests
- `GET /v1/orders/:slug`, disabled by default

Admin routes need `Authorization: Bearer <ADMIN_API_KEY>`:

- `POST /admin/prewarm`
- `GET /admin/prewarm/status`
- `POST /admin/order-summary-hotset`
- `GET /admin/order-summary-hotset`
- `GET /admin/order-summary-catalog`
- `POST /admin/prewarm/order-summaries`
- `GET /admin/prewarm/order-summaries/status`
- `GET /admin/catalog/status`
- `GET /admin/snapshot/status`
- `POST /admin/supporters/exclusions`
- `POST /admin/supporters/sync`
- `GET /admin/stats/active-users`, anonymous daily active user counts, recorded only while
  `STATS_SALT` is set

## How the cache works

1. The desktop loads the bulk snapshot at startup.
2. Per-item requests check KV first.
3. Fresh cache entries return immediately.
4. Stale entries return while a refresh runs through `waitUntil`.
5. Cache misses fetch Warframe Market and write back to KV.
6. Confirmed misses and untradable items receive short-lived markers.
7. Cron walks the catalog and refreshes entries outside the 21-hour freshness window.
8. Each batch patches the bulk snapshot through a Durable Object coordinator.

Prewarm cron runs every 15 minutes. Production batches currently process 125 catalog items and 36
ranked summary entries per tick, then advance one batch of the riven history sweep. A separate daily
trigger runs the Discord supporter sync and writes the daily price and Baro archives. Manual prewarm
is an optional admin tool; the cache stays correct without it.

History archives accrue from deploy day. The price seed can recover available WFM statistics;
Baro history can recover only visit archives this Worker still retains. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for their keys, cadence, and retention.

### Baro history

The daily archive stage keeps `ITEM_META` key `baro:history:v1` (no TTL): up to 128 visits with
their manifests, trimmed by `HISTORY_RETENTION_DAYS`, plus up to 5,000 per-item last-seen records
that outlive their visits. `GET /v1/baro-history` serves only that stored key. It is public, uses
the API rate limiter and is edge-cached for one hour (five minutes while empty); it answers 503
while the key is missing or invalid. Coverage is partial, so an absent item or visit is unknown
rather than proof it never appeared. Reconciliation, the recovery keys and the single-writer rule
are described in `ARCHITECTURE.md` under "Baro visit history".

## Configuration

KV bindings:

- `PRICE_CACHE`
- `ITEM_META`

Durable Object bindings:

- `DAILY_BUDGET`
- `SNAPSHOT_COORDINATOR`

Rate Limiting bindings:

- `PUBLIC_HEALTH_RATE_LIMITER`
- `PUBLIC_LOW_RATE_LIMITER`
- `PUBLIC_API_RATE_LIMITER`
- `PUBLIC_SNAPSHOT_RATE_LIMITER`
- `ADMIN_RATE_LIMITER`
- `FEEDBACK_RATE_LIMITER`, required for feedback, 2 requests per minute per IP
- `FEEDBACK_GLOBAL_LIMITER`, required for feedback, 10 requests per minute across all senders

## Private Discord feedback

Create a dedicated private feedback channel and a webhook for that channel in Discord.
Keep its URL out of the desktop app, source files, build variables, and chat messages.
Set it as the Worker secret `FEEDBACK_DISCORD_WEBHOOK_URL` using the Cloudflare dashboard
or `npx wrangler secret put FEEDBACK_DISCORD_WEBHOOK_URL` from this directory. Use the
unmodified `https://discord.com/api/webhooks/<id>/<token>` URL without query parameters.
Deploy the Worker with the `FEEDBACK_RATE_LIMITER` and `FEEDBACK_GLOBAL_LIMITER` bindings before
releasing the desktop UI.
For a forum channel keep the var `FEEDBACK_DISCORD_FORUM` at `1` in `wrangler.jsonc`: each report
then opens its own thread named after its kind and title. Remove the var for a text channel,
where Discord rejects thread names.
No Discord bot or user login is required. The endpoint returns unavailable until both the
secret and limiter are configured. Rotate the webhook in Discord and replace the secret if
it leaks. Tests mock delivery and never send feedback to the channel.

Reports include the user-entered category, title, description, optional contact, app version
and platform. Diagnostics and one screenshot are opt-in. The modal previews the screenshot
and lists the diagnostic fields and log size; it does not preview the log contents.
Diagnostics contain OS version, architecture, language, current view, UI scale and the last
256 KiB of `main.log`, which can contain file paths, account and player names, and technical events.
The desktop re-encodes screenshot pixels to discard the original file's embedded metadata.
The relay reads no separate account, inventory or machine-identifier files. The log is sent
as recorded and is not redacted by the feedback relay.
Screenshots and free text can contain personal information; restrict channel membership and
delete reports when they are no longer needed. Discord retains the messages until deleted;
the Worker does not store feedback in KV or print report content in its request logs.

The endpoint reads at most 2,000,000 bytes of JSON as a stream, keeps at most a 256 KiB log tail,
and accepts a PNG, JPEG or WebP attachment of up to 1 MiB. It keeps the webhook server-side,
disables mentions, and sends once with Discord's `wait=true` acknowledgement. A timeout can mean
delivery succeeded without an acknowledgement; there is no automatic retry. The feedback limiters
refuse requests when they fail, even when public market-data rate limiting is turned off. Shared
daily-budget and CORS checks still apply.

Variables:

- `CACHE_TTL_SEC`
- `ORDERS_SUMMARY_CACHE_TTL_SEC`
- `ORDERS_SUMMARY_STALE_REFRESH_SEC`
- `NO_DATA_TTL_SEC`
- `STALE_REFRESH_SEC`
- `ALLOW_ORIGIN`
- `CATALOG_SLUG_GUARD_ENABLED`
- `DAILY_BUDGET_ENABLED`
- `DAILY_BUDGET_MAX_REQUESTS`
- `DAILY_BUDGET_SAMPLE_RATE`
- `PREWARM_BATCH_SIZE`
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE`
- `CATALOG_REFRESH_HOURS`
- `ADMIN_PREWARM_MAX_BATCH`
- `PUBLIC_RATE_LIMIT_ENABLED`
- `PUBLIC_CLIENT_POLICY` (`log` counts clients, `enforce` answers unknown ones with 403 on public
  routes; wait until installed versions that send no `x-wfhelper-client` header have updated)
- `PUBLIC_CLIENT_ALLOW` (comma list of product names, default `WFHelper`)
- `PUBLIC_CLIENT_DENY` (comma list of product names refused under either policy, default empty)
- `HISTORY_ARCHIVE_ENABLED`
- `HISTORY_RETENTION_DAYS`
- `RIVEN_ARCHIVE_BATCH_SIZE`
- `PRICE_SEED_ENABLED`
- `PRICE_SEED_BATCH_SIZE`
- `TOP_TRADED_ENABLED`
- `TOP_TRADED_BATCH_SIZE`
- `PUBLIC_BOOTSTRAP_REQUIRED`
- `BOOTSTRAP_TOKEN_TTL_SEC`
- `DISCORD_GUILD_ID`
- `DISCORD_ROLE_TIER_MAP`
- `FEEDBACK_DISCORD_FORUM`

Secrets:

- `ADMIN_API_KEY`
- `BOOTSTRAP_TOKEN_SECRET`
- `DISCORD_BOT_TOKEN`
- `FEEDBACK_DISCORD_WEBHOOK_URL`
- `STATS_SALT`, optional; without it no daily active users are counted

Production values and binding identifiers live in `wrangler.jsonc`.

## Setup

From this directory:

```bash
npm ci
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put BOOTSTRAP_TOKEN_SECRET
npm run cf-typegen
npm run typecheck
npm run test -- --run
```

The separate Worker package intentionally uses npm. Repository-root desktop commands use pnpm.

## Run and deploy

```bash
npm run dev
npm run deploy
```

`npm run deploy` targets the top-level production configuration. Local development uses the named
`dev` environment and its localhost CORS origin.

Recommended dashboard controls:

- A custom-domain WAF rate limit before Worker execution.
- A stricter `/admin` rate limit and, where practical, an admin source-IP allowlist.
- Billing alerts appropriate to the account budget.

## Manual prewarm

From the repository root:

```powershell
pnpm run backend:prewarm:order-summaries -- -ApiKey "<ADMIN_API_KEY>" -RefreshCatalog
pnpm run backend:prewarm:order-summaries:hotset -- -ApiKey "<ADMIN_API_KEY>"
```

The hotset helper reads `ranked-hotset.json`, uploads it, resets the summary cursor, and loops until
the selected entries are warm.

## Live smoke test

```bash
WORKER_URL=https://api.wfhelper.com npm run test:smoke
```

GitHub Actions runs the same test against production every six hours. It stays out of pull-request
CI because it depends on the live upstream and on what is currently deployed.
