import { withScope } from "./logger";
import { readWfcdItems, type WfcdItem } from "./bundledGameData";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeDucats } from "../config/shared/numeric";
import { normalizeWfmSlug } from "../config/shared/wfm";
import { relicRewardRarity } from "./relicRarity";
import {
  localizedNameFields,
  lookupItem,
  lookupItemByNameOrSlug,
  toIconMirrorUrl,
} from "./itemDatabase";

const log = withScope("relicService");

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

interface RelicRewardItem {
  [key: string]: unknown;
  name: string;
  uniqueName: string | null;
  urlName: string | null;
  rarity: string;
  ducats: number | null;
  /** True only while every relic that can drop this reward is vaulted. */
  vaulted: boolean;
}

let _db: RelicDatabase | null = null;

export function getRelicRewardItems(): RelicRewardItem[] {
  const seen = new Map<string, RelicRewardItem>();
  for (const group of Object.values(getRelicDatabase().groups)) {
    for (const quality of Object.values(group.qualities)) {
      for (const reward of quality.rewards) {
        if (!reward.name) continue;
        const existing = seen.get(reward.name);
        if (existing) {
          existing.vaulted = existing.vaulted && group.vaulted;
          continue;
        }
        const resolved = lookupItemByNameOrSlug(reward.name, reward.urlName);
        const dbEntry =
          resolved?.item || (reward.uniqueName ? lookupItem(reward.uniqueName) : null);
        seen.set(reward.name, {
          name: reward.name,
          uniqueName: resolved?.uniqueName || reward.uniqueName || null,
          urlName: reward.urlName || null,
          rarity: reward.rarity || "Common",
          ducats: reward.ducats ?? dbEntry?.ducats ?? null,
          vaulted: group.vaulted,
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Mirrors inline, unlike itemDatabase's raw builder whose callers mirror later
// via chooseImageUrl. Same shape, different contract - keep the names apart.
function buildMirroredWfcdImageUrl(imageName: string | null | undefined): string | null {
  const trimmed = typeof imageName === "string" ? imageName.trim() : "";
  return trimmed ? toIconMirrorUrl(WFCD_CDN + trimmed) : null;
}

const RELIC_PROJECTION_PATH = "/Lotus/Types/Game/Projections/";

/** Nearly every @wfcd reward row carries the containing relic's uniqueName instead of
 *  the item's, so the item database resolves the reward by name or WFM slug. */
function rewardItemUniqueName(
  item: { uniqueName?: unknown; name?: unknown } | undefined,
  rawSlug: string | null,
): string | null {
  const own = typeof item?.uniqueName === "string" ? item.uniqueName : "";
  if (own && !own.startsWith(RELIC_PROJECTION_PATH)) return own;
  const name = typeof item?.name === "string" ? item.name : null;
  return lookupItemByNameOrSlug(name, rawSlug)?.uniqueName ?? null;
}

function buildRelicDatabase(): RelicDatabase {
  let relics: WfcdItem[];
  try {
    relics = readWfcdItems(["Relics"]);
    if (relics.length === 0) throw new Error("Relics.json is missing or empty");
  } catch (err) {
    log.error("[RelicDB] @wfcd/items not available:", normalizeErrorMessage(err));
    return { groups: {}, byUniqueName: {} };
  }

  const groupsMap = new Map<string, RelicGroup>();
  const byUniqueNameMap = new Map<string, { groupKey: string; quality: RelicQualityKey }>();

  for (const relic of relics) {
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
        group.imageUrl = buildMirroredWfcdImageUrl(relic.imageName);
      }
    }

    group.qualities[quality.toLowerCase()] = {
      uniqueName: relic.uniqueName || null,
      rewards: (relic.rewards || []).map((r) => {
        const rawSlug = r.item?.warframeMarket?.urlName || r.item?.warframeMarket?.url_name || null;
        const uniqueName = rewardItemUniqueName(r.item, rawSlug);
        return {
          name: r.item?.name || "Unknown",
          ...localizedNameFields(uniqueName, r.item?.name || "Unknown"),
          uniqueName,
          imageUrl: buildMirroredWfcdImageUrl(r.item?.imageName),
          rarity: relicRewardRarity(quality, r.chance || 0, r.rarity || "Common"),
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
