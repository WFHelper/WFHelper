// ═══════════════════════════════════════════════════════════════════════════
// Mastery Helper Service
// Builds a complete list of all masterable items in the game,
// then compares against user inventory to show owned / missing / mastered.
// ═══════════════════════════════════════════════════════════════════════════

const itemDb = require("./itemDatabase");
const { MAX_ITEM_RANK, XP_PER_RANK } = require('../config/game/constants');
let debugMode = false;

function setDebugMode(enabled) {
  debugMode = !!enabled;
}

function debugLog(_message, _payload) {
  // Debug reasons are now surfaced in the UI; avoid terminal spam.
  if (!debugMode) return;
}

// ─── Category classification ─────────────────────────────────────────────

const MASTERABLE_DB_CATEGORIES = new Set([
  "Warframe", "Weapon", "Companion", "Railjack",
]);

// productCategory → display label
const PRODUCT_DISPLAY = {
  Suits:             "Warframes",
  LongGuns:          "Primary",
  Pistols:           "Secondary",
  Melee:             "Melee",
  Sentinels:         "Companions",
  SentinelWeapons:   "Companions",
  SpaceSuits:        "Archwing",
  SpaceGuns:         "Archwing",
  SpaceMelee:        "Archwing",
  OperatorAmps:      "Amps",
  MechSuits:         "Necramech",
  CrewShipWeapons:   "Railjack",
};

