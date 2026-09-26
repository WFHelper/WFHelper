# Worker architecture

`backend/worker` is the shared Warframe Market cache the desktop app uses. This document explains
which module handles what at runtime and the rules the code relies on. See `README.md` for setup
and admin commands.

## Runtime layout

- `src/index.ts` handles CORS rejection, route dispatch, 404 responses, request logging, and cron.
- `src/routes/public.ts` serves the health, bootstrap, snapshot, item-catalog, supporters,
  top-traded, baro-history, price-history, adversary-vendor, nightwave-offerings, price, meta, and
  order routes.
- `src/routes/admin.ts` serves the authenticated prewarm, catalog, hotset, and status routes, the
  supporter exclusion and sync routes, and the daily active user count (`stats/active-users`).
- `src/routes/feedback.ts` validates opt-in reports and forwards them to a private Discord webhook.
- `src/services/readThrough.ts` handles cache-first reads, stale refresh, negative markers, and
  deduplication of requests already in flight.
- `src/services/prewarm.ts` runs catalog walks, upstream refreshes and snapshot patches, and holds
  the `SnapshotCoordinator` Durable Object.
- `src/services/wfmStatistics.ts` makes the `/v1/items/{slug}/statistics` request and parses the
  closed days that both the price seed and the top-traded sweep read.
- `src/security/rateLimit.ts` selects Cloudflare Rate Limiting bindings.
- `src/security/dailyBudget.ts` holds the sampled request budget and the `DailyBudgetCounter`
  Durable Object.
- `src/security/bootstrap.ts` issues and verifies optional short-lived public API tokens.
- `src/security/client.ts` parses the `x-wfhelper-client` product and version header and applies the
  client policy.

`src/index.ts` stays small. Route and service logic goes in the modules above.

## Public request flow

Public requests go through these checks:

1. CORS allowlist validation for requests with an `Origin` header.
2. The client policy, on public routes only (see below).
3. A route-specific Cloudflare Rate Limiting binding keyed by the connecting IP.
4. The daily request budget.
5. Bootstrap token validation where required.
6. Slug and rank validation before any upstream request.
7. KV read-through, stale refresh, and negative-cache handling.

Rank validation reads the ranked order-summary catalog through a five-minute isolate cache. An
empty catalog is never cached, because callers treat it as `catalog_unavailable`.

Electron and command-line clients normally omit `Origin` and are allowed. Browser origins must
match `ALLOW_ORIGIN`. `clientIp()` trusts only `cf-connecting-ip`.

Rate Limiting binding defaults in `wrangler.jsonc` are per IP:

- health: 5 per minute
- bootstrap and full orders: 60 per minute
- prices, meta, order summaries, supporters, top traded, price history, Baro history, adversary
  vendors, and Nightwave offerings: 200 per minute
- snapshot and item catalog: 2 per minute
- admin: 60 per minute

When a public limiter fails, the request goes through so the app can still read. When the admin
limiter fails, the request is refused with `503 rate_limit_unavailable`. Zone-level WAF rules still
run first.

`POST /v1/feedback` runs after the shared CORS and daily-budget checks. It is anonymous and
does not require bootstrap. Its separate `FEEDBACK_RATE_LIMITER` allows 2 requests per minute
per connecting IP, then `FEEDBACK_GLOBAL_LIMITER` caps all senders together at 10 per minute.
When either limiter fails, the request is refused, even when the public read limiters are turned
off. A missing limiter or a missing `FEEDBACK_DISCORD_WEBHOOK_URL` secret returns 503. The route
reads the JSON as a stream up to a size limit, then checks it against the report schema it shares
with the desktop app. Delivery only goes to allowlisted Discord webhook URLs, with redirects and
mentions turned off and a 15-second limit that covers the whole body.
Only a successful `wait=true` message receipt counts as delivery. Feedback has no automatic retry,
KV persistence, or content logging. See README for private channel setup and retention details.

## Client identity

Desktop requests carry `x-wfhelper-client: <product>/<version>`. The product comes from
`APP_PRODUCT_NAME` in `config/shared/appMeta.ts`, so a fork that keeps this backend announces its
own name instead of WFHelper. `parseClientHeader()` accepts a product of 1-32 characters
(`A-Za-z0-9`, space, `.`, `_`, `-`, starting alphanumeric) and a version of 1-24 characters
starting with a digit (`v` is stripped on the client, dev builds send `0.0.0`); a header over 96
characters or one that fails either pattern counts as absent.

Every request logs one line with `client` (the product, or `none`) and `clientVersion` alongside
the existing route fields. No IP, token, or other header is recorded.

Policy vars, parsed in `src/config.ts`:

