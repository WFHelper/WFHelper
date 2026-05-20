# Worker Architecture

This file documents the architecture, invariants, and edit rules for `backend/worker`.
`README.md` is the user-facing reference (endpoints, env vars, setup, deploy); this file
is for anyone changing how the worker behaves.

## Refresh Cloudflare docs before behavior changes

Before changing Worker runtime, KV, cron, bindings, or limits behavior, check the current docs:

- https://developers.cloudflare.com/workers/
- https://developers.cloudflare.com/workers/platform/limits/

Cloudflare runtime limits and binding capabilities change; don't rely on cached assumptions.

## Current Architecture

- `src/index.ts`
  - Thin router only.
  - Handles top-level CORS reject, OPTIONS, route dispatch, 404, and cron trigger.
- `src/routes/public.ts`
  - `GET /healthz`
  - `GET /v1/bootstrap`
  - `GET /v1/snapshot` — serves the pre-built bulk snapshot blob (prices + meta + orderSummaries) from
    KV key `snapshot:full:v1`. Returns 503 `snapshot_not_ready` if the cron has not yet fired.
    `Cache-Control: public, max-age=7200` so Cloudflare edge absorbs nearly all real traffic.
    Rate limited at **10 req / 600 s per IP** (snapshot bucket).
    **ETag / conditional GET**: the response includes an `ETag` header derived from the snapshot's
    `generatedAt` timestamp. Clients send `If-None-Match` on repeat fetches; if the snapshot has
    not changed the worker returns **304 Not Modified** with an empty body, so repeat app opens
    cost zero bandwidth. This is the same pattern AlecaFrame uses for its bulk data endpoints.
    **Does NOT require bootstrap token** — the snapshot is fetched at client startup before the
    bootstrap token flow has completed; requiring a token creates a chicken-and-egg failure. The
    data it contains is already publicly available via per-slug routes.
  - `GET /v1/prices/:slug`
  - `GET /v1/meta/:slug`
  - `GET /v1/order-summary/:slug`
  - `GET /v1/orders/:slug`
  - Uses automatic read-through cache hydration plus public-route protection.
- `src/routes/admin.ts`
  - `POST /admin/prewarm`
  - `GET /admin/prewarm/status`
  - `POST /admin/order-summary-hotset`
  - `GET /admin/order-summary-hotset`
  - `GET /admin/order-summary-catalog`
  - `POST /admin/prewarm/order-summaries`
  - `GET /admin/prewarm/order-summaries/status`
  - `GET /admin/snapshot/status`
  - Requires bearer auth and applies admin rate limiting.
  - **`POST /admin/snapshot/build` has been permanently removed.** The snapshot is maintained
    exclusively via incremental `patchSnapshot()` calls inside `prewarmBatch` and
    `prewarmOrderSummaryCatalog`. Calling a bulk KV-read rebuild from the cron would overwrite
    the complete snapshot with a truncated 249-item result (1000 subrequest limit per invocation).
    Do NOT re-add this route or call `buildFullSnapshot` from the cron.
- `src/services/prewarm.ts`
  - Catalog fetch/cache and cron/manual batch prewarm.
  - Writes `price:*` and `meta:*` records.
  - Builds ranked summary catalog entries from WFM item metadata.
  - Supports both global ranked catalog prewarm and optional ranked hotset prewarm.
  - Skips untradable items with `skip:untradable:*` markers.
  - `patchSnapshot(env, patches)` — merges price/meta/orderSummary patches into the persisted
    `snapshot:full:v1` blob (1 KV read + 1 KV write). Called at the end of every `prewarmBatch`
    and `prewarmOrderSummaryCatalog` tick. After one full cursor pass over the entire catalog
    (~1-2 h) the snapshot is 100% populated with no per-invocation subrequest cap.
    Key translation on write: `price:{slug}:r{n}` → `{slug}:rank-v3:r{n}` so the client
    `importCache()` can consume the snapshot directly.
  - `buildFullSnapshot` and `batchedKvGet` have been **deleted**. Do not re-add them.
- `src/services/readThrough.ts`
  - Cache-first public-route behavior.
  - Handles stale refresh, negative markers, and in-flight dedupe.
- `src/security/cors.ts`
  - CORS allowlist checks and JSON response helper.
- `src/security/rateLimit.ts`
  - Admin route IP bucket limiter via KV.
  - Public route IP bucket limiter via KV.
- `src/security/bootstrap.ts`
  - Optional short-lived bootstrap token issue/verify flow for public APIs.
- `test/index.spec.ts`
  - Main Worker coverage file; update it when behavior changes.

