# Worker architecture

`backend/worker` is the shared Warframe Market cache used by the desktop app. This document
covers runtime ownership and invariants. See `README.md` for setup and operator commands.

## Runtime layout

- `src/index.ts` handles CORS rejection, route dispatch, 404 responses, request logging, and cron.
- `src/routes/public.ts` owns health, bootstrap, snapshot, price, meta, and order routes.
- `src/routes/admin.ts` owns authenticated prewarm, catalog, hotset, and status routes.
- `src/services/readThrough.ts` owns cache-first reads, stale refresh, negative markers, and
  in-flight deduplication.
- `src/services/prewarm.ts` owns catalog walks, upstream refreshes, snapshot patches, and the
  `SnapshotCoordinator` Durable Object.
- `src/security/rateLimit.ts` selects Cloudflare Rate Limiting bindings.
- `src/security/dailyBudget.ts` owns the sampled request budget and `DailyBudgetCounter` Durable
  Object.
- `src/security/bootstrap.ts` issues and verifies optional short-lived public API tokens.

Keep `src/index.ts` thin. Route and service behavior belongs in the modules above.

## Public request flow

Public requests pass through these controls:

1. CORS allowlist validation for requests with an `Origin` header.
2. A route-specific Cloudflare Rate Limiting binding keyed by the connecting IP.
3. The daily request budget.
4. Bootstrap token validation where required.
5. Slug and rank validation before any upstream request.
6. KV read-through, stale refresh, and negative-cache handling.

Electron and command-line clients normally omit `Origin` and are allowed. Browser origins must
match `ALLOW_ORIGIN`. `clientIp()` trusts only `cf-connecting-ip`.

Rate Limiting binding defaults in `wrangler.jsonc` are per IP:

- health: 5 per minute
- bootstrap and full orders: 60 per minute
- prices, meta, and order summaries: 200 per minute
- snapshot: 2 per minute
- admin: 60 per minute

Public limiter failures fail open to preserve app reads. Admin limiter failures fail closed with
`503 rate_limit_unavailable`. Zone-level WAF rules remain the first line of defense.

## Snapshot

`GET /v1/snapshot` serves KV key `snapshot:full:v1`. The snapshot contains the desktop price,
meta, and ranked order-summary caches.

- The route is public because startup requests it before bootstrap completes.
- `Cache-Control: public, max-age=7200` allows the Cache API to reuse the serialized body at a PoP.
- Cache hits still execute the Worker and its request guards. They avoid the KV read, validation,
  serialization, and response-body reconstruction.
- The ETag is a SHA-256 digest of the exact client response body plus the desktop cache version.
- Matching `If-None-Match` requests return 304 for both Cache API hits and KV reads.
- Invalid or missing snapshots return 503 and are never cached as valid data.

Prewarm batches call `patchSnapshot()` after their writes. `SnapshotCoordinator` serializes the
read-modify-write operation so concurrent cron and admin batches cannot overwrite each other. A
full catalog walk gradually fills the snapshot without a bulk KV rebuild or a 1000-subrequest
spike.

Do not restore the deleted admin snapshot-build route. It previously rebuilt from a truncated KV
scan and could replace a complete snapshot with partial data.

Snapshot key translation must stay compatible with the desktop importers. Ranked worker keys such
as `price:{slug}:r{n}` become `{slug}:rank-v3:r{n}` in the snapshot.

## Read-through and prewarm

Confirmed misses use `miss:price:*`, `miss:meta:*`, `miss:orders:*`, and
`miss:orders-summary:*`. Transient upstream errors must not create negative markers.
`skip:untradable:*` prevents repeated metadata requests for excluded items.

Cron runs every 15 minutes. Current production defaults are:

- `PREWARM_BATCH_SIZE=125`
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE=36`
- 24-hour price/meta TTL
- 48-hour order-summary TTL
- 21-hour stale-refresh threshold for both cache families
- `limits.cpu_ms=1000`

Cron is a rolling backstop. Fresh entries are copied into the snapshot without another upstream
request, while stale entries are refreshed before being patched.

## Daily budget

`DAILY_BUDGET_ENABLED=1` enables a sampled daily request cap. The current cap is 300,000 requests
with a sample rate of 100. Samples are recorded atomically in the `DailyBudgetCounter` Durable
Object named for the UTC day. Once the cap trips, public requests return
`503 daily_budget_exceeded` until the next UTC day and scheduled prewarm skips work.

Cloudflare billing alerts are still required. Repository code cannot create account-level billing
notifications.

## Bootstrap deployment

Required bootstrap mode must have `BOOTSTRAP_TOKEN_SECRET`; otherwise protected public routes fail
closed. Enable it in this order:

1. Run `npx wrangler secret put BOOTSTRAP_TOKEN_SECRET` from `backend/worker`.
2. Release the desktop app with `VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1`.
3. Set `PUBLIC_BOOTSTRAP_REQUIRED=1` and deploy the Worker.

Reverse that order when disabling. Older desktop versions fall back to direct Warframe Market
requests if the Worker returns 401.

## Response and cache invariants

- Preserve desktop envelopes: `{ ok, data }` and `{ ok: false, error }`.
- Successful public data may use explicit public cache headers. Auth errors, 404, 410, 429, and
  5xx responses stay `no-store` unless a route has a deliberate negative-cache policy.
- KV TTLs must remain meaningfully longer than stale thresholds.
- `/v1/orders/:slug` stays disabled by default. The desktop normally consumes summaries.
- `GET /healthz` is public-minimal. Detailed status requires admin authorization.
- `workers_dev=false` is required when relying on the custom domain and zone rules.

## Verification

From `backend/worker`:

```bash
npm run typecheck
npm run test -- --run
npm run test:smoke
npm run dev
npm run deploy
```

From the repository root:

```bash
pnpm run backend:typecheck
pnpm run backend:test
pnpm run lint:worker
```

Unit and integration behavior belongs in `test/index.spec.ts`. The scheduled GitHub workflow runs
`test/smoke.spec.ts` against the deployed custom domain every six hours.
