# Backend Lite (Cloudflare Worker)

This Worker is the shared cache layer for Warframe Market price and meta data used by the desktop app.

## Endpoints

- `GET /healthz`
- `GET /v1/prices/:slug`
- `GET /v1/meta/:slug`
- `GET /v1/order-summary/:slug`
- `GET /v1/orders/:slug`
- `POST /admin/prewarm` (Bearer auth)
- `GET /admin/prewarm/status` (Bearer auth)
- `POST /admin/order-summary-hotset` (Bearer auth)
- `GET /admin/order-summary-hotset` (Bearer auth)
- `GET /admin/order-summary-catalog` (Bearer auth)
- `POST /admin/prewarm/order-summaries` (Bearer auth)
- `GET /admin/prewarm/order-summaries/status` (Bearer auth)

## Fully automatic mode (no manual prewarm required)

The backend now runs in fully automatic mode. Manual prewarm still exists as an optional maintenance endpoint, but it is no longer required for normal operation.

### 7-step automatic flow

1. Client requests `GET /v1/prices/:slug` or `GET /v1/meta/:slug`.
2. Worker checks KV cache first (`price:*` / `meta:*`).
3. On cache hit, Worker returns immediately.
4. If cached payload is stale, Worker serves cached data and queues background refresh (`waitUntil`).
5. On cache miss, Worker read-through fetches from Warframe Market and writes to KV.
6. Miss and untradable markers are cached to avoid repeated upstream hits.
7. Cron prewarm continuously advances through the catalog, but cron skips entries whose cache
  timestamps are still inside the stale-refresh window.
8. Ranked-card summary prewarm can walk either the full ranked catalog or an optional hotset.

Cron is intentionally a rolling backstop, not a full refresh every tick. Production defaults run
every 15 minutes with daily-pass batches (`PREWARM_BATCH_SIZE=100`,
`ORDER_SUMMARY_PREWARM_BATCH_SIZE=18`) and a 21h stale-refresh window so the full catalog is
spread across the day instead of rewriting thousands of KV keys repeatedly.

The Worker also has two cost guardrails:

- `limits.cpu_ms=1000` caps runaway CPU per invocation. This is intentionally lower than the
  default 30 seconds but high enough for snapshot JSON handling and cron batches.
- `DAILY_BUDGET_ENABLED=1` counts sampled fetch requests in KV and returns
  `503 daily_budget_exceeded` until midnight UTC after `DAILY_BUDGET_MAX_REQUESTS` is reached.
  The default cap is `300000` requests/day with `DAILY_BUDGET_SAMPLE_RATE=100`, keeping counter
  writes small while providing a practical fail-closed budget breaker. Scheduled prewarm checks the
  same cap and skips cron work after the breaker trips.

Cloudflare billing alerts still need to be configured in the dashboard; this repository cannot
create account-level billing notifications. Recommended alerts: base plan, low overage, and hard
attention thresholds (for example $5, $7, and $10).

## Security model

- CORS allowlist via `ALLOW_ORIGIN`.
- Admin routes require `Authorization: Bearer <ADMIN_API_KEY>`.
- Admin routes are rate limited per IP.
- Slug validation on public routes (`^[a-z0-9_]+$`).
- Generic error payloads, no secret logging.

## Worker layout

- `src/index.ts` thin router (`fetch` + `scheduled`)
- `src/routes/public.ts` health + public cache routes
- `src/routes/admin.ts` manual prewarm + status
- `src/services/prewarm.ts` catalog + batch prewarm logic
- `src/services/readThrough.ts` automatic cache hydration and stale refresh
- `src/security/cors.ts` CORS + JSON response helper
- `src/security/rateLimit.ts` admin rate limiter

## Key vars

- `CACHE_TTL_SEC` TTL for `price:*` and `meta:*` records.
- `ORDERS_SUMMARY_CACHE_TTL_SEC` TTL for `orders-summary:*` card summary records.
- `ORDERS_SUMMARY_STALE_REFRESH_SEC` stale threshold for `orders-summary:*` background refresh.
- `NO_DATA_TTL_SEC` TTL for negative cache markers.
- `STALE_REFRESH_SEC` age threshold for background stale refresh.
- `ALLOW_ORIGIN` comma-separated browser-origin allowlist. Do not include `null`; Electron/curl
  requests should omit the `Origin` header, which is already allowed separately.
