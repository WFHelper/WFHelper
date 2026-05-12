export function rendererPriceCacheKey(slug: string, rank: number | null): string {
  return rank == null ? slug : `${slug}:rank-v3:r${rank}`;
}

export function rendererOrderSummaryCacheKey(slug: string, rank: number | null): string | null {
  return rank == null ? null : `${slug}:r${rank}`;
}

function rendererRankedCacheKey(slug: string, rank: number | null): string {
  return rank == null ? slug : `${slug}:r${rank}`;
}

// Order-book cache lookups and ranked request de-dupe intentionally share the
// same renderer key encoding.
export function rendererOrderBookCacheKey(slug: string, rank: number | null): string {
  return rendererRankedCacheKey(slug, rank);
}

export function rendererRankedRequestKey(slug: string, rank: number | null): string {
  return rendererRankedCacheKey(slug, rank);
}

export function workerPriceCacheKey(slug: string, rank: number | null): string {
  return rank == null ? `price:${slug}` : `price:${slug}:r${rank}`;
}

export function workerOrdersCacheKey(slug: string, rank: number | null): string {
  return rank == null ? `orders:${slug}` : `orders:${slug}:r${rank}`;
}

export function workerOrderSummaryCacheKey(slug: string, rank: number | null): string {
  return rank == null ? `orders-summary:${slug}` : `orders-summary:${slug}:r${rank}`;
}

export function workerMissCacheKey(prefix: string, slug: string, rank: number | null): string {
  return rank == null ? `${prefix}${slug}` : `${prefix}${slug}:r${rank}`;
}

type WfmCacheKeyNamespace =
  | "renderer-price"
  | "renderer-ranked"
  | "worker-price"
  | "worker-orders"
  | "worker-order-summary";

interface ParsedWfmCacheKey {
  namespace: WfmCacheKeyNamespace;
  slug: string;
  rank: number | null;
}

function parseRankedSuffix(value: string): { slug: string; rank: number | null; priceV3: boolean } {
  const priceRank = /^(.*):rank-v3:r(\d+)$/.exec(value);
  if (priceRank) {
    return { slug: priceRank[1], rank: Number(priceRank[2]), priceV3: true };
  }

  const rank = /^(.*):r(\d+)$/.exec(value);
  if (rank) {
    return { slug: rank[1], rank: Number(rank[2]), priceV3: false };
  }

  return { slug: value, rank: null, priceV3: false };
}

export function parseWfmCacheKey(key: string): ParsedWfmCacheKey | null {
  if (!key) return null;

  const workerPrefixes: Array<[WfmCacheKeyNamespace, string]> = [
    ["worker-order-summary", "orders-summary:"],
    ["worker-orders", "orders:"],
    ["worker-price", "price:"],
  ];

  for (const [namespace, prefix] of workerPrefixes) {
    if (key.startsWith(prefix)) {
      const parsed = parseRankedSuffix(key.slice(prefix.length));
      return parsed.slug ? { namespace, slug: parsed.slug, rank: parsed.rank } : null;
    }
  }

  const parsed = parseRankedSuffix(key);
  if (!parsed.slug) return null;
  return {
    namespace: parsed.priceV3 ? "renderer-price" : "renderer-ranked",
    slug: parsed.slug,
    rank: parsed.rank,
  };
}

export function snapshotCacheKeyFromWorkerKey(workerKey: string): string | null {
  const parsed = parseWfmCacheKey(workerKey);
  if (!parsed) return null;
  if (parsed.namespace === "worker-price") return rendererPriceCacheKey(parsed.slug, parsed.rank);
  if (parsed.namespace === "worker-order-summary") {
    return rendererOrderSummaryCacheKey(parsed.slug, parsed.rank);
  }
  return null;
}
