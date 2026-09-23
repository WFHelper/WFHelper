// Use live DE exports so new items do not wait for a package release.

import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { readPepExport } from "./bundledGameData";
import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";

const log = withScope("publicExport");

// DE serves a tiny LZMA-compressed index of hash-suffixed manifest filenames,
// then plain-JSON manifests under /Manifest/.
const INDEX_URL = "https://content.warframe.com/PublicExport/index_en.txt.lzma";
const MANIFEST_BASE = "https://content.warframe.com/PublicExport/Manifest/";

// DE's item exports omit icon paths; this manifest maps uniqueName -> texture.
const IMAGE_MANIFEST = "ExportManifest.json";

// Per request, covering the body: the image manifest is several MB.
const FETCH_TIMEOUT_MS = 60_000;

const OVERLAY_KEYS = [
  "ExportWarframes",
  "ExportWeapons",
  "ExportRailjackWeapons",
  "ExportSentinels",
  "ExportUpgrades",
  "ExportResources",
  "ExportRelics",
  "ExportArcanes",
  "ExportRecipes",
  "ExportGear",
  "ExportKeys",
  "ExportDrones",
  "ExportFusionBundles",
  "ExportCustoms",
  "ExportFlavour",
] as const;
type OverlayKey = (typeof OVERLAY_KEYS)[number];

// Strip control chars DE leaves in its JSON, keeping the legal \t \n \r.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

interface DeItem {
  uniqueName?: string;
  name?: string;
  productCategory?: string;
  masteryReq?: number;
  icon?: string;
  relicRewards?: unknown;
  [key: string]: unknown;
}

type KeyedExport = Record<string, DeItem>;

interface ManifestSpec {
  file: string;
  arrayKey: string;
  keys: OverlayKey[];
  target: (item: DeItem) => OverlayKey;
}

function plain(file: string, key: OverlayKey): ManifestSpec {
  return { file: `${file}_en.json`, arrayKey: key, keys: [key], target: () => key };
}

// One DE manifest feeds several package exports: weapons carry railjack armaments,
// and only relicRewards separates relics from arcanes in their shared file.
const MANIFESTS: ManifestSpec[] = [
  plain("ExportWarframes", "ExportWarframes"),
  plain("ExportWeapons", "ExportWeapons"),
  {
    file: "ExportWeapons_en.json",
    arrayKey: "ExportRailjackWeapons",
    keys: ["ExportRailjackWeapons"],
    target: () => "ExportRailjackWeapons",
  },
  plain("ExportSentinels", "ExportSentinels"),
  plain("ExportUpgrades", "ExportUpgrades"),
  plain("ExportResources", "ExportResources"),
  {
    file: "ExportRelicArcane_en.json",
    arrayKey: "ExportRelicArcane",
    keys: ["ExportRelics", "ExportArcanes"],
    target: (item) => (Array.isArray(item.relicRewards) ? "ExportRelics" : "ExportArcanes"),
  },
  plain("ExportRecipes", "ExportRecipes"),
  plain("ExportGear", "ExportGear"),
  plain("ExportKeys", "ExportKeys"),
  plain("ExportDrones", "ExportDrones"),
  plain("ExportFusionBundles", "ExportFusionBundles"),
  plain("ExportCustoms", "ExportCustoms"),
  plain("ExportFlavour", "ExportFlavour"),
];

const KEPT_FIELDS = [
  "uniqueName",
  "name",
  "description",
  "icon",
  "masteryReq",
  "primeSellingPrice",
  "tradable",
  "vaulted",
  "productCategory",
  "parentName",
  "era",
  "category",
  "defaultWeapon",
  "excludeFromCodex",
  "codexSecret",
  "resultType",
  "buildPrice",
  "buildTime",
  "num",
  "consumeOnUse",
  "ingredients",
] as const;

interface PublicExportOverlay {
  /** Per-export item maps keyed by uniqueName, ready to merge into itemDatabase. */
  exports: Partial<Record<OverlayKey, KeyedExport>>;
  /** uniqueName -> "path!contentHash" from DE's image manifest (icon mirror fallbacks). */
  images: Record<string, string> | null;
}

