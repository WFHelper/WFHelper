import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeDucats } from "../config/shared/numeric";
import { normalizeWfmSlug } from "../config/shared/wfm";
import { toIconMirrorUrl } from "./itemDatabase";

const log = withScope("relicService");

/**
 * Relic database built from @wfcd/items
 *
 * Groups all Warframe relics by "Tier Code" (e.g. "Axi A1"), exposing all four
 * quality variants (Intact/Exceptional/Flawless/Radiant) with their per-item
 * drop chances and WFM slugs. Also provides a uniqueName->group lookup so the
 * renderer can cross-reference player inventory (LevelKeys[]).
 */

const WFCD_CDN = "https://cdn.warframestat.us/img/";
const QUALITIES = new Set(["Intact", "Exceptional", "Flawless", "Radiant"]);

type RelicQualityKey = "intact" | "exceptional" | "flawless" | "radiant";
const TIERS = new Set(["Lith", "Meso", "Neo", "Axi", "Requiem", "Vanguard"]);

interface RelicReward {
  name: string;
  uniqueName: string | null;
  imageUrl: string | null;
  rarity: string;
  chance: number;
  urlName: string | null;
  wfmId: string | null;
  ducats: number | null;
}

interface RelicQuality {
  uniqueName: string | null;
  rewards: RelicReward[];
}

interface RelicGroup {
  key: string;
  name: string;
  tier: string;
  code: string;
  vaulted: boolean;
  imageUrl: string | null;
  qualities: Record<string, RelicQuality>;
}

interface RelicDatabase {
  groups: Record<string, RelicGroup>;
  byUniqueName: Record<string, { groupKey: string; quality: RelicQualityKey }>;
}

let _db: RelicDatabase | null = null;

function buildWfcdImageUrl(imageName: string | null | undefined): string | null {
  const trimmed = typeof imageName === "string" ? imageName.trim() : "";
  return trimmed ? toIconMirrorUrl(WFCD_CDN + trimmed) : null;
}

function buildRelicDatabase(): RelicDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped @wfcd/items constructor
  let Items: any;
  try {
    Items = require("@wfcd/items");
  } catch (err) {
    log.error("[RelicDB] @wfcd/items not available:", normalizeErrorMessage(err));
    return { groups: {}, byUniqueName: {} };
  }

  const all = new Items();
  const groupsMap = new Map<string, RelicGroup>();
  const byUniqueNameMap = new Map<string, { groupKey: string; quality: RelicQualityKey }>();

  for (const relic of all) {
    if (relic.category !== "Relics") continue;

    const parts = (relic.name || "").split(" ");
    if (parts.length < 3) continue;

    const quality = parts[parts.length - 1];
    if (!QUALITIES.has(quality)) continue;

    const tier = parts[0];
    if (!TIERS.has(tier)) continue;

    const baseName = parts.slice(0, -1).join(" ");
    const code = parts.slice(1, -1).join(" ");

    if (!groupsMap.has(baseName)) {
      groupsMap.set(baseName, {
        key: baseName,
        name: baseName,
        tier,
        code,
        vaulted: Boolean(relic.vaulted),
        imageUrl: null,
        qualities: {},
      });
    }

    const group = groupsMap.get(baseName)!;
    group.vaulted = Boolean(group.vaulted && relic.vaulted);

    if (relic.imageName) {
      if (quality === "Intact" || !group.imageUrl) {
        group.imageUrl = buildWfcdImageUrl(relic.imageName);
      }
    }

    group.qualities[quality.toLowerCase()] = {
      uniqueName: relic.uniqueName || null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped @wfcd/items reward
      rewards: (relic.rewards || []).map((r: any) => {
        const rawSlug = r.item?.warframeMarket?.urlName || r.item?.warframeMarket?.url_name || null;
        return {
          name: r.item?.name || "Unknown",
          uniqueName: r.item?.uniqueName || null,
          imageUrl: buildWfcdImageUrl(r.item?.imageName),
          rarity: r.rarity || "Common",
          chance: r.chance || 0,
          urlName: normalizeWfmSlug(rawSlug),
          wfmId: r.item?.warframeMarket?.id || null,
          ducats: normalizeDucats(r.item?.ducats),
        };
      }),
    };

    if (relic.uniqueName) {
      byUniqueNameMap.set(relic.uniqueName, {
        groupKey: baseName,
        quality: quality.toLowerCase() as RelicQualityKey,
      });
    }
  }

  const groups = Object.fromEntries(groupsMap);
  const byUniqueName = Object.fromEntries(byUniqueNameMap);

  return { groups, byUniqueName };
}

/**
 * Returns the relic database (cached after first call).
 */
export function getRelicDatabase(): RelicDatabase {
  if (!_db) {
    log.time("[RelicDB] build");
    _db = buildRelicDatabase();
    const n = Object.keys(_db.groups).length;
    log.info(`[RelicDB] ${n} relic groups indexed`);
    log.timeEnd("[RelicDB] build");
  }
  return _db;
}
