import { clampNumber } from "./numeric";
import { normalizeForSlug, sanitizeWfmSlug } from "./textNormalize";

/** Warframe.market user presence status. */
export type WfmStatus = "online" | "ingame" | "invisible";

/** Selectable "keep my status for" durations; 0 means the status never expires. */
export const WFM_STATUS_HOLD_MINUTES: readonly number[] = Object.freeze([0, 30, 60, 120, 240]);

/** Snap an arbitrary value onto the offered hold durations. */
export function normalizeWfmHoldMinutes(value: unknown, fallback = 0): number {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return fallback;
  return WFM_STATUS_HOLD_MINUTES.includes(minutes) ? minutes : fallback;
}

/** Minutes without keyboard or mouse input before the away rule hides the status. */
export const WFM_AWAY_IDLE_MINUTES_DEFAULT = 10;

/** Snap the away idle delay onto the 1-60 minute range the control offers. */
export function normalizeWfmAwayIdleMinutes(
  value: unknown,
  fallback: number = WFM_AWAY_IDLE_MINUTES_DEFAULT,
): number {
  return Math.round(clampNumber(value, 1, 60, fallback));
}

/** Only a visible presence can expire - invisible is already the resting state. */
export function wfmStatusCanExpire(status: WfmStatus): boolean {
  return status === "online" || status === "ingame";
}

/** Standard Warframe Market v1 request headers. */
export const WFM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
});

/** Base URL for warframe.market static assets (icons, thumbnails). */
const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

// Env access must survive the renderer bundle, where node globals don't exist.
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

const ICON_MIRROR_BASE = readEnv("WFHELPER_ICON_MIRROR_URL") || "https://assets.wfhelper.com";

// Strip content hashes so mirror keys survive WFM re-exports.
// Non-thumbnail assets stay upstream and return null.
export function wfmThumbMirrorPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const assetPath = pathname.replace(/^\/static\/assets\//, "");
  if (assetPath === pathname || !/(?:^|\/)thumbs\//.test(assetPath)) return null;

  const segments = assetPath.split("/");
  const filename = segments.pop() || "";
  const kept = filename.split(".").filter((part) => !/^[0-9a-f]{32}$/i.test(part));
  return `wfm/${[...segments, kept.join(".")].join("/")}`;
}

/** Normalize a WFM asset path to an absolute URL, thumbs via the WFHelper mirror. */
export function formatWfmAssetUrl(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `${WFM_ASSET_BASE}${trimmed}`;
  if (!absolute.startsWith(WFM_ASSET_BASE)) return absolute;
  if (readEnv("WFHELPER_ICON_MIRROR_DISABLED") === "1") {
    return absolute;
  }
  // WFM gates /static/assets behind a Cloudflare challenge, which blocks
  // renderer <img> loads outright - serve thumbs from our own mirror.
  const mirrorPath = wfmThumbMirrorPath(absolute);
  return mirrorPath ? `${ICON_MIRROR_BASE}/${mirrorPath}` : absolute;
}

export function titleFromSlug(slug: string): string {
  return String(slug)
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export { isWfmSlug, sanitizeWfmSlug } from "./textNormalize";

// A slug warframe.market minted survives verbatim; only a display name gets its
// punctuation folded into underscores. Zid-an Asheir is slugged with hyphens,
// so folding one would point every lookup at an item that does not exist.
export function normalizeWfmSlug(value: string | null | undefined): string | null {
  return sanitizeWfmSlug(value) ?? normalizeForSlug(value);
}

export function normalizeWfmSlugKey(value: unknown): string {
  return normalizeForSlug(typeof value === "string" ? value : null) ?? "";
}