- `PUBLIC_CLIENT_POLICY`: `log` (default) records clients without blocking; `enforce` answers
  `403 forbidden_client` to a missing, malformed, or unlisted client.
- `PUBLIC_CLIENT_ALLOW`: comma list of product names accepted under `enforce`, default `WFHelper`.
  A value that parses to no names (blank, whitespace or commas) keeps the default, because an
  empty allow list would refuse everyone.
- `PUBLIC_CLIENT_DENY`: comma list of product names refused under either policy, default empty.

The check covers public data routes and non-browser callers. `OPTIONS`, `/healthz` and
`/admin/*` are exempt, the last because admin routes carry their own key, and so is any request
with an `Origin` header, because `handleFetch` has already refused an origin outside the CORS
allow list. Desktop apps and forks send no `Origin`, which is exactly what this check is for.
`test/smoke.spec.ts` sends `WFHelper/0.0.0`; `scripts/prewarm-order-summaries.ps1` calls only
`/admin/*` and sends no header.

Names are compared case-insensitively. Wait with `enforce` until installed versions that send no
header have updated: every WFHelper release before this change sends no header and would be
locked out. The bootstrap token is still bound only to the IP and user agent, so the header just
says who claims to be calling and proves nothing. A fork can send any product name it likes, which
is why the deny list exists.

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

The old admin snapshot-build route was removed on purpose. It rebuilt from a truncated KV scan
and could replace a complete snapshot with partial data.

Snapshot keys have to stay readable by the desktop importers. Ranked worker keys such
as `price:{slug}:r{n}` become `{slug}:rank-v3:r{n}` in the snapshot.

Price entries carry `priceBasis: "closed-volume-average-48h-v1"`. The retained `median` field
contains the volume-weighted average of closed-trade `wa_price` buckets from the last 48 hours.
The Worker and desktop reject price cache entries with an older or missing basis; snapshot
patching removes those entries while prewarm and read-through refill them. Deploy the Worker
before releasing the desktop change, and check that its snapshot contains prices with the new
basis. A partially refreshed snapshot can contain fewer prices until the catalog sweep advances.

## WFM item catalog

`GET /v1/wfm-items` serves the desktop-safe subset of the Warframe Market item catalog from
KV key `catalog:client-items:v1`. The catalog refresh writes this key alongside the slug catalog,
and the route keeps its response in the edge cache for six hours.

If the client-shaped key is absent, the route first follows the normal refresh cadence. A fresh
slug catalog from an older deployment can make that refresh a no-op, so the route then forces one
upstream refresh before returning `503 catalog_not_ready`. Empty upstream responses never replace
a valid catalog.

The catalog response carries the same body ETag treatment as the snapshot, keyed by
`WFM_ITEMS_CACHE_VERSION`. The ETag is stored in the edge-cached entry, so matching
`If-None-Match` requests return 304 from both the Cache API hit and a freshly built body.

## Relic order subtypes

`GET /v1/order-summary/{slug}?subtype=intact|exceptional|flawless|radiant` serves relic prices per
refinement. Relics are absent from the ranked catalog, so the subtype path replaces rank validation
instead of extending it: the slug must end in `_relic` and the subtype must be one of the four
values, or the route returns `400 invalid_subtype` before any upstream request.

Hydration reuses the normal orders fetch and filters it to the requested subtype; an order without a
`subtype` field counts as intact. Cache and negative-marker keys carry a `:s{subtype}` segment
(`orders-summary:{slug}:s{subtype}`, `miss:orders-summary:v1:{slug}:s{subtype}`) so they never
collide with the ranked `:r{rank}` family. TTL, stale refresh, and negative markers are unchanged.
Subtype entries stay out of the snapshot; the desktop requests them on demand.

Bare `/v1/order-summary/{slug}` requests keep the existing rank-required behavior.

## Supporter credits (Discord-sourced)

`GET /v1/supporters` serves KV key `supporters:discord:v1` as
`{ ok: true, updatedAt, supporters: [{ name, tier }] }` with tier `basic | big | biggest`. The route
is public, needs no bootstrap token, uses the same rate limit as prices and meta, and is edge-cached
for one hour. A missing or empty key returns `updatedAt: null` with an empty list and is never
edge-cached, so the first sync after setup appears immediately.

`services/supporters.ts` runs the sync. It pages the Discord guild members endpoint (`Bot` token
auth, `limit=1000` with `after` pagination), keeps non-bot members whose role ids map through
`DISCORD_ROLE_TIER_MAP`, and takes the highest tier when a member holds several mapped roles. The
published name is the server nickname, then the global display name, then the username. The
Patreon Discord integration assigns the tier roles, so the Patreon API is never called; its
`full_name` is often a legal name and is never published. Sync is a logged no-op when the
guild id, bot token, or role map is absent. Every successful sync also deletes the retired
Patreon-pipeline keys (`patreon:supporters:v1`, `patreon:tokens:v1`, `patreon:exclusions:v1`),
which held profile names and OAuth tokens.

