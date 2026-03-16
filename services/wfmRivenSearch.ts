"use strict";

/**
 * wfmRivenSearch.ts — Warframe.market riven auction search (main-process only)
 *
 * Searches the WFM v1 auction API for similar rivens by weapon name.
 * Results are cached in-memory with a 10-minute TTL.
 */

import { withScope } from "./logger";
const wfmClient = require("./wfmClient") as typeof import("./wfmClient");

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

/**
 * Search warframe.market for riven auctions matching the given weapon.
 *
 * @param weaponSlug — WFM URL slug (e.g. "rubico_prime")
 * @param opts.limit — max results to return (default 5)
 */
export async function searchSimilarRivens(
  weaponSlug: string,
  opts?: { limit?: number },
): Promise<WfmRivenListing[]> {
  const limit = opts?.limit ?? 5;

  // Check cache
  const cached = _cache.get(weaponSlug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.listings.slice(0, limit);
  }

  try {
    const path = `/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weaponSlug)}&sort_by=price_asc&buyout_policy=with`;
    const data = await wfmClient.request("GET", path) as any;

    const auctions: any[] = data?.payload?.auctions || [];
    const listings: WfmRivenListing[] = [];

    for (const a of auctions) {
      if (!a.item?.attributes) continue;

      const stats = (a.item.attributes as any[]).map((attr: any) => ({
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

    // Cache the full result
    _cache.set(weaponSlug, { listings, timestamp: Date.now() });
    pruneCache();

    log.log(`[WfmRivenSearch] Found ${listings.length} auctions for "${weaponSlug}"`);
    return listings.slice(0, limit);
  } catch (err: any) {
    log.warn(`[WfmRivenSearch] Search failed for "${weaponSlug}":`, err?.message || err);
    return [];
  }
}