interface CachePayload {
  updatedAt: string;
  index: Record<string, string>;
  exports: Partial<Record<OverlayKey, KeyedExport>>;
  imagesIndex?: string;
  images?: Record<string, string>;
}

let overlay: PublicExportOverlay | null = null;
let refreshPromise: Promise<{ changed: boolean }> | null = null;

const cache = createJsonCache<CachePayload>("public-export-cache.json", (raw) => {
  const parsed = raw as Partial<CachePayload>;
  if (!parsed.updatedAt || !parsed.exports || typeof parsed.exports !== "object") return null;
  const cachedIndex =
    parsed.index && typeof parsed.index === "object" && !Array.isArray(parsed.index)
      ? parsed.index
      : null;
  const index =
    cachedIndex && Object.keys(cachedIndex).some((key) => key.endsWith(".json")) ? cachedIndex : {};
  return {
    updatedAt: parsed.updatedAt,
    index,
    exports: parsed.exports,
    imagesIndex: typeof parsed.imagesIndex === "string" ? parsed.imagesIndex : undefined,
    images: parsed.images && typeof parsed.images === "object" ? parsed.images : undefined,
  };
});

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

/** Map base export name (e.g. "ExportWarframes_en.json") -> its hashed filename. */
async function fetchIndex(): Promise<Map<string, string>> {
  const text = await withAbortTimeout(
    FETCH_TIMEOUT_MS,
    async (signal) => {
      const res = await fetch(INDEX_URL, { redirect: "follow", signal });
      if (!res.ok) throw new Error(`index HTTP ${res.status}`);
      return lzmaDecompress(Buffer.from(await res.arrayBuffer()));
    },
    new Error("index fetch timed out"),
  );
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    map.set(trimmed.split("!")[0], trimmed);
  }
  return map;
}

async function fetchManifestText(hashedName: string, file: string): Promise<string> {
  return withAbortTimeout(
    FETCH_TIMEOUT_MS,
    async (signal) => {
      const res = await fetch(MANIFEST_BASE + hashedName, { redirect: "follow", signal });
      if (!res.ok) throw new Error(`${file} HTTP ${res.status}`);
      return res.text();
    },
    new Error(`${file} fetch timed out`),
  );
}

async function fetchManifest(hashedName: string, file: string): Promise<Record<string, unknown>> {
  const text = await fetchManifestText(hashedName, file);
  return JSON.parse(text.replace(CONTROL_CHARS, " ")) as Record<string, unknown>;
}

async function fetchImageManifest(hashedName: string): Promise<Record<string, string>> {
  const text = await fetchManifestText(hashedName, IMAGE_MANIFEST);
  const parsed = JSON.parse(text.replace(CONTROL_CHARS, " ")) as {
    Manifest?: { uniqueName?: string; textureLocation?: string }[];
  };
  const map: Record<string, string> = {};
  for (const entry of parsed.Manifest || []) {
    if (entry?.uniqueName && typeof entry.textureLocation === "string") {
      map[entry.uniqueName] = entry.textureLocation;
    }
  }
  return map;
}

function bundledExports(): Partial<Record<OverlayKey, Record<string, unknown>>> {
  const tables: Partial<Record<OverlayKey, Record<string, unknown>>> = {};
  for (const key of OVERLAY_KEYS) {
    try {
      const table = readPepExport(key);
      if (table) tables[key] = table;
    } catch (err) {
      log.warn(`bundled ${key} unreadable, keeping every DE entry for it`, err);
    }
  }
  return tables;
}

function trimEntry(item: DeItem): DeItem {
  const source = item as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) {
    if (source[field] !== undefined) kept[field] = source[field];
  }
  return kept as DeItem;
}

/** DE's item exports carry no icon field - fill it from the image manifest. */
function enrichIconsFromImages(
  exportMaps: Partial<Record<OverlayKey, KeyedExport>>,
  images: Record<string, string> | undefined,
): void {
  if (!images) return;
  for (const key of OVERLAY_KEYS) {
    for (const item of Object.values(exportMaps[key] || {})) {
      if (item.icon || !item.uniqueName) continue;
      const texture = images[item.uniqueName];
      if (texture) item.icon = texture.split("!")[0];
    }
  }
}