`supporters:exclusions:v1` is a JSON array of strings. A supporter is excluded when the Discord
user id or the case-insensitive, whitespace-collapsed display name matches an entry (published
names are whitespace-collapsed the same way). `POST /admin/supporters/exclusions`
(`{ set: string[] }`) replaces the list and immediately drops matching names from the published KV
value; a body whose `set` is not an array is rejected with 400 so a malformed call cannot wipe the
list. Raw user ids are never retained, so an id exclusion applies at the next sync.
`POST /admin/supporters/sync` runs the sync and returns `{ ok: true, count, status }`.

After an opt-out, KV drops the name immediately, but the edge cache can serve the previous list for
up to one hour and the desktop app caches a non-empty list for up to 24 hours, so an excluded name
can stay visible on clients for up to a day after the admin call. Leaving the guild or unlinking
Discord from Patreon removes the role, so those names drop at the next sync without admin action.

The vars `DISCORD_GUILD_ID` and `DISCORD_ROLE_TIER_MAP` (JSON role id to tier) are parsed in
`src/config.ts`. The secret is `DISCORD_BOT_TOKEN`; the bot needs the Server Members intent and
membership in the guild, but no channel permissions. Both supporter KV keys live in `ITEM_META` with
no expiration.

## Read-through and prewarm

Confirmed misses use `miss:price:*`, `miss:meta:*`, `miss:orders:*`, and
`miss:orders-summary:*`. Transient upstream errors never create negative markers.
`skip:untradable:*` prevents repeated metadata requests for excluded items.

The bare `price:{slug}` key is rank-pinned. Prewarm and the `/v1/prices/{slug}` read-through
share `barePriceFetchRank()`: a slug listed in the ranked order-summary catalog prices from
rank 0 sales. Explicit rank requests use that rank only. Without an explicit rank, the shared
average parser accepts rankless and rank 0 rows and excludes higher ranks.
`readRankedSlugsFromKv()` resolves `order-summary:catalog:v1` from `ITEM_META` through the same
five-minute isolate cache as rank validation. Only an available catalog is cached, so a KV blip
cannot pin hydration on the fallback below for the whole window, and a catalog refresh reaches
an isolate at most five minutes late.

When the ranked catalog is unavailable (`null`, rather than an authoritative empty one),
prewarm skips the price half of the sweep and leaves the stored price alone. Read-through still
hydrates using the parser's rankless and rank 0 rule. The next sweep after the catalog returns
restores explicit rank 0 selection for ranked slugs.

Only an answered upstream request may drop a cached price; a transient failure or an HTTP error
leaves the last good price with the current basis. Prices and their negative markers live in
`PRICE_CACHE`; both catalogs live in `ITEM_META`. Successful price, meta, and order-summary
responses carry `public, max-age=60`, so a PoP can serve a hydrated value for up to a minute after
KV changes.

Prewarm cron runs every 15 minutes and also advances the riven history sweep, the one-time
price-history seed, the top-traded volume sweep and the Baro retry. The separate daily `0 4 * * *`
trigger runs the price archive, the supporter sync and the Baro archive, in that order. Each cron
stage is wrapped in its own try/catch and logs under `cron:{stage}`, so one failing stage costs only
itself. The price archive makes no upstream request and its day cannot be reconstructed later, so it
runs ahead of the daily budget gate; every other stage is skipped once the budget has tripped.
Current production defaults are:

