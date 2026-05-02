export function rendererPriceCacheKey(slug: string, rank: number | null): string {
  return rank == null ? slug : `${slug}:rank-v3:r${rank}`;
}

export function rendererOrderSummaryCacheKey(slug: string, rank: number | null): string | null {
  return rank == null ? null : `${slug}:r${rank}`;
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

export function snapshotPriceCacheKey(slug: string, rank: number | null): string {
  return rendererPriceCacheKey(slug, rank);
}

export function snapshotOrderSummaryCacheKey(slug: string, rank: number | null): string | null {
  return rendererOrderSummaryCacheKey(slug, rank);
}