/** Sync read of the cached DE overlay, for use during the initial DB build. */
export function loadOverlayFromDisk(): PublicExportOverlay | null {
  if (overlay) return overlay;
  const cached = cache.read();
  if (!cached) return null;
  overlay = { exports: cached.exports, images: cached.images || null };
  return overlay;
}

export function getOverlay(): PublicExportOverlay | null {
  return overlay;
}

export async function refreshOverlayFromDE(): Promise<{ changed: boolean }> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const previous = cache.read();
    try {
      const index = await fetchIndex();
      const bundled = bundledExports();
      const nextIndex: Record<string, string> = {};
      const nextExports: Partial<Record<OverlayKey, KeyedExport>> = {};
      let changed = false;

      const files = [...new Set(MANIFESTS.map((spec) => spec.file))];
      if (!files.some((file) => index.has(file))) {
        throw new Error(`index lists none of the ${files.length} expected manifests`);
      }
      for (const file of files) {
        const hashedName = index.get(file);
        if (!hashedName) continue;
        nextIndex[file] = hashedName;
        const specs = MANIFESTS.filter((spec) => spec.file === file);

        if (previous?.index?.[file] === hashedName) {
          for (const key of specs.flatMap((spec) => spec.keys)) {
            const kept = previous.exports?.[key];
            if (kept) nextExports[key] = kept;
          }
          continue;
        }

        const manifest = await fetchManifest(hashedName, file);
        for (const spec of specs) {
          const arr = manifest[spec.arrayKey];
          if (!Array.isArray(arr)) continue;
          for (const raw of arr as DeItem[]) {
            if (!raw?.uniqueName) continue;
            const key = spec.target(raw);
            if (bundled[key]?.[raw.uniqueName]) continue;
            (nextExports[key] ??= {})[raw.uniqueName] = trimEntry(raw);
          }
        }
        changed = true;
      }

      const imagesHashed = index.get(IMAGE_MANIFEST);
      let nextImages = previous?.images;
      let nextImagesIndex = previous?.imagesIndex;
      if (imagesHashed && (imagesHashed !== previous?.imagesIndex || !nextImages || changed)) {
        const full = await fetchImageManifest(imagesHashed);
        // DE's image manifest is ~20k rows; only the overlay entries are ever looked up.
        nextImages = {};
        for (const key of OVERLAY_KEYS) {
          for (const uniqueName of Object.keys(nextExports[key] || {})) {
            const texture = full[uniqueName];
            if (texture) nextImages[uniqueName] = texture;
          }
        }
        nextImagesIndex = imagesHashed;
        changed = true;
      }
      enrichIconsFromImages(nextExports, nextImages);

      overlay = { exports: nextExports, images: nextImages || null };
      // A manifest DE stops listing changes the cache without setting `changed`.
      const listed = new Set(Object.keys(nextIndex));
      const dropped = Object.keys(previous?.index ?? {}).some((file) => !listed.has(file));
      if (changed || dropped || !previous) {
        cache.write({
          updatedAt: new Date().toISOString(),
          index: nextIndex,
          exports: nextExports,
          imagesIndex: nextImagesIndex,
          images: nextImages,
        });
      }

      const counts = OVERLAY_KEYS.filter((k) => Object.keys(nextExports[k] || {}).length)
        .map((k) => `${k.replace("Export", "")}=${Object.keys(nextExports[k] || {}).length}`)
        .join(" ");
      log.info(
        `DE public export refreshed (${changed ? "updated" : "unchanged"}): ${counts || "no gaps"}`,
      );
      return { changed };
    } catch (err) {
      if (previous) {
        overlay = { exports: previous.exports, images: previous.images || null };
        log.warn("DE public export fetch failed - using cached overlay", err);
      } else {
        log.warn("DE public export fetch failed - no cache, using bundled package", err);
      }
      return { changed: false };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}