- `PREWARM_BATCH_SIZE=125`
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE=36`
- 24-hour TTL for prices and meta
- 48-hour order-summary TTL
- 21-hour stale-refresh threshold for both cache families
- `limits.cpu_ms=1000`

Cron is a rolling backstop. Fresh entries are copied into the snapshot without another upstream
request, while stale entries are refreshed before being patched.

## History archives

Three archive families accrue from the day they are deployed. Only prices can be backfilled, and
only once: the Warframe Market statistics endpoint serves 90 days of daily closed-trade medians
per item, while it serves no past auctions and DE publishes no past Baro manifests. Outside that
one seed a gap in an archive stays a gap.

Keys live in `ITEM_META`:

- `archive:prices:{YYYY-MM-DD}` copies snapshot prices on the `0 4 * * *` tick. Existing row
  tuples and column names remain `[key, median, volume?]`, but `priceBasisByKey` records each
  tagged snapshot entry's basis. New snapshot prices are 48-hour averages, not daily medians;
  legacy untagged rows remain untagged. Snapshot keys are kept verbatim, so ranked entries stay
  `{slug}:rank-v3:r{n}`. This family makes no upstream request; it copies data the worker already
  holds. The first write of a UTC day wins, so a retried cron never rewrites the day.
- `archive:rivens:{YYYY-MM-DD}` holds weapon-level riven auction aggregates as
  `[weapon, min, median, sample]`. Auctions carry no sales volume, so the sample count is the only
  depth figure. A price is the auction's `buyout_price`, else its `starting_price`. A weapon
  missing from a day either had no priced auction or failed its request that day.
- `archive:baro:{visitId}` holds one visit as node, activation, expiry, and manifest rows
  `[item uniqueName, ducats, credits]`. `visitId` is `d{activationMs}`; archives from the earlier
  collector may carry the world-state `_id.$oid`, which DE reuses for every visit. Version 2
  normalizes `/Lotus/StoreItems/...` to the corresponding inventory item path and records unknown
  prices as `null`, preserving explicit zero. Version 1 archives remain readable; their zero prices
  become unknown during migration because the old collector also encoded missing prices as zero.

`archive:index:{family}:v1` lists that family's ids, oldest first. Retention is the
`HISTORY_RETENTION_DAYS` window (730 days) applied twice: every archive value is written with a
matching `expirationTtl`, and each new write trims the index to the bound and deletes the ids it
drops, at most eight per run because the TTL reclaims the rest. The Baro index is bounded in
visits rather than days, since Baro appears roughly every two weeks.

The riven sweep runs on the 15-minute prewarm tick, not the daily one. About 250 weapons do not
fit in one invocation, so `archive:riven-sweep:v1` carries `{date, cursor, complete}` and each
tick processes `RIVEN_ARCHIVE_BATCH_SIZE` weapons (12) with one serialized request each, the same
pacing as the prewarm sweep and 13 requests on top of prewarm's 251. The day's key is
rewritten after every batch with `complete: false` and finalized with `complete: true` on the tick
that reaches the end of the list; the remaining ticks of that UTC day idle without any upstream
request. A full pass takes about five hours, so one sweep completes per day. The weapon list comes
from `/v1/riven/items` and is cached in `archive:riven-weapons:v1` for 24 hours; an empty or failed
refresh keeps the stored list. The sweep state carries the list its cursor indexes, pinned on the
first tick of the day: the 24-hour refresh can otherwise land mid-sweep and a shifted or shortened
list would move weapons past the cursor unvisited. A same-day state with no pinned list restarts
the day from index 0 rather than trusting a cursor into an unknown list.

The price seed is a one-time sweep rather than a cadence. `archive:price-seed:v1` holds
`{startedDate, cursor, complete, failures, retryPass, retrySlugs, failedSlugs}`, and
`complete: true` turns it off for good: a finished seed costs one KV read on the 15-minute tick and
makes no request, even after a redeploy. It walks the same slug catalog the prewarm sweep walks,
pinned on the first tick into `archive:price-seed:slugs:v1` so a mid-sweep catalog refresh cannot
shift the cursor, and processes `PRICE_SEED_BATCH_SIZE` slugs (20) per tick with one serialized
`GET /v1/items/{slug}/statistics` each. About 4,000 slugs take roughly 200 ticks, so a full seed
runs about two days.

Day rows come from `statistics_closed["90days"]`. Rank semantics mirror the live bare price: a slug
in the ranked order-summary catalog takes the `mod_rank` 0 entries, any other slug takes the entries
carrying no rank, and the last entry of a date wins. The seed rounds positive daily medians and
tags new rows in `priceBasisByKey` as `closed-daily-median-v1`; it does not reconstruct the
snapshot's rolling 48-hour average. Negative and zero prices are rejected. Rivens and Baro have
no statistics endpoint and are never seeded.

Each batch buffers its rows in memory and then read-modify-writes only the days it touched, up to
90 day keys and therefore around 180 KV operations on top of the batch's requests. An existing row
is never replaced: a day the live archive wrote keeps its prices, `generatedAt`, `source` and
price metadata and only gains the keys it lacks, while a day the seed creates carries
`source: "wfm-statistics-seed"`. Days on or after `startedDate` are never touched because the live
daily archive owns them. A seeded day expires on the retention window measured from its own date,
and every touched day joins `archive:index:prices:v1` once through the shared index helper, which
sorts the dated families so seeded days stay ahead of the live ones that pruning drops first.

A failed or malformed statistics response counts the slug as failed and the sweep moves on, but the
slug is queued in `failedSlugs` rather than dropped. When the cursor reaches the end of a pass, a
non-empty failure list starts another pass over exactly those slugs (`retryPass` up to 3,
`retrySlugs` pinned the same way the catalog is) instead of latching. The latch closes only when a
pass ends with no failures or the retry budget is spent, and an exhausted budget logs the remaining
count as `seed_retries_exhausted`. Without that, a WFM outage during the roughly two-day sweep would
lose those slugs' 90 days for good, since the statistics endpoint serves no older window. No
negative marker is written either way, and the running failure total lives in the state key. An
unavailable slug catalog or ranked catalog leaves the cursor where it is and retries on the next
tick, because without the ranked catalog a mixed-rank median would be archived permanently.
`PRICE_SEED_ENABLED=0` stops the seed before it starts, as does `HISTORY_ARCHIVE_ENABLED=0`.

Baro comes from the first source that answers: the warframestat.us mirror
(`/pc/voidTrader?language=en`), then the DE world state (`VoidTraders`; `PrimeVaultTraders` is
Varzia and is never read here). Since at least 2026-09-04 `api.warframe.com` answers the Worker
with 403 and an empty body whatever the headers, while the same request from a desktop succeeds;
`content.warframe.com/dynamic/worldState.php` is 404 everywhere. The mirror carries the same
manifest: `uniqueName` is the raw `ItemType`, `ducats` and `credits` the two prices, dates are ISO
and `location` is a display name that is stored as the node. Either source's visit is keyed by its
activation, not by DE's `_id`. Each source that fails logs an `error` on `archive:baro` with the
HTTP status (502 when there is none) and `source`. While Baro is live, a source that lists no
manifest logs `baro_source_empty_manifest` and the next source is tried. A body is read through a
byte cap rather than trusted by `content-length`, which a chunked response omits entirely. A body
past 32MB is abandoned mid-stream, and a 15-second deadline covers headers and body. Only a live
visit carrying a manifest is recorded, because an announced manifest can still change before
activation.

Every answered fetch stores the current or next visit window in `archive:baro-window:v1`, and a
recorded visit adds its id as `recorded`. The quarter-hour tick reads that key, and while the window
is live and neither `recorded` nor the archive shows the visit it runs the
same fetch and write, so a visit the daily run missed, or one the mirror listed late, is recorded
within 15 minutes. Otherwise the retry costs one or two KV reads and no request. A retry that finds
no manifest skips reconciliation; one that records a visit reconciles as the daily tick does. An
existing archive is kept while later ticks repair the durable history and index.

Failure policy matches the caches. An empty or failed upstream answer never replaces or deletes an
existing archive, no negative markers are written, and each archive step catches its own errors so a
failing archive cannot break prewarm or the supporter sync. `HISTORY_ARCHIVE_ENABLED=0` stops all
three families. Every write logs its byte size on route `archive:prices`, `archive:rivens`,
`archive:baro`, or `archive:price-seed`, and a value past 4MB is refused rather than stored.

### Per-item price series

`services/priceHistory.ts` folds the day archives into 64 documents at
`history:prices:v2:{bucket}`. Each holds `{ v: 2, updatedAt, revisions, afterDate, series }`;
`series` maps a bare slug or `{slug}:rank-v3:r{n}` to `[date, median, volume|null]` entries,
sorted by date and capped at 400 per key. The bucket is the fnv1a-32 hash of the bare slug modulo
64, so every rank of an item shares a document. Version 2 rebuilds from the retained day archives
instead of trusting the old date-only cursor.

Each price-archive write assigns a revision and records it in `archive:index:prices:v1`.
The daily writer, volume merger and seed reannounce an existing revision on unchanged retries,
so a failed index write can recover after the day value was saved. Older archives without a
revision use the `legacy` marker.

`foldPriceHistory()` advances one bucket per 15-minute tick;
`history:prices:state:v2` holds `{ bucket, updatedAt }`. It selects up to 30 dates whose indexed
revision differs from the bucket's acknowledged revision and reads their archives one at a time.
A successful fold replaces that date's entries. Missing or unreadable days remain pending, as do
values whose revision has not caught up with the index under KV propagation. The per-bucket
`afterDate` cursor rotates pending dates so repeated failures cannot block newer days.

Rows tagged `closed-daily-median-v1` use their stored price. Other tagged prices, including
snapshot 48-hour averages, require a separately recorded `dailyMedians` value and are skipped
until it arrives. Legacy untagged rows retain their stored value. Non-positive or non-finite
prices are skipped; absent volume stays `null`.

An idle tick advances the bucket without rewriting its document. A document over 4MB is refused
with `history_too_large` on route `history:prices`, and the bucket still advances. The stage
runs alongside the deferred price-seed and top-traded stages, outside the tick that collides with
the daily cron. `HISTORY_ARCHIVE_ENABLED=0` stops it.

`GET /v1/price-history/{slug}` returns
`{ ok: true, slug, generatedAt, rows: [[date, rank|null, median, volume|null]] }`, sorted by date
then rank. The ranked catalog identifies bare mod rows as rank 0 even when no explicit ranked
siblings exist; unranked items use `null`. When a bare row needs classification and the catalog
is unavailable, the route returns uncached `503 {"ok":false,"error":"catalog_unavailable"}`.

The route needs no bootstrap token, uses the same rate limit as prices and meta, and caches
successful responses for one hour with a body ETag. Excluded slugs return the shared 404. Unbuilt buckets
return `404 {"ok":false,"error":"price_history_not_ready"}`; a built bucket with no matching
series returns `404 {"ok":false,"error":"not_found"}`. These failures are not cached. The
desktop can refresh previously archived rows from this route while preserving its direct WFM
statistics. Archive rows supply no OHLC, average-price or Donchian values.

## Baro visit history

`GET /v1/baro-history` returns `{ ok: true, data: { version, updatedAt, coverageStart, visits,
lastSeen } }`: public, no bootstrap, the API rate limiter, a one-hour edge cache (five minutes
while the history is empty) and body ETags. Missing, invalid or unreadable durable data answers 503
and is never cached. The route reads one KV key; it never reconstructs archives, fetches upstream
or writes.

`services/baroHistory.ts` owns `ITEM_META` key `baro:history:v1` (no TTL): at most 128 visit
manifests, trimmed by `HISTORY_RETENTION_DAYS`, and 5,000 per-item last-seen records that survive
their visit's removal. `coverageStart` is the earliest visit recorded or recovered, not a promise
that every later visit is present; a missing item means unknown, not never sold. Prices are the
observed ducat and credit costs, each nullable, and nothing is predicted.

The daily Baro stage reconciles the retained archives on every tick, Baro active or not. One prefix
listing finds manifests a failed index write left out; more than 128 ids stops the pass with
`baro_archive_scan_limit`, and archives are read eight at a time. A missing or failed read keeps
the pass incomplete and blocks index pruning until a later tick succeeds. The envelope keeps up to
128 acknowledged archive ids in `archivedVisits` (never served): an id is acknowledged once its
parsed manifest is materialized or its malformed source is quarantined, after which its archive may
expire without blocking anything. The ledger is trimmed only when an id has left both the index and
the listing, and it is written together with the history document before pruning.

Malformed archives are copied to `baro:history:recovery:archives:v1` (no TTL, 128 sources, 4MB)
before acknowledgement; overflow or a failed copy blocks acknowledgement and pruning. A corrupt
durable document is saved to `baro:history:recovery:v1` before its valid visits and dates are
salvaged, and a later valid tick leaves that key alone. Persistent
`baro_history_migration_incomplete`, `baro_archive_recovery_limit` or `baro_archive_scan_limit`
errors need a look rather than an automatic discard.

The current raw manifest is written before reconciliation, so a migration failure cannot lose the
only live copy DE publishes; the index is updated and pruned only after that write, once per tick.
Last-seen dates never move backward, a stable visit id lets a corrected expiry replace an older one,
and treasure boxes are excluded as on the desktop. KV has no cross-isolate atomic merge, so the
quarter-hour retry skips the daily minute, where both triggers fire concurrently, and otherwise
is separated from the daily stage in time.

## Top traded (rolling volume sweep)

`GET /v1/top-traded` serves KV key `top-traded:v1` as
`{ ok: true, generatedAt, windowDays: 7, items: [{ slug, name, volume, median, value, thumb? }], byValue }`.
`items` is the top 100 slugs by seven-day volume; `byValue` is that same list ordered by
`volume * median`, so the client toggles views by joining slugs back onto `items` instead of
carrying a second copy. The route is public, needs no bootstrap token, uses the same rate limit as
prices and meta, and is edge-cached for one hour with a body ETag. Before the first aggregate lands
the route answers `404 {"ok":false,"error":"top_traded_not_ready"}` and is never cached, so
the first published doc shows up immediately. `readTopTradedDoc()` revalidates the stored doc at
the boundary; a malformed one reads as absent rather than being served.

The daily price archive copies snapshot prices without volume, and the one-time seed writes
volume only for the 90 days before it started.
`services/topTraded.ts` fills the gap: on the 15-minute tick it walks the same slug catalog the
prewarm sweep and the price seed walk, requesting `GET /v1/items/{slug}/statistics` for
`TOP_TRADED_BATCH_SIZE` slugs (150) with one serialized request each. It requests the last eight
calendar days of `statistics_closed["90days"]`, drops the current UTC day (its volume is still
growing and a merged volume is never replaced, so a partial value would freeze), and merges the
seven complete days as `(date, median, volume)` into `archive:prices:{date}` through
`mergeVolumes()` in `history.ts`. Rank semantics mirror the seed: a slug in the ranked
order-summary catalog takes the `mod_rank` 0 rows, any other slug takes the rankless rows, so the
daily volume and daily median describe the same sales. Negative prices are rejected. An
unavailable slug or ranked catalog leaves the cursor where it is and retries on the next tick.

`mergeVolumes()` never replaces a price or a volume another writer stored. An existing row that
lacks a volume gains one, a slug the day does not hold is appended, and a day whose key does not
exist is created only when the date is already past: the daily archive owns the first write of the
current UTC day and would skip it if this created the key. Days created here join
`archive:index:prices:v1`, and every write carries the retention TTL measured from the day's own
date. New rows carry `closed-daily-median-v1`; rows with an average or another tagged basis keep
their price and gain the fetched daily median in `dailyMedians`. Both merge paths preserve
`priceBasisByKey` and `dailyMedians` without migrating old archives.

Sweep state is `top-traded:sweep:v1` (`{cursor, slugsHash, lastCompletedAt, failures}`). The cursor
wraps continuously rather than latching, so a slug whose request failed is simply asked again on the
next pass; the failure count resets at each wrap and a pass that ended with failures logs status 206
with `pass_failures` and the remaining count on route `top-traded:sweep`. `slugsHash` identifies the
list the cursor indexes without storing a second copy of it, and a catalog that gained or lost slugs
mid-pass restarts the pass instead of skipping past the shift. `TOP_TRADED_ENABLED=0` stops the
sweep and the aggregate, as does `HISTORY_ARCHIVE_ENABLED=0`.

The aggregate rebuilds at the end of every pass and at most hourly otherwise. It reads the last
seven complete UTC days (never the current one), sums volume per bare slug and keeps the newest
day's daily median. For tagged non-median rows it reads `dailyMedians` and skips the row until that
value exists; it never publishes the archived average as a median. Untagged legacy rows retain their
previous interpretation. Only bare-slug rows count: the snapshot copy's `{slug}:rank-v3:r{n}` keys
never carry a volume. Names and thumbnails come from the client catalog the worker already serves
for `/v1/wfm-items`; the thumbnail stays the raw catalog path and the desktop app resolves it
through its icon mirror. The doc is capped at 100 items and refused past 512KB, and it is written
with a 30-day TTL so a dead sweep eventually 404s instead of serving months-old figures.

On each 15-minute tick, KV operations count as subrequests too, so the upstream requests are the
smaller half. Prewarm spends up to 8 subrequests per slug (3 reads, 2 requests, 2 writes) and the
order-summary pass 6 per rank entry, so a tick where all of them are due reaches roughly 1,700
against Cloudflare's ~1000 subrequest cap; an ordinary tick stays far below it because most entries
are not stale yet. This sweep's own share is about 180: one request per slug, one read and one write
per touched day for at most eight days, the state key and the rebuild's nine reads. A full pass
takes `ceil(slugs / 150)` ticks: about
27 ticks (roughly 7 hours) at the ~4,000-slug catalog the price seed measures, and about 12 hours
if the catalog grows past 7,000. Lower `TOP_TRADED_BATCH_SIZE` to slow the pass and the request
rate together.

Volume only ever exists for days a pass reached while they were inside its
eight-day window, plus whatever the one-time seed wrote for the 90 days before it ran. Days
between the seed's start and this sweep's first pass keep prices without volume for good, and
those days simply contribute nothing once they fall out of the seven-day window. `/v1/top-traded`
therefore 404s for the first pass after deploy and reports a short window until seven swept days
have accumulated.

## Adversary vendors (wiki-sourced)

`GET /v1/adversary-vendors` serves KV key `adversary-vendors:doc:v1` as
`{ ok: true, generatedAt, source: "wiki", coda: { batch, items }, codaNext: { batch, items }, tenet: { items } }`,
where an item is `{ name, element, bonus }`. The route is public, needs no bootstrap token, uses the
same rate limit as prices and meta, and is edge-cached for one hour with a body ETag. Before the
first refresh lands it answers `404 {"ok":false,"error":"adversary_vendors_not_ready"}` and is
never cached.

Source: the raw wikitext of `Coda_Weapons` and `Tenet_Weapons`. DE publishes no vendor rotation, so
the elements and bonus percentages are player-reported wiki tables and nothing else. Requests carry
the user agent `WFHelper-worker/1.0 (+https://wfhelper.com)`. A request posing as a browser gets a
403 challenge page instead of the article, so the Worker never pretends to be one.
`services/adversaryVendors.ts` parses the weapon, element and bonus tables inside the pages' timer
sections, rejects a row without a name, an element or a finite 0-100 bonus, and treats the whole
fetch as failed when a coda batch parses under seven rows or the tenet table under five.

Eleanor's batch is time-derived, not stored: index `floor(((now - 2025-03-18T00:00:00Z) mod 8d) / 4d)`
of the wiki loop, where 0 is Batch A. The doc holds both batches, the route serves the active one
and names the other under `codaNext`, and the edge-cache key carries the batch letter so a rotation
is served immediately rather than after the cached hour. Ergo Glast's five melees are always stocked;
only their element and bonus reroll, on the wiki's own 4-day grid anchored 2015-12-03T00:00:00Z.

`refreshAdversaryVendors()` runs on the 15-minute prewarm tick as cron stage
`cron:adversary-vendors` and rebuilds at most hourly, so it costs two upstream requests an hour.
A failed fetch or an unparsable page leaves the stored doc untouched with its old `generatedAt`,
logs status 204 with `wiki_unavailable` or `wiki_unparsed` on route `adversary-vendors:refresh`,
and never writes a partial doc. The doc carries a 30-day TTL. The desktop app validates every row
again on read and simply shows the weapons without bonuses when the route is absent or unreachable.

## Nightwave offerings (wiki-sourced)

`GET /v1/nightwave-offerings` serves KV key `nightwave-offerings:doc:v1` as
`{ ok: true, generatedAt, source: "wiki", tabs }`, where a tab is `{ name, sections }`, a section is
`{ name, creds, items }` and an item is `{ name, always, creds }`. The route is public, needs no
bootstrap token, uses the same rate limit as prices and meta and is edge-cached for one hour with a
body ETag; before the first refresh it answers `404 {"ok":false,"error":"nightwave_offerings_not_ready"}`
and is never cached.

The source is the raw wikitext of `Nightwave/Offerings`, fetched with the same
`WFHelper-worker/1.0` user agent the vendor tables use. `services/nightwaveOfferings.ts` reads
the `<tabber>` tabs, their `===` headings (a `({{Nc|N}} each)` parenthetical prices the whole
section) and the `<gallery>` captions, unwrapping `{{M|X}}` and `[[Page|X]]` markup. Bold marks
an offer as always available, a caption's own `{{Nc|N}}` beats the section price, and a name
repeated inside one tab is kept once.

`refreshNightwaveOfferings()` runs on the 15-minute prewarm tick as cron stage
`cron:nightwave-offerings` and rebuilds at most hourly. A fetch failure or a parse under eight tabs
or 150 items counts as failed: the stored doc keeps its old `generatedAt`, the run logs status 204
with `wiki_unavailable` or `wiki_unparsed` on route `nightwave-offerings:refresh`, and no partial
doc is written. The doc carries a 30-day TTL and caps tabs at 12, sections at 40 per tab, items at
120 per section and creds at 1000. The desktop app validates every row again on read and falls
back to its built-in permanent list when the route is absent or unreachable.

## Daily budget

`DAILY_BUDGET_ENABLED=1` enables a sampled daily request cap. The current cap is 300,000 requests
with a sample rate of 100. Samples are recorded atomically in the `DailyBudgetCounter` Durable
Object named for the UTC day. Unsampled requests never touch the Durable Object; once a sampled
request observes the tripped cap, the isolate caches the trip until the next UTC day and rejects
every request from memory. Tripped requests return `503 daily_budget_exceeded` until the next UTC
day and scheduled prewarm skips work.

Cloudflare billing alerts still have to be set up separately, because repository code cannot
create account-level billing notifications.

## Bootstrap deployment

Required bootstrap mode needs `BOOTSTRAP_TOKEN_SECRET`; without it, protected public routes refuse
every request. Enable it in this order:

1. Run `npx wrangler secret put BOOTSTRAP_TOKEN_SECRET` from `backend/worker`.
2. Release the desktop app with `VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1`.
3. Set `PUBLIC_BOOTSTRAP_REQUIRED=1` and deploy the Worker.

Reverse that order when disabling. Older desktop versions fall back to direct Warframe Market
requests if the Worker returns 401.

## Response and cache rules

- Responses keep the envelopes the desktop expects: `{ ok, data }` and `{ ok: false, error }`.
- Successful public data may use explicit public cache headers. Auth errors, 404, 410, 429, and
  5xx responses stay `no-store` unless a route has a deliberate negative-cache policy.
- KV TTLs stay well above the stale-refresh thresholds.
- `/v1/orders/:slug` stays disabled by default. The desktop normally consumes summaries.
- `GET /healthz` is public and returns only a minimal status. Detailed status needs admin
  authorization.
- `workers_dev=false` is needed when you rely on the custom domain and zone rules.

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

Unit and integration tests live in `test/`, with top-level Worker cases in `index.spec.ts`.
A scheduled GitHub Actions job runs `test/smoke.spec.ts` against the deployed custom domain every
six hours.
