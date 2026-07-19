import { writable } from "svelte/store";

const PRICE_REVISION_DEBOUNCE_MS = 150;

export const priceCacheRevision = writable<number>(0);

let revisionTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePriceCacheRevision(): void {
  if (revisionTimer) return;
  revisionTimer = setTimeout(() => {
    revisionTimer = null;
    priceCacheRevision.update((value) => value + 1);
  }, PRICE_REVISION_DEBOUNCE_MS);
}