- `ADMIN_RATE_LIMIT_WINDOW_SEC` admin rate-limit window.
- `ADMIN_RATE_LIMIT_MAX` admin request cap per IP and window.
- `CATALOG_SLUG_GUARD_ENABLED` rejects cache misses for slugs absent from the cached WFM catalog
  before making upstream WFM requests.
- `DAILY_BUDGET_ENABLED` enables/disables the sampled daily request budget circuit breaker.
- `DAILY_BUDGET_MAX_REQUESTS` daily sampled request cap before the Worker returns 503.
- `DAILY_BUDGET_SAMPLE_RATE` sampled counter increment size; higher values mean fewer KV writes.
- `DAILY_BUDGET_SYNC_INTERVAL_SEC` per-isolate KV sync interval for learning that the cap tripped.
- `PREWARM_BATCH_SIZE` cron batch size.
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE` cron batch size for ranked summary prewarm.
- `CATALOG_REFRESH_HOURS` item catalog refresh interval.
- `ADMIN_PREWARM_MAX_BATCH` cap for manual prewarm batch size.

## Required setup

1. Configure KV bindings in `wrangler.jsonc` (`PRICE_CACHE`, `ITEM_META`).
2. Set admin secret:

```bash
npx wrangler secret put ADMIN_API_KEY
```

3. Generate worker runtime types:

```bash
npx wrangler types
```

## Local run

```bash
npm run dev
```

## Deploy

```bash
npm run deploy
```

The deploy script passes `--env=""` so Wrangler targets the top-level production config explicitly
even though a named `dev` environment exists for local development.

Recommended Cloudflare dashboard rules, which run before Worker billing:

- WAF rate limit: `http.host eq "api.wfhelper.com"`, 60 requests per 60 seconds per IP,
  block for 10 minutes.
- WAF rate limit: `http.host eq "api.wfhelper.com" and starts_with(http.request.uri.path, "/admin")`,
  5 requests per 60 seconds per IP, block for 10 minutes.
- WAF custom rule for stable management IPs:
  `http.host eq "api.wfhelper.com" and starts_with(http.request.uri.path, "/admin") and not ip.src in {YOUR_IP}` → block.

## Manual prewarm (optional)

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"batchSize":20,"refreshCatalog":false,"resetCursor":false}' \
  https://worker.wfcompanion-cache.workers.dev/admin/prewarm
```

## Prewarm status (optional)

```bash
curl -H "Authorization: Bearer <ADMIN_API_KEY>" \
  https://worker.wfcompanion-cache.workers.dev/admin/prewarm/status
```

## Ranked summary catalog (recommended)

The worker can build a ranked-summary catalog from the WFM item catalog and prewarm rank `0` plus
`maxRank` for every ranked entry.

Run the helper from repo root:

```powershell
npm run backend:prewarm:order-summaries -- -ApiKey "<ADMIN_API_KEY>" -RefreshCatalog
```

Inspect the generated ranked summary catalog:

```bash
curl -H "Authorization: Bearer <ADMIN_API_KEY>" \
  "https://worker.wfcompanion-cache.workers.dev/admin/order-summary-catalog?refresh=1"
```

## Ranked summary hotset (optional override)

Seed a hotset of ranked items that should stay warm for inventory cards:

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"replace":true,"entries":[{"slug":"primed_flow","maxRank":10,"lastSeenAt":1735776000000}]}' \
  https://worker.wfcompanion-cache.workers.dev/admin/order-summary-hotset
```

Then trigger a manual hotset prewarm:

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"batchSize":12}' \
  https://worker.wfcompanion-cache.workers.dev/admin/prewarm/order-summaries
```

Or use the PowerShell helper from repo root:

```powershell
npm run backend:prewarm:order-summaries:hotset -- -ApiKey "<ADMIN_API_KEY>"
```

It auto-detects `ranked-hotset.json` from common Electron user-data locations, uploads it to the
worker hotset, resets the summary prewarm cursor, and loops until the hotset is fully warmed.