// Path patterns → display category (fallback when productCategory is missing)
const PATH_CATEGORY_RULES = [
  { pattern: /\/OperatorAmps?\//i,                        category: "Amps" },
  { pattern: /\/OperatorAmplifiers?\//i,                  category: "Amps" },
  { pattern: /\/Sentinels\/.*Weapons?\//i,                category: "Companions" },
  { pattern: /\/Sentinels?\//i,                           category: "Companions" },
  { pattern: /\/Pets?\//i,                                category: "Companions" },
  { pattern: /\/SpaceSuits?\//i,                          category: "Archwing" },
  { pattern: /\/SpaceGuns?\//i,                           category: "Archwing" },
  { pattern: /\/SpaceMelee\//i,                           category: "Archwing" },
  { pattern: /\/MechSuits?\//i,                           category: "Necramech" },
  { pattern: /\/CrewShip.*Weapons?\//i,                   category: "Railjack" },
  { pattern: /\/Suits\//i,                                category: "Warframes" },
  { pattern: /\/ModularMelee\b|\/Ostron.*Melee|\/Zaw/i,  category: "Melee" },
  { pattern: /\/ModularPistol|\/SolarisUnited.*Secondary|\/Kitgun.*Pistol/i, category: "Secondary" },
  { pattern: /\/ModularPrimary|\/SolarisUnited.*Primary|\/Kitgun.*Rifle/i,   category: "Primary" },
  { pattern: /\/LongGuns\//i,                             category: "Primary" },
  { pattern: /\/Pistols\//i,                              category: "Secondary" },
  { pattern: /\/Melee\//i,                                category: "Melee" },
];

// ─── Keyword tagging for search ──────────────────────────────────────────

const KEYWORD_RULES = [
  { pattern: /\/ModularMelee\b|\/Ostron.*Melee|\/InfZaw|\/Zaw/i,           keywords: ["zaw", "modular"] },
  { pattern: /\/ModularPistol|\/ModularPrimary|\/SolarisUnited.*(?:Secondary|Primary)|\/Kitgun/i,
                                                                            keywords: ["kitgun", "modular"] },
  { pattern: /\/OperatorAmps?\//i,                                          keywords: ["amp", "operator"] },
  { pattern: /\/OperatorAmplifiers?\//i,                                    keywords: ["amp", "operator"] },
  { pattern: /\/MechSuits?\//i,                                             keywords: ["necramech", "mech"] },
  { pattern: /\/Archwing|\/SpaceSuits?\//i,                                 keywords: ["archwing"] },
  { pattern: /\/SpaceGuns?\//i,                                             keywords: ["archgun", "arch-gun"] },
  { pattern: /\/SpaceMelee\//i,                                             keywords: ["archmelee", "arch-melee"] },
  { pattern: /\/CrewShip/i,                                                 keywords: ["railjack"] },
  { pattern: /\/Sentinels?\//i,                                             keywords: ["sentinel", "companion"] },
  { pattern: /\/Pets?\//i,                                                  keywords: ["companion", "pet"] },
  { pattern: /Prime/i,                                                      keywords: ["prime"] },
  { pattern: /Wraith/i,                                                     keywords: ["wraith"] },
  { pattern: /Vandal/i,                                                     keywords: ["vandal"] },
  { pattern: /Prisma/i,                                                     keywords: ["prisma"] },
  { pattern: /Kuva/i,                                                       keywords: ["kuva", "lich"] },
  { pattern: /Tenet/i,                                                      keywords: ["tenet", "sister"] },
  { pattern: /Incarnon/i,                                                   keywords: ["incarnon"] },
];

function getKeywords(uniqueName, itemName) {
  const tags = new Set();
  for (const { pattern, keywords } of KEYWORD_RULES) {
    if (pattern.test(uniqueName) || pattern.test(itemName)) {
      for (const kw of keywords) tags.add(kw);
    }
  }
  return [...tags];
}

// Hard-coded exalted weapon names to exclude even if not flagged
const EXALTED_NAMES = new Set([
  "regulators", "regulators prime",
  "iron staff", "iron staff prime",
  "exalted blade", "exalted blade prime",
  "dex pixia", "dex pixia prime",
  "diwata", "diwata prime",
  "artemis bow", "artemis bow prime",
  "valkyr talons", "valkyr talons prime",
  "desert wind", "desert wind prime",
  "shattered lash",
]);

// Inventory JSON key → maxRank
const INV_CATEGORIES = {
  Suits:             MAX_ITEM_RANK,
  LongGuns:          MAX_ITEM_RANK,
  Pistols:           MAX_ITEM_RANK,
  Melee:             MAX_ITEM_RANK,
  Sentinels:         MAX_ITEM_RANK,
  SentinelWeapons:   MAX_ITEM_RANK,
  SpaceSuits:             MAX_ITEM_RANK,
  SpaceGuns:         MAX_ITEM_RANK,
  SpaceMelee:             MAX_ITEM_RANK,
  OperatorAmps:      MAX_ITEM_RANK,
  MechSuits:             MAX_ITEM_RANK,
};

function xpToRank(xp, maxRank = MAX_ITEM_RANK) {
  if (!xp || xp <= 0) return 0;
  return Math.min(maxRank, Math.floor(xp / XP_PER_RANK));
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === "object") {
    if (typeof value.$numberLong === "string") return readNumber(value.$numberLong);
    if (typeof value.$numberInt === "string") return readNumber(value.$numberInt);
  }
  return null;
}

function getValueAtPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function pickNumber(obj, paths) {
  for (const p of paths) {
    const v = getValueAtPath(obj, p);
    const n = readNumber(v);
    if (n != null) return n;
  }
  return null;
}

function extractProfileMastery(inventoryData) {
  const rank = pickNumber(inventoryData, [
    ["MasteryRank"], ["MasteryLevel"], ["PlayerLevel"], ["PlayerRank"],
    ["LevelInfo", "MasteryRank"], ["LevelInfo", "PlayerLevel"],
  ]);

  let percentToNext = pickNumber(inventoryData, [
    ["MasteryPercent"], ["MasteryProgressPercent"], ["PlayerLevelProgressPercent"],
    ["LevelInfo", "MasteryPercent"], ["LevelInfo", "ProgressPercent"],
  ]);

  if (percentToNext == null) {
    const currentXp = pickNumber(inventoryData, [
      ["MasteryXP"], ["MasteryXp"], ["PlayerXP"], ["PlayerXp"],
      ["LevelInfo", "MasteryXP"], ["LevelInfo", "CurrentXP"],
    ]);
    const nextXp = pickNumber(inventoryData, [
      ["NextMasteryXP"], ["NextLevelXP"], ["MasteryXPForNextRank"],
      ["LevelInfo", "NextXP"], ["LevelInfo", "NextLevelXP"],
    ]);
    if (currentXp != null && nextXp != null && nextXp > 0) {
      percentToNext = (currentXp / nextXp) * 100;
    }
  }

  if (rank == null && percentToNext == null) return null;
  if (percentToNext != null) {
    percentToNext = Math.max(0, Math.min(100, Number(percentToNext.toFixed(1))));
  }
  return { rank, percentToNext };
}

// ─── Exclusion filter ────────────────────────────────────────────────────

function getExcludeReason(uniqueName, name, item) {
  if (uniqueName.includes("/Recipes/")) return "recipe";
  if (uniqueName.includes("/StoreItems/")) return "store-item";
  if (uniqueName.includes("/OperatorLoadOuts/")) return "operator-loadout";
  if (uniqueName.includes("/QuestVersions/")) return "quest-version";
  if (uniqueName.includes("/PrototypeVersions/")) return "prototype-version";

  // Exalted weapons (level with parent frame)
  // WFCD can provide exalted as an array on warframes (linked exalted weapons).
  // Exclude only when the item itself is explicitly flagged as exalted.
  if (item && item.exalted === true) return "wfcd-exalted-flag";
  if (item && item.productCategory === "SpecialItems") return "specialitems-product-category";
  if (item && typeof item.type === "string" && /exalted/i.test(item.type)) return "type-exalted";
  if (/\/ExaltedWeapons?\//i.test(uniqueName)) return "path-exaltedweapons";
  if (/\/SpecialItems\//i.test(uniqueName)) return "path-specialitems";
  if (name && EXALTED_NAMES.has(name.toLowerCase())) return "name-exalted-list";

  // Cosmetics, skins, decorations
  if (/\/Cosmetics?\//i.test(uniqueName)) return "cosmetic";
  if (/\/Decorations?\//i.test(uniqueName)) return "decoration";

  // NPC / test / debug
  if (/\/NPC\//i.test(uniqueName)) return "npc";
  if (/\/Test\//i.test(uniqueName)) return "test";
  if (/\/Developers?\//i.test(uniqueName)) return "developer";
  if (/\/FixedGun/i.test(uniqueName)) return "fixed-gun";

  // Training amps
  if (/\/SentTrainingAmps?\//i.test(uniqueName)) return "training-amp";
  if (/\/SentTrainingAmplifiers?\//i.test(uniqueName)) return "training-amp";

  // Name-based
  if (name) {
    const n = name.toLowerCase();
    if (n.endsWith(" blueprint") || n.endsWith(" component")) return "name-blueprint-component";
  }

  return null;
}

// ─── Category resolver ───────────────────────────────────────────────────

function resolveDisplayCategoryInfo(item, uniqueName) {
  // Operator amplifier parts should always be listed under Amps, even when productCategory is Pistols.
  if (/\/OperatorAmplifiers?\//i.test(uniqueName)) {
    return { category: "Amps", source: "path:OperatorAmplifiers" };
  }
  if (item.productCategory && PRODUCT_DISPLAY[item.productCategory]) {
    return { category: PRODUCT_DISPLAY[item.productCategory], source: `productCategory:${item.productCategory}` };
  }
  for (const { pattern, category } of PATH_CATEGORY_RULES) {
    if (pattern.test(uniqueName)) return { category, source: `path:${pattern}` };
  }
  if (item.category === "Warframe") return { category: "Warframes", source: "db-category:Warframe" };
  if (item.category === "Companion") return { category: "Companions", source: "db-category:Companion" };
  if (item.category === "Railjack") return { category: "Railjack", source: "db-category:Railjack" };
  return { category: "Other", source: "fallback:Other" };
}

function isAmpPrismMasterableOverride(item, uniqueName) {
  if (!/\/OperatorAmplifiers?\//i.test(uniqueName)) return false;
  if (/\/SentTrainingAmplifier/i.test(uniqueName)) return false;
  if (!/\/Barrel\//i.test(uniqueName)) return false;
  const n = (item.name || "").toLowerCase();
  // Keep to prism-only override (scaffolds/braces should not grant mastery).
  return n.includes(" prism");
}

// ─── Build masterable items list ─────────────────────────────────────────

function getAllMasterableItems() {
  const allItems = itemDb.getAllItems();
  const items = [];
  const seenNames = new Set();

  for (const [uniqueName, item] of Object.entries(allItems)) {
    if (!MASTERABLE_DB_CATEGORIES.has(item.category)) {
      debugLog(`[MasteryDebug][Exclude] ${item.name} | ${uniqueName} | reason=db-category:${item.category}`);
      continue;
    }
    const ampPrismOverride = isAmpPrismMasterableOverride(item, uniqueName);
    if (item.masterable === false && !ampPrismOverride) {
      debugLog(`[MasteryDebug][Exclude] ${item.name} | ${uniqueName} | reason=masterable:false`);
      continue;
    }

    const excludeReason = getExcludeReason(uniqueName, item.name, item);
    if (excludeReason) {
      debugLog(`[MasteryDebug][Exclude] ${item.name} | ${uniqueName} | reason=${excludeReason}`);
      continue;
    }

    const nameKey = item.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      debugLog(`[MasteryDebug][Exclude] ${item.name} | ${uniqueName} | reason=duplicate-name`);
      continue;
    }
    seenNames.add(nameKey);

    const display = resolveDisplayCategoryInfo(item, uniqueName);
    const keywords = getKeywords(uniqueName, item.name);
    if (display.category === "Railjack") {
      debugLog(`[MasteryDebug][Exclude] ${item.name} | ${uniqueName} | reason=category-railjack-hidden`);
      continue;
    }
    const masterableSource = ampPrismOverride ? "amp-prism-override" : (item.masterable === true ? "wfcd-masterable:true" : "default");
    debugLog(`[MasteryDebug][Include] ${item.name} | ${uniqueName} | category=${display.category} | masterableSource=${masterableSource} | categorySource=${display.source}`);

    items.push({
      name: item.name,
      uniqueName,
      category: display.category,
      imageUrl: item.imageUrl || item.browseWfUrl || null,
      isPrime: item.isPrime || false,
      masteryReq: item.masteryReq || 0,
      vaulted: item.vaulted || false,
      tradable: item.tradable || item.isPrime || false,
      keywords,
      debugReason: `show:${masterableSource}; cat:${display.source}; dbCat:${item.category || "?"}; product:${item.productCategory || "?"}; type:${item.type || "?"}`,
      // Components from wfcd (blueprints, barrels, etc.)
      components: item.components || [],
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

// ─── Build component ownership map from inventory ────────────────────────

function buildComponentOwnership(inventoryData) {
  const owned = new Map(); // uniqueName → count

  // MiscItems (resources/components)
  if (Array.isArray(inventoryData.MiscItems)) {
    for (const e of inventoryData.MiscItems) {
      if (e.ItemType) owned.set(e.ItemType, (owned.get(e.ItemType) || 0) + (e.ItemCount || 1));
    }
  }

  // Recipes (blueprints)
  if (Array.isArray(inventoryData.Recipes)) {
    for (const e of inventoryData.Recipes) {
      if (e.ItemType) owned.set(e.ItemType, (owned.get(e.ItemType) || 0) + (e.ItemCount || 1));
    }
  }

  // PendingRecipes (currently building)
  if (Array.isArray(inventoryData.PendingRecipes)) {
    for (const e of inventoryData.PendingRecipes) {
      if (e.ItemType) owned.set(e.ItemType, (owned.get(e.ItemType) || 0) + 1);
    }
  }

  return owned;
}

// ─── Compare vs inventory ────────────────────────────────────────────────

function computeMasteryProgress(inventoryData) {
  if (!inventoryData) return { items: [], stats: {} };

  const allMasterable = getAllMasterableItems();
  const componentOwnership = buildComponentOwnership(inventoryData);

  // Build owned map: uniqueName → { rank, maxRank, owned }
  const ownedMap = new Map();

  for (const [invKey, maxRank] of Object.entries(INV_CATEGORIES)) {
    const arr = inventoryData[invKey];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry.ItemType) continue;
      const rank = xpToRank(entry.XP || 0, maxRank);
      ownedMap.set(entry.ItemType, { rank, maxRank, owned: true });
    }
  }

  // XPInfo: items sold but XP still counts
  if (Array.isArray(inventoryData.XPInfo)) {
    for (const entry of inventoryData.XPInfo) {
      if (!entry.ItemType) continue;
      if (ownedMap.has(entry.ItemType)) continue;
      const rank = xpToRank(entry.XP || 0, MAX_ITEM_RANK);
      ownedMap.set(entry.ItemType, { rank, maxRank: MAX_ITEM_RANK, owned: false, fromXPInfo: true });
    }
  }

  // Name-based fallback matching
  const ownedByName = new Map();
  for (const [uname, data] of ownedMap) {
    const dbItem = itemDb.lookupItem(uname);
    if (dbItem) {
      ownedByName.set(dbItem.name.toLowerCase(), { ...data, uniqueName: uname });
    }
  }

  // Annotate each masterable item with ownership + component status
  const items = allMasterable.map(item => {
    let owned = ownedMap.get(item.uniqueName);
    if (!owned) owned = ownedByName.get(item.name.toLowerCase());

    let status = "missing";
    let rank = 0;
    let maxRank = MAX_ITEM_RANK;
    let currentlyOwned = false;

    if (owned) {
      rank = owned.rank;
      maxRank = owned.maxRank;
      currentlyOwned = owned.owned !== false;
      status = rank >= maxRank ? "mastered" : "progress";
    }

    // Annotate components with ownership
    const components = (item.components || []).map(comp => {
      const ownedCount = comp.uniqueName ? (componentOwnership.get(comp.uniqueName) || 0) : 0;
      return {
        name: comp.name || "",
        uniqueName: comp.uniqueName || "",
        tradable: comp.tradable || false,
        itemCount: comp.itemCount || 1,
        ownedCount,
        owned: ownedCount >= (comp.itemCount || 1),
        drops: comp.drops || [],
      };
    });

    return { ...item, status, rank, maxRank, currentlyOwned, components };
  });

  // Stats
  const total = items.length;
  const mastered = items.filter(i => i.status === "mastered").length;
  const inProgress = items.filter(i => i.status === "progress").length;
  const missing = items.filter(i => i.status === "missing").length;

  const byCategory = {};
  for (const item of items) {
    if (!byCategory[item.category]) {
      byCategory[item.category] = { total: 0, mastered: 0, inProgress: 0, missing: 0 };
    }
    byCategory[item.category].total++;
    byCategory[item.category][item.status === "progress" ? "inProgress" : item.status]++;
  }

  return {
    items,
    stats: { total, mastered, inProgress, missing, byCategory, profileMastery: extractProfileMastery(inventoryData) },
  };
}

module.exports = { getAllMasterableItems, computeMasteryProgress };
module.exports.setDebugMode = setDebugMode;
