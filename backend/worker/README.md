# Backend Worker

Cloudflare Worker cache for the Warframe Market data used by WFHelper. Runtime details and
invariants are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Endpoints

Public:

- `GET /healthz`
- `GET /v1/bootstrap`
- `GET /v1/snapshot`
- `GET /v1/prices/:slug`
- `GET /v1/meta/:slug`
- `GET /v1/order-summary/:slug`
- `GET /v1/orders/:slug`, disabled by default

Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`:

- `POST /admin/prewarm`
- `GET /admin/prewarm/status`
- `POST /admin/order-summary-hotset`
- `GET /admin/order-summary-hotset`
- `GET /admin/order-summary-catalog`
- `POST /admin/prewarm/order-summaries`
- `GET /admin/prewarm/order-summaries/status`
- `GET /admin/snapshot/status`

## Automatic flow

1. The desktop loads the bulk snapshot at startup.
2. Per-item requests check KV first.
3. Fresh cache entries return immediately.
4. Stale entries return while a refresh runs through `waitUntil`.
5. Cache misses fetch Warframe Market and write back to KV.
6. Confirmed misses and untradable items receive short-lived markers.
7. Cron walks the catalog and refreshes entries outside the 21-hour freshness window.
8. Each batch patches the bulk snapshot through a Durable Object coordinator.

Cron runs every 15 minutes. Production batches currently process 125 catalog items and 36 ranked
summary entries per tick. Manual prewarm remains an operator tool, not a correctness requirement.

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

Important variables:

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
- `PUBLIC_BOOTSTRAP_REQUIRED`
- `BOOTSTRAP_TOKEN_TTL_SEC`

Secrets:

- `ADMIN_API_KEY`
- `BOOTSTRAP_TOKEN_SECRET`

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

GitHub Actions runs the same test against production every six hours. Keep it out of pull-request
CI because it depends on live upstream and deployment state.
