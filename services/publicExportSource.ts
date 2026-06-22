/**
 * Fetches DE's official Public Export so masterable items track live patches,
 * instead of waiting on the bundled npm packages to republish. Overlays only
 * warframes/weapons/sentinels; the bundled package owns everything else and is
 * the offline fallback.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { withScope } from "./logger";

const log = withScope("publicExport");

// DE serves a tiny LZMA-compressed index of hash-suffixed manifest filenames,
// then plain-JSON manifests under /Manifest/.
const INDEX_URL = "https://content.warframe.com/PublicExport/index_en.txt.lzma";
const MANIFEST_BASE = "https://content.warframe.com/PublicExport/Manifest/";

// Exports that carry masterable items. Keys match itemDatabase's expectations.
const OVERLAY_KEYS = ["ExportWarframes", "ExportWeapons", "ExportSentinels"] as const;
type OverlayKey = (typeof OVERLAY_KEYS)[number];

// Strip control chars DE leaves in its JSON, keeping the legal \t \n \r.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

interface DeItem {
  uniqueName?: string;
  name?: string;
  productCategory?: string;
  masteryReq?: number;
  [key: string]: unknown;
}

type KeyedExport = Record<string, DeItem>;

export interface PublicExportOverlay {
  /** Per-export item maps keyed by uniqueName, ready to merge into itemDatabase. */
  exports: Partial<Record<OverlayKey, KeyedExport>>;
}

interface CachePayload {
  updatedAt: string;
  /** Hashed manifest filename per export — lets us skip unchanged downloads. */
  index: Partial<Record<OverlayKey, string>>;
  exports: Partial<Record<OverlayKey, KeyedExport>>;
}

let overlay: PublicExportOverlay | null = null;
let refreshPromise: Promise<{ changed: boolean }> | null = null;

function cachePath(): string {
  return path.join(app.getPath("userData"), "public-export-cache.json");
}

function lzmaDecompress(buffer: Buffer): Promise<string> {
  // lzma-js handles DE's LZMA-alone (.lzma) stream as-is.
  const lzma = require("lzma") as {
    decompress: (data: Int8Array, cb: (result: unknown, err: unknown) => void) => void;
  };
  return new Promise((resolve, reject) => {
    lzma.decompress(new Int8Array(buffer), (result, err) => {
      if (err) return reject(err instanceof Error ? err : new Error(String(err)));
      resolve(Buffer.from(result as ArrayLike<number>).toString("utf8"));
    });
  });
}

/** Map base export name (e.g. "ExportWarframes_en.json") → its hashed filename. */
async function fetchIndex(): Promise<Map<string, string>> {
  const res = await fetch(INDEX_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`index HTTP ${res.status}`);
  const text = await lzmaDecompress(Buffer.from(await res.arrayBuffer()));
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    map.set(trimmed.split("!")[0], trimmed);
  }
  return map;
}

async function fetchManifest(hashedName: string, exportKey: OverlayKey): Promise<KeyedExport> {
  const res = await fetch(MANIFEST_BASE + hashedName, { redirect: "follow" });
  if (!res.ok) throw new Error(`${exportKey} HTTP ${res.status}`);
  const parsed = JSON.parse((await res.text()).replace(CONTROL_CHARS, " ")) as Record<
    string,
    DeItem[]
  >;
  const arr = parsed[exportKey];
  if (!Array.isArray(arr)) return {};
  const keyed: KeyedExport = {};
  for (const item of arr) {
    if (item?.uniqueName) keyed[item.uniqueName] = item;
  }
  return keyed;
}

function readCache(): CachePayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Partial<CachePayload>;
    if (!parsed.updatedAt || !parsed.exports || typeof parsed.exports !== "object") return null;
    return { updatedAt: parsed.updatedAt, index: parsed.index || {}, exports: parsed.exports };
  } catch {
    return null;
  }
}

function writeCache(payload: CachePayload): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(payload), "utf8");
  } catch (err) {
    log.warn("Failed to write public-export cache", err);
  }
}

/** Sync read of the cached DE overlay, for use during the initial DB build. */
export function loadOverlayFromDisk(): PublicExportOverlay | null {
  if (overlay) return overlay;
  const cached = readCache();
  if (!cached) return null;
  overlay = { exports: cached.exports };
  return overlay;
}

export function getOverlay(): PublicExportOverlay | null {
  return overlay;
}

/**
 * Refreshes the on-disk overlay from DE, re-downloading only manifests whose
 * hash changed. Returns whether anything changed so the caller can rebuild.
 */
export async function refreshOverlayFromDE(): Promise<{ changed: boolean }> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const previous = readCache();
    try {
      const index = await fetchIndex();
      const nextIndex: Partial<Record<OverlayKey, string>> = {};
      const nextExports: Partial<Record<OverlayKey, KeyedExport>> = {};
      let changed = false;

      for (const exportKey of OVERLAY_KEYS) {
        const hashedName = index.get(`${exportKey}_en.json`);
        if (!hashedName) continue;
        nextIndex[exportKey] = hashedName;

        if (previous?.index?.[exportKey] === hashedName && previous.exports?.[exportKey]) {
          nextExports[exportKey] = previous.exports[exportKey];
          continue;
        }
        nextExports[exportKey] = await fetchManifest(hashedName, exportKey);
        changed = true;
      }

      overlay = { exports: nextExports };
      writeCache({ updatedAt: new Date().toISOString(), index: nextIndex, exports: nextExports });

      const counts = OVERLAY_KEYS.map(
        (k) => `${k.replace("Export", "")}=${Object.keys(nextExports[k] || {}).length}`,
      ).join(" ");
      log.info(`DE public export refreshed (${changed ? "updated" : "unchanged"}): ${counts}`);
      return { changed };
    } catch (err) {
      if (previous) {
        overlay = { exports: previous.exports };
        log.warn("DE public export fetch failed — using cached overlay", err);
      } else {
        log.warn("DE public export fetch failed — no cache, using bundled package", err);
      }
      return { changed: false };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function setOverlayForTest(value: PublicExportOverlay | null): void {
  overlay = value;
  refreshPromise = null;
}