## Security Model

Public protection is layered:

1. Cloudflare custom domain with edge rate limiting.
2. Worker-side public IP rate limiting (KV bucket per route).
3. CORS origin allowlist — `ALLOW_ORIGIN` is the comma-separated browser-origin allowlist;
   Electron/curl requests without an `Origin` header always pass through transparently.
4. Public-minimal `/healthz`; detailed health requires admin auth.
5. Early slug/rank validation against the ranked summary catalog.
6. `/v1/orders/:slug` disabled by default.
7. Optional bootstrap token enforcement for public APIs.

Keep `workers_dev = false` when relying on custom-domain edge rate limiting.

### Security implementation notes

- **`clientIp()`** lives in `src/utils.ts`. Do not add a local copy to `rateLimit.ts` or
  `bootstrap.ts`. The function reads `cf-connecting-ip` only — never `x-forwarded-for` (which
  is spoofable and is dead code when `workers_dev=false`).
- **Admin auth** uses an XOR-based constant-time comparison (`timingSafeEqual` in
  `src/security/adminAuth.ts`) to prevent timing side-channel attacks on the bearer token.
- **`cache-control`** on JSON responses defaults to `no-store`. Only successful public data
  responses that are intentionally cacheable (`/v1/prices`, `/v1/meta`,
  `/v1/order-summary`, and enabled `/v1/orders`) should opt into `public, max-age=60`.
  Bootstrap, healthz, auth errors, 404, 410, 429, and 5xx responses should stay `no-store`
  unless a route has an explicit negative-cache policy.

### Bootstrap token deployment sequence

The bootstrap system must be enabled in the correct order to avoid blocking existing clients:

1. **Set the secret**: `wrangler secret put BOOTSTRAP_TOKEN_SECRET`
2. **Deploy the desktop app** with `VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1` so clients begin
   fetching and sending tokens.
3. **Require tokens on the server**: set `PUBLIC_BOOTSTRAP_REQUIRED=1` in `wrangler.jsonc` and
   redeploy the worker.

If step 3 is applied before step 2, all public route requests from older app versions will
receive `401` and fall through to the direct-WFM fallback, degrading performance but not
breaking the app. Reverse the order when disabling: set `PUBLIC_BOOTSTRAP_REQUIRED=0` first,
then remove `BOOTSTRAP_TOKEN_SECRET`.

### Bootstrap guard rule

`requireBootstrapIfNeeded` in `src/routes/public.ts` must fail closed when
`PUBLIC_BOOTSTRAP_REQUIRED=1` but `BOOTSTRAP_TOKEN_SECRET` is absent. Required mode without a
secret is a server misconfiguration, not a deployment grace path. Keep tests explicit by setting
both `PUBLIC_BOOTSTRAP_REQUIRED=1` and a test secret when bootstrap-protected public routes should
be reachable.

## Testing Pattern

- `test/index.spec.ts` mixes two useful styles:
  - direct `worker.fetch(...)` calls for unit-style route/service assertions
  - `SELF.fetch(...)` for integration-style coverage through the Worker test harness
- Prefer targeted additions to `test/index.spec.ts` over creating parallel one-off files unless the
  test surface becomes large enough to justify a split.

## Automatic Backend Behavior

The end-to-end automatic flow (cache-first → live read-through → write-back → background
stale refresh → cron prewarm → incremental `patchSnapshot()`) is described in `README.md`
→ **Fully automatic mode**. Invariants that must be preserved:

- Confirmed misses set negative markers: `miss:price:*`, `miss:meta:*`, `miss:orders:*`,
  `miss:orders-summary:*`.
- Transient upstream failures must **not** set negative markers.
- The untradable marker `skip:untradable:*` prevents repeated meta fetches.
- Manual admin prewarm is optional maintenance, never required for app correctness.

## Important Data Model Notes

- `/v1/order-summary/:slug` returns the cached summary payload used by ranked inventory cards.
- `/v1/orders/:slug` is disabled by default and should stay deprecated unless explicitly re-enabled.
- `/v1/bootstrap` issues a short-lived optional bootstrap token when `BOOTSTRAP_TOKEN_SECRET` is configured.
- Preserve desktop response shapes:
  - success: `{ ok, data }`
  - failure: `{ ok: false, error }`
- `GET /healthz` is public-minimal by default; detailed automation/prewarm data only returns for authorized admin requests.

## Env Vars

The full env-var catalog with descriptions is the **Key vars** section of
`README.md` (single source of truth — do not restate it here). Key
invariants and the relationship constraints follow.

