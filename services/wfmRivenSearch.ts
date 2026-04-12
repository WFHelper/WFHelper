/**
 * wfmRivenSearch.ts — Warframe.market riven auction search (main-process only)
 *
 * Searches the WFM v1 auction API for similar rivens by weapon name.
 * Results are cached in-memory with a 10-minute TTL.
 */

import { withScope } from "./logger";
import type { WfmRawAuction, WfmAuctionSearchPayload, WfmAuctionCreatePayload } from "./wfmTypes";
import { unwrapWfmResponse } from "./wfmTypes";
import * as wfmClient from "./wfmClient";

const log = withScope("wfmRivenSearch");

// ── Types ────────────────────────────────────────────────────────────────────

export interface WfmRivenListing {
  id: string;
  seller: string;
  platinum: number;
  stats: { name: string; value: number; positive: boolean }[];
  rerolls: number;
  startingPrice: number | null;
  buyoutPrice: number | null;
  isDirectSell: boolean;
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
  listings: WfmRivenListing[];
  timestamp: number;
}

const _cache = new Map<string, CacheEntry>();

function pruneCache(): void {
  if (_cache.size <= MAX_CACHE_ENTRIES) return;
  // Remove oldest entries
  const entries = [..._cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  const removeCount = _cache.size - MAX_CACHE_ENTRIES;
  for (let i = 0; i < removeCount; i++) {
    _cache.delete(entries[i][0]);
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

let _loggedWfmName = false;

function parseAuctions(auctions: WfmRawAuction[]): WfmRivenListing[] {
  const listings: WfmRivenListing[] = [];
  for (const a of auctions) {
    if (!a.item?.attributes) continue;
    if (!_loggedWfmName && a.item?.name) {
      log.log(`[WfmRivenSearch] WFM auction item.name format example: "${a.item.name}"`);
      _loggedWfmName = true;
    }

    const stats = a.item.attributes.map((attr) => ({
      name: String(attr.url_name || "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase()),
      value: typeof attr.value === "number" ? attr.value : 0,
      positive: attr.positive !== false,
    }));

    listings.push({
      id: a.id || "",
      seller: a.owner?.ingame_name || "Unknown",
      platinum: a.buyout_price ?? a.starting_price ?? 0,
      stats,
      rerolls: a.item?.re_rolls ?? 0,
      startingPrice: a.starting_price ?? null,
      buyoutPrice: a.buyout_price ?? null,
      isDirectSell: !!a.is_direct_sell,
    });
  }
  return listings;
}

// Riven mods only come in these three polarities.
const RIVEN_POLARITIES = ["madurai", "naramon", "vazarin"] as const;

/**
 * Search warframe.market for riven auctions matching the given weapon.
 *
 * The WFM API caps results at ~500 per query. For popular weapons with >500
 * auctions, a single price_asc+price_desc pair leaves a price gap in the middle
 * (e.g. 550–1500p range). To close that gap we split by polarity
 * (madurai/naramon/vazarin) × sort direction, giving up to ~3000 unique results.
 * For weapons with few auctions (<500) the first query already returns everything
 * and the extra queries add negligible overhead.
 *
 * @param weaponSlug — WFM URL slug (e.g. "rubico_prime")
 * @param opts.limit — max results to return (default 6)
 * @param opts.positiveStats — positive stat url_names to filter by (e.g. ["multishot", "critical_chance"])
 * @param opts.negativeStats — negative stat url_names to filter by
 */
export async function searchSimilarRivens(
  weaponSlug: string,
  opts?: { limit?: number; positiveStats?: string[]; negativeStats?: string[] },
): Promise<WfmRivenListing[]> {
  const limit = opts?.limit ?? 6;
  const posStats = opts?.positiveStats ?? [];
  const negStats = opts?.negativeStats ?? [];

  // Build a cache key that includes stat filters
  const cacheKey = [weaponSlug, ...posStats.sort(), "|", ...negStats.sort()].join(",");

  // Check cache
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.listings.slice(0, limit);
  }

  try {
    let statParams = "";
    for (const s of posStats) {
      statParams += `&positive_stats=${encodeURIComponent(s)}`;
    }
    for (const s of negStats) {
      statParams += `&negative_stats=${encodeURIComponent(s)}`;
    }

    const seenIds = new Set<string>();
    const allListings: WfmRivenListing[] = [];

    const addAuctions = (auctions: WfmRawAuction[]) => {
      for (const l of parseAuctions(auctions)) {
        if (!seenIds.has(l.id)) {
          seenIds.add(l.id);
          allListings.push(l);
        }
      }
    };

    // First, try a quick unfiltered price_asc to gauge result count.
    const quickPath =
      `/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weaponSlug)}${statParams}&sort_by=price_asc`;
    const quickPayload = unwrapWfmResponse<WfmAuctionSearchPayload>(await wfmClient.request("GET", quickPath));
    const quickAuctions = quickPayload?.auctions || [];
    addAuctions(quickAuctions);

    if (quickAuctions.length >= 490) {
      // Likely more than 500 total — use polarity × sort split for full coverage.
      for (const pol of RIVEN_POLARITIES) {
        for (const sort of ["price_asc", "price_desc"] as const) {
          const path =
            `/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weaponSlug)}` +
            `&polarity=${pol}${statParams}&sort_by=${sort}`;
          const payload = unwrapWfmResponse<WfmAuctionSearchPayload>(await wfmClient.request("GET", path));
          addAuctions(payload?.auctions || []);
        }
      }
    } else if (quickAuctions.length > 0) {
      // Small pool — also fetch price_desc just in case (cheap, already under 500).
      const descPath =
        `/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weaponSlug)}${statParams}&sort_by=price_desc`;
      const descPayload = unwrapWfmResponse<WfmAuctionSearchPayload>(await wfmClient.request("GET", descPath));
      addAuctions(descPayload?.auctions || []);
    }

    // Cache the full result
    _cache.set(cacheKey, { listings: allListings, timestamp: Date.now() });
    pruneCache();

    log.log(`[WfmRivenSearch] Found ${allListings.length} auctions for "${weaponSlug}"`);
    return allListings.slice(0, limit);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[WfmRivenSearch] Search failed for "${weaponSlug}":`, msg);
    return [];
  }
}

// ── Auction creation ─────────────────────────────────────────────────────────

interface CreateAuctionOpts {
  weaponSlug: string;
  rivenName: string;
  attributes: { url_name: string; value: number; positive: boolean }[];
  rerolls: number;
  masteryLevel: number;
  polarity: string;
  modRank: number;
  buyoutPrice: number | null;
  startingPrice: number;
  isPrivate: boolean;
  description: string;
}

/**
 * Create a riven auction on warframe.market.
 * Requires the user to be logged in (JWT token set in wfmClient).
 */
export async function createRivenAuction(
  opts: CreateAuctionOpts,
): Promise<{ ok: boolean; auctionId?: string; error?: string }> {
  const body: Record<string, unknown> = {
    item: {
      type: "riven",
      name: opts.rivenName.toLowerCase(),
      weapon_url_name: opts.weaponSlug,
      attributes: opts.attributes,
      re_rolls: opts.rerolls,
      mastery_level: opts.masteryLevel,
      polarity: opts.polarity,
      mod_rank: opts.modRank,
    },
    starting_price: opts.startingPrice,
    minimal_reputation: 0,
    private: opts.isPrivate,
  };

  if (opts.buyoutPrice != null && opts.buyoutPrice > 0) {
    body.buyout_price = opts.buyoutPrice;
  }
  if (opts.description.trim()) {
    body.note = opts.description.trim();
  }

  try {
    log.log(`[WfmRivenSearch] Creating auction for "${opts.weaponSlug}" polarity=${opts.polarity} rank=${opts.modRank} attrs=${opts.attributes.length}`);
    const data = await wfmClient.request("POST", "/auctions/create", { json: body });
    const payload = unwrapWfmResponse<WfmAuctionCreatePayload>(data);
    const auctionId = payload?.auction?.id;
    log.log(`[WfmRivenSearch] Created auction ${auctionId || "(no id)"} for "${opts.weaponSlug}"`);
    return { ok: true, auctionId: auctionId || undefined };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[WfmRivenSearch] Create auction failed for "${opts.weaponSlug}":`, msg);
    log.warn(`[WfmRivenSearch] Request body:`, JSON.stringify(body));
    return { ok: false, error: msg };
  }
}
