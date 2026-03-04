# Backend Lite (Cloudflare Worker)

This Worker is the shared cache layer for Warframe Market price and meta data used by the desktop app.

## Endpoints

- `GET /healthz`
- `GET /v1/prices/:slug`
- `GET /v1/meta/:slug`
- `POST /admin/prewarm` (Bearer auth)
- `GET /admin/prewarm/status` (Bearer auth)

## Fully automatic mode (no manual prewarm required)

The backend now runs in fully automatic mode. Manual prewarm still exists as an optional maintenance endpoint, but it is no longer required for normal operation.

### 7-step automatic flow

1. Client requests `GET /v1/prices/:slug` or `GET /v1/meta/:slug`.
2. Worker checks KV cache first (`price:*` / `meta:*`).
3. On cache hit, Worker returns immediately.
4. If cached payload is stale, Worker serves cached data and queues background refresh (`waitUntil`).
5. On cache miss, Worker read-through fetches from Warframe Market and writes to KV.
6. Miss and untradable markers are cached to avoid repeated upstream hits.
7. Cron prewarm continuously advances through the catalog to keep hot data warmed.

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
- `NO_DATA_TTL_SEC` TTL for negative cache markers.
- `STALE_REFRESH_SEC` age threshold for background stale refresh.
- `ALLOW_ORIGIN` comma-separated origin allowlist (include `null` for Electron).
- `ADMIN_RATE_LIMIT_WINDOW_SEC` admin rate-limit window.
- `ADMIN_RATE_LIMIT_MAX` admin request cap per IP and window.
- `PREWARM_BATCH_SIZE` cron batch size.
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
