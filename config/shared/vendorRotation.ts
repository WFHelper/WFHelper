/** The two adversary vendor rotations run on fixed UTC grids. The worldstate
 *  carries no rotation data for either, so the anchors are the community wiki
 *  Countdown epochs and a re-seeded cycle needs a new anchor here. Shared by the
 *  renderer countdowns and the worker route that names the active Coda batch. */

export type VendorRotation = "tenet" | "coda";

export const VENDOR_ROTATION_MS = 4 * 24 * 60 * 60_000;

/** Tenet and Coda run the same period offset by one day. */
export const VENDOR_ROTATION_ANCHORS: Record<VendorRotation, number> = {
  tenet: Date.UTC(2015, 11, 3),
  coda: Date.UTC(2025, 2, 18),
};

/** Which period `nowMs` falls in, counted from the anchor and negative before it. */
function vendorRotationIndex(nowMs: number, anchorMs: number, periodMs: number): number {
  return Math.floor((nowMs - anchorMs) / periodMs);
}

/** Start of the period after the one `nowMs` falls in, so an instant exactly on
 *  a boundary counts as the period it opens rather than the one it closes. */
export function nextVendorRotationMs(nowMs: number, anchorMs: number, periodMs: number): number {
  return anchorMs + (vendorRotationIndex(nowMs, anchorMs, periodMs) + 1) * periodMs;
}

/** Eleanor alternates two fixed batches on the wiki's 8-day loop: even periods
 *  of the 4-day grid are Batch A, odd ones Batch B. */
export function codaBatchAt(nowMs: number): "A" | "B" {
  const index = vendorRotationIndex(nowMs, VENDOR_ROTATION_ANCHORS.coda, VENDOR_ROTATION_MS);
  return ((index % 2) + 2) % 2 === 0 ? "A" : "B";
}
