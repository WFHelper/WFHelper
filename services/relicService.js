"use strict";

/**
 * relicService.js — Relic database built from @wfcd/items
 *
 * Groups all Warframe relics by "Tier Code" (e.g. "Axi A1"), exposing all four
 * quality variants (Intact/Exceptional/Flawless/Radiant) with their per-item
 * drop chances and WFM slugs. Also provides a uniqueName→group lookup so the
 * renderer can cross-reference player inventory (LevelKeys[]).
 */

const WFCD_CDN = "https://cdn.warframestat.us/img/";
const QUALITIES = new Set(["Intact", "Exceptional", "Flawless", "Radiant"]);
const TIERS     = new Set(["Lith", "Meso", "Neo", "Axi", "Requiem"]);

let _db = null;

function buildRelicDatabase() {
  let Items;
  try {
    Items = require("@wfcd/items");
  } catch (err) {
    console.error("[RelicDB] @wfcd/items not available:", err.message);
    return { groups: {}, byUniqueName: {} };
  }

  const all = new Items();
  const groupsMap      = new Map(); // baseName → group
  const byUniqueNameMap = new Map(); // uniqueName → { groupKey, quality }

  for (const relic of all) {
    if (relic.category !== "Relics") continue;

    const parts   = (relic.name || "").split(" ");
    if (parts.length < 3) continue; // need at least "Tier Code Quality"

    const quality = parts[parts.length - 1];
    if (!QUALITIES.has(quality)) continue;

    const tier = parts[0];
    if (!TIERS.has(tier)) continue;

    const baseName = parts.slice(0, -1).join(" "); // "Axi A1"
    const code     = parts.slice(1, -1).join(" "); // "A1"

    if (!groupsMap.has(baseName)) {
      groupsMap.set(baseName, {
        key:       baseName,
        name:      baseName,
        tier,
        code,
        imageUrl:  null,
        qualities: {},
      });
    }

    const group = groupsMap.get(baseName);

    // Prefer Intact imageName for the group thumbnail; fall back to any quality
    if (relic.imageName) {
      if (quality === "Intact" || !group.imageUrl) {
        group.imageUrl = WFCD_CDN + relic.imageName;
      }
    }

    group.qualities[quality.toLowerCase()] = {
      uniqueName: relic.uniqueName || null,
      rewards: (relic.rewards || []).map(r => ({
        name:    r.item?.name                      || "Unknown",
        rarity:  r.rarity                          || "Common",
        chance:  r.chance                          || 0,
        urlName: r.item?.warframeMarket?.urlName   || null,
        wfmId:   r.item?.warframeMarket?.id        || null,
      })),
    };

    if (relic.uniqueName) {
      byUniqueNameMap.set(relic.uniqueName, {
        groupKey: baseName,
        quality:  quality.toLowerCase(),
      });
    }
  }

  const groups      = Object.fromEntries(groupsMap);
  const byUniqueName = Object.fromEntries(byUniqueNameMap);

  return { groups, byUniqueName };
}

/**
 * Returns the relic database (cached after first call).
 * @returns {{ groups: Object, byUniqueName: Object }}
 */
function getRelicDatabase() {
  if (!_db) {
    console.time("[RelicDB] build");
    _db = buildRelicDatabase();
    const n = Object.keys(_db.groups).length;
    console.log(`[RelicDB] ${n} relic groups indexed`);
    console.timeEnd("[RelicDB] build");
  }
  return _db;
}

module.exports = { getRelicDatabase };