`SNAPSHOT_REFRESH_INTERVAL_SEC` has been removed — the snapshot is no longer periodically rebuilt
from KV. It is maintained incrementally via `patchSnapshot()` after every prewarm batch. Do not
re-add periodic snapshot rebuilds.

`ORDERS_SUMMARY_CACHE_TTL_SEC` must stay significantly larger than
`ORDERS_SUMMARY_STALE_REFRESH_SEC`, which should stay aligned with the desktop order-summary
freshness window.

Current default cache values in `wrangler.jsonc` are:

- `PREWARM_BATCH_SIZE=100`
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE=18`
- `limits.cpu_ms=1000`
- `CATALOG_SLUG_GUARD_ENABLED=1`
- `DAILY_BUDGET_ENABLED=1`, `DAILY_BUDGET_MAX_REQUESTS=300000`,
  `DAILY_BUDGET_SAMPLE_RATE=100`, `DAILY_BUDGET_SYNC_INTERVAL_SEC=60`
- 24h KV TTL with a 21h stale-refresh threshold for prices
- 48h KV TTL with a 21h stale-refresh threshold for ranked card summaries
- public rate limiting enabled
- public `/v1/orders/*` disabled by default
- bootstrap token support available but not required by default

Keep those relationships intentional if you change either side.

### Public rate limit sizing

Current limits for `prices`, `meta`, and `order-summary` routes are **2,000 requests per 600 s**
per IP. This is intentionally generous because:

- These are **secondary** defence behind Cloudflare edge rate limiting; real bot traffic is caught
  at the edge before reaching these counters.
- KV counter increments are non-atomic, so parallel bursts can temporarily exceed the declared
  limit by the degree of concurrency before the counter catches up.
- Rate-limit keys intentionally share the `PRICE_CACHE` KV namespace using an `rl:` prefix. Do not
  add a separate binding unless operational noise or blast-radius pressure makes it worth the
  deployment/config churn.

Do not lower these limits without accounting for the above. If tightening is needed, add
Cloudflare zone-level rate limiting rules at the edge instead.

The **`snapshot`** bucket uses a much tighter limit: **10 requests per 600 s per IP**.
The ~850 KB payload is expensive per-request; the Cloudflare edge `max-age=7200` cache absorbs
nearly all real app traffic, so this worker-side limit only fires on edge cache misses or scrapers.

When adding or changing bindings in `wrangler.jsonc`, run:

```bash
npx wrangler types
```

## Commands

From `backend/worker`:

```bash
npm run dev
npm run test -- --run
npm run test -- --run test/index.spec.ts
npm run test -- --run test/index.spec.ts -t "returns health status (unit style)"
npm run deploy
npm run cf-typegen
```

From repo root:

```bash
npm run backend:test
npm run backend:test -- test/index.spec.ts
npm run backend:test -- test/index.spec.ts -t "returns health status (unit style)"
npm run backend:deploy
npm run backend:typegen
npm run backend:prewarm:order-summaries -- -ApiKey "<ADMIN_API_KEY>" -RefreshCatalog
npm run backend:prewarm:order-summaries:hotset -- -ApiKey "<ADMIN_API_KEY>"
```

## Type And Style Expectations

- Worker TS is strict.
- Preserve existing subtree style; avoid unrelated reformatting.
- Keep `src/index.ts` thin and move behavior into routes or services.
- Prefer explicit types at request, env, and payload boundaries.
- Use shared helpers from `config/shared/*.ts` carefully; they are cross-runtime.

## Safety And Edit Rules

- Preserve slug validation.
- Preserve CORS, admin bearer auth, and rate limiting.
- Do not move business logic into `src/index.ts`.
- Do not collapse summary routes into full-orderbook behavior.
- Do not break `{ ok, data }` / `{ ok: false, error }` response contracts expected by the desktop app.
- Keep health and admin routes lightweight and explicit.
- Preserve hard-coded ranked exclusions for `veiled` rivens and non-tradable `Blood For ...` mods.
- Preserve the rule that transient upstream failures return `unavailable` only when no cached entry,
  including stale data, is available.
- Add or update tests in `test/index.spec.ts` for any behavior change.

## Cache Invariants

- KV TTLs must stay meaningfully higher than stale-refresh thresholds.
- If KV TTL approaches the stale threshold, stale-if-error collapses and transient upstream failures
  can become user-visible 503s.
- Negative markers should only represent confirmed no-data conditions, never transient failures.
- Order summary freshness should stay aligned with desktop cache expectations unless both sides are
  changed intentionally.

