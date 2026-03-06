const log = require("./logger").withScope("itemDatabase");
// ═══════════════════════════════════════════════════════════════════════════
// Item Database Service
// Primary:  warframe-public-export-plus (Sainan/calamity-inc) — raw game data
// Fallback: @wfcd/items (WFCD) — curated community data with proven image CDN
// ═══════════════════════════════════════════════════════════════════════════

const path = require("path");
const fs = require("fs");

// Image CDNs — wfcd CDN is more reliable for direct <img> usage
const WFCD_CDN = "https://cdn.warframestat.us/img/";
const BROWSE_WF = "https://browse.wf";

function isLikelyBuildComponent(uniqueName, componentName = "") {
  if (!uniqueName) return false;

  if (
    /\/Types\/Recipes\//i.test(uniqueName) ||
    /\/WeaponParts?\//i.test(uniqueName) ||
    /\/WarframeParts?\//i.test(uniqueName) ||
    /\/LandingCraftRecipes\//i.test(uniqueName)
  ) {
    return true;
  }

  const lowerName = String(componentName || "").toLowerCase();
  return /\b(blueprint|barrel|receiver|stock|blade|handle|hilt|chassis|systems|neuroptics|fuselage|engines|avionics|carapace|cerebrum|pod|wings|harness|link|disc|gauntlet|grip|ornament)\b/.test(
    lowerName,
  );
}

function normalizeOptionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function pickTradable(currentValue, incomingValue) {
  const current = normalizeOptionalBoolean(currentValue);
  const incoming = normalizeOptionalBoolean(incomingValue);

  return current !== undefined ? current : incoming;
}

function isWeaponPartRecipePath(uniqueName = "") {
  return /\/Types\/Recipes\/Weapons\/WeaponParts?\//i.test(String(uniqueName || ""));
}

function resolveComponentTradable(componentTradable, parentTradable, uniqueName = "") {
  const component = normalizeOptionalBoolean(componentTradable);
  if (component === true) return true;
  if (component === false) {
    return isWeaponPartRecipePath(uniqueName) ? undefined : false;
  }

  const parent = normalizeOptionalBoolean(parentTradable);
  if (parent === true) return true;
  if (parent === false) {
    return isWeaponPartRecipePath(uniqueName) ? undefined : false;
  }

  return undefined;
}

function buildComponentDisplayName(parentName, componentName, forceBlueprintSuffix = false) {
  const parent = String(parentName || "").trim();
  const component = String(componentName || "").trim();

  if (!parent && !component) return "Unknown";
  if (!component) return parent || "Unknown";

  let finalComponent = component;
  if (forceBlueprintSuffix && !/\bblueprint$/i.test(finalComponent)) {
    finalComponent = `${finalComponent} Blueprint`;
  }

  return parent ? `${parent} ${finalComponent}` : finalComponent;
}

function buildComponentAliasUniqueNames(uniqueName = "") {
  const normalized = String(uniqueName || "");
  if (!normalized) return [];

  if (/Component$/i.test(normalized)) {
    return [normalized.replace(/Component$/i, "Blueprint")];
  }

  if (!/Blueprint$/i.test(normalized) && /\/Types\/Recipes\//i.test(normalized)) {
    return [`${normalized}Blueprint`];
  }

  return [];
}

let itemsByUniqueName = {};
let wfcdItemsByUniqueName = {};

// ─── Load English dictionary from public-export-plus ───────────────────────

function loadDict() {
  // Try multiple approaches to find dict.en.json
  const attempts = [];

  // Attempt 1: Direct require from package
  try {
    const d = require("warframe-public-export-plus/dict.en.json");
    if (d && typeof d === "object" && Object.keys(d).length > 0) {
      log.log(`[ItemDB] dict.en.json loaded via require (${Object.keys(d).length} strings)`);
      return d;
    }
  } catch (e) {
    attempts.push(`require: ${e.message}`);
  }

  // Attempt 2: Find it in node_modules manually
  try {
    const modPath = require.resolve("warframe-public-export-plus/package.json");
    const modDir = path.dirname(modPath);
    const dictPath = path.join(modDir, "dict.en.json");
    if (fs.existsSync(dictPath)) {
      const d = JSON.parse(fs.readFileSync(dictPath, "utf-8"));
      log.log(`[ItemDB] dict.en.json loaded from disk (${Object.keys(d).length} strings)`);
      return d;
    } else {
      attempts.push(`disk: file not found at ${dictPath}`);
    }
  } catch (e) {
    attempts.push(`disk: ${e.message}`);
  }

  // Attempt 3: Check if the main export has a getString or dict property
  try {
    const pep = require("warframe-public-export-plus");
    if (pep.getString && typeof pep.getString === "function") {
      log.log("[ItemDB] Using pep.getString() for name resolution");
      return { __getString: pep.getString };
    }
    // Some versions might export dict directly
    for (const key of ["dict", "dictEn", "dict_en", "strings"]) {
      if (pep[key] && typeof pep[key] === "object") {
        log.log(`[ItemDB] dict found via pep.${key}`);
        return pep[key];
      }
    }
  } catch (e) {
    attempts.push(`main export: ${e.message}`);
  }

  log.warn("[ItemDB] Could not load dict.en.json. Tried:", attempts.join(" | "));
  log.warn(
    "[ItemDB] Names from public-export-plus will fall back to @wfcd/items or path extraction",
  );
  return {};
}

// ─── Load warframe-public-export-plus ──────────────────────────────────────

function loadPublicExportPlus() {
  try {
    const pep = require("warframe-public-export-plus");
    const dict = loadDict();

    // Name resolver: handles language keys (/Lotus/Language/...) and plain strings
    function resolveName(nameKey) {
      if (!nameKey) return null;
      if (!nameKey.startsWith("/")) return nameKey; // Already a plain name
      if (dict.__getString) return dict.__getString(nameKey) || null;
      return dict[nameKey] || null;
    }

    // Image: build browse.wf URL from icon path (used as fallback only)
    function resolveIcon(iconPath) {
      if (!iconPath) return null;
      return BROWSE_WF + iconPath;
    }

    const exportMappings = [
      { exportKey: "ExportWarframes", category: "Warframe" },
      { exportKey: "ExportWeapons", category: "Weapon" },
      { exportKey: "ExportSentinels", category: "Companion" },
      { exportKey: "ExportResources", category: "Resource" },
      { exportKey: "ExportRecipes", category: "Recipe" },
      { exportKey: "ExportGear", category: "Gear" },
      { exportKey: "ExportArcanes", category: "Arcane" },
      { exportKey: "ExportUpgrades", category: "Mod" },
      { exportKey: "ExportKeys", category: "Key" },
      { exportKey: "ExportMisc", category: "Misc" },
      { exportKey: "ExportRelics", category: "Relic" },
      { exportKey: "ExportRailjackWeapons", category: "Railjack" },
      { exportKey: "ExportFusionBundles", category: "Fusion" },
      { exportKey: "ExportCustoms", category: "Cosmetic" },
      { exportKey: "ExportFlavour", category: "Cosmetic" },
      { exportKey: "ExportDrones", category: "Gear" },
    ];

    let pepCount = 0;

    for (const { exportKey, category } of exportMappings) {
      const exportData = pep[exportKey];
      if (!exportData || typeof exportData !== "object") continue;

      for (const [uniqueName, item] of Object.entries(exportData)) {
        if (!uniqueName || uniqueName === "default") continue;

        const resolvedName = resolveName(item.name) || extractFallbackName(uniqueName);

        const pepDucats =
          typeof item.primeSellingPrice === "number" && Number.isFinite(item.primeSellingPrice)
            ? Math.max(0, Math.round(item.primeSellingPrice))
            : null;

        itemsByUniqueName[uniqueName] = {
          name: resolvedName,
          category,
          imageUrl: null, // Will be set by wfcd if available
          browseWfUrl: resolveIcon(item.icon), // Keep as fallback
          isPrime: resolvedName.includes("Prime"),
          masteryReq: item.masteryReq || 0,
          tradable: normalizeOptionalBoolean(item.tradable),
          vaulted: item.vaulted || false,
          description: resolveName(item.description) || "",
          productCategory: item.productCategory || null,
          ducats: pepDucats,
          _source: "pep",
        };
        pepCount++;
      }
    }

    log.log(`[ItemDB] public-export-plus: ${pepCount} items indexed`);
    return pepCount;
  } catch (err) {
    log.warn("[ItemDB] warframe-public-export-plus not available:", err.message);
    return 0;
  }
}

// ─── Load @wfcd/items ──────────────────────────────────────────────────────

function loadWfcdItems() {
  try {
    const Items = require("@wfcd/items");
    const CATEGORIES = [
      "Warframes",
      "Primary",
      "Secondary",
      "Melee",
      "Sentinels",
      "Pets",
      "Archwing",
      "Arch-Gun",
      "Arch-Melee",
      "Mods",
      "Resources",
      "Misc",
      "Relics",
      "Fish",
      "Gear",
      "Arcanes",
    ];

    const items = new Items({ category: CATEGORIES });
    let wfcdNewCount = 0;
    let wfcdSupplementCount = 0;
    let wfcdComponentNewCount = 0;
    let wfcdComponentSupplementCount = 0;

    for (const item of items) {
      if (!item.uniqueName) continue;

      const wfcdImageUrl = item.imageName ? WFCD_CDN + item.imageName : null;

      const wfcdRootDucats =
        typeof item.ducats === "number" && Number.isFinite(item.ducats)
          ? Math.max(0, Math.round(item.ducats))
          : null;

      const wfcdEntry = {
        name: item.name || "Unknown",
        category: item.category || "Misc",
        imageUrl: wfcdImageUrl,
        isPrime: (item.name || "").includes("Prime"),
        masteryReq: item.masteryReq || 0,
        masterable: typeof item.masterable === "boolean" ? item.masterable : undefined,
        tradable: normalizeOptionalBoolean(item.tradable),
        vaulted: item.vaulted || false,
        exalted: item.exalted || false,
        components: item.components || [],
        drops: item.drops || [],
        description: item.description || "",
        productCategory: item.productCategory || null,
        type: item.type || "",
        wikiaUrl: item.wikiaUrl || null,
        ducats: wfcdRootDucats,
        _source: "wfcd",
      };

      wfcdItemsByUniqueName[item.uniqueName] = wfcdEntry;

      // Index components too (blueprints, chassis, etc.)
      if (item.components) {
        for (const comp of item.components) {
          if (comp.uniqueName) {
            const componentLooksLikePart = isLikelyBuildComponent(comp.uniqueName, comp.name);
            const componentAliasUniqueNames = buildComponentAliasUniqueNames(comp.uniqueName);
            const componentUsesBlueprintAlias = componentAliasUniqueNames.length > 0;
            const forceComponentBlueprintName = /Component$/i.test(comp.uniqueName);
            const compDucats =
              typeof comp.ducats === "number" && Number.isFinite(comp.ducats)
                ? Math.max(0, Math.round(comp.ducats))
                : null;
            const componentName = buildComponentDisplayName(
              item.name,
              comp.name,
              forceComponentBlueprintName,
            );

            const componentEntry = {
              ...wfcdEntry,
              name: componentName,
              imageUrl: comp.imageName ? WFCD_CDN + comp.imageName : wfcdImageUrl,
              tradable: resolveComponentTradable(comp.tradable, item.tradable, comp.uniqueName),
              type: comp.name ? `${comp.name} Part` : wfcdEntry.type || "Part",
              components: [],
              drops: comp.drops || [],
              description: "",
              isBuildComponent: componentLooksLikePart,
              componentOf: item.uniqueName,
              ducats: compDucats,
            };

            wfcdItemsByUniqueName[comp.uniqueName] = componentEntry;

            if (!itemsByUniqueName[comp.uniqueName]) {
              itemsByUniqueName[comp.uniqueName] = componentEntry;
              wfcdComponentNewCount++;
            } else {
              const existingComponent = itemsByUniqueName[comp.uniqueName];

              // For build components, always prefer WFCD's composite name (e.g.
              // "Odonata Prime Blueprint") over PEP's generic dict name (e.g.
              // "Prime Archwing Blueprint") which can resolve to the wrong display name.
              if (
                componentEntry.name &&
                (!existingComponent.name ||
                  String(existingComponent.name).startsWith("/Lotus/") ||
                  componentLooksLikePart)
              ) {
                existingComponent.name = componentEntry.name;
              }

              if (!existingComponent.imageUrl && componentEntry.imageUrl) {
                existingComponent.imageUrl = componentEntry.imageUrl;
              }

              const mergedComponentTradable = pickTradable(
                existingComponent.tradable,
                componentEntry.tradable,
              );
              if (mergedComponentTradable !== undefined) {
                existingComponent.tradable = mergedComponentTradable;
              }

              if (!existingComponent.type && componentEntry.type) {
                existingComponent.type = componentEntry.type;
              }

              if (!existingComponent.productCategory && componentEntry.productCategory) {
                existingComponent.productCategory = componentEntry.productCategory;
              }

              if (componentLooksLikePart) {
                existingComponent.isBuildComponent = true;
                if (!existingComponent.componentOf) {
                  existingComponent.componentOf = item.uniqueName;
                }
              }

              if (!Array.isArray(existingComponent.components)) {
                existingComponent.components = [];
              }

              wfcdComponentSupplementCount++;
            }

            if (componentUsesBlueprintAlias) {
              for (const blueprintUniqueName of componentAliasUniqueNames) {
                const existingBlueprint = itemsByUniqueName[blueprintUniqueName];
                if (!existingBlueprint) continue;

                const aliasName = buildComponentDisplayName(item.name, comp.name, true);
                if (aliasName) {
                  existingBlueprint.name = aliasName;
                }

                const aliasImage = comp.imageName ? WFCD_CDN + comp.imageName : wfcdImageUrl;
                if (!existingBlueprint.imageUrl && aliasImage) {
                  existingBlueprint.imageUrl = aliasImage;
                }

                const aliasTradable =
                  pickTradable(existingBlueprint.tradable, componentEntry.tradable) ??
                  pickTradable(existingBlueprint.tradable, item.tradable);
                if (aliasTradable !== undefined) {
                  existingBlueprint.tradable = aliasTradable;
                }

                existingBlueprint.isBuildComponent = true;
                if (!existingBlueprint.componentOf) {
                  existingBlueprint.componentOf = item.uniqueName;
                }

                if (!existingBlueprint.type && comp.name) {
                  existingBlueprint.type = `${comp.name} Part`;
                }
              }
            }
          }
        }
      }

      if (!itemsByUniqueName[item.uniqueName]) {
        // Brand new item not in PEP
        itemsByUniqueName[item.uniqueName] = wfcdEntry;
        wfcdNewCount++;
      } else {
        // Supplement PEP entry with wfcd data
        const existing = itemsByUniqueName[item.uniqueName];

        // ALWAYS prefer wfcd image (proven CDN), fall back to browse.wf
        existing.imageUrl = wfcdImageUrl || existing.browseWfUrl || null;

        // If PEP name was a language key that didn't resolve, use wfcd name
        if (existing.name.startsWith("/Lotus/") && item.name) {
          existing.name = item.name;
          existing.isPrime = item.name.includes("Prime");
        }

        // Add wfcd extras
        const mergedItemTradable = pickTradable(existing.tradable, item.tradable);
        if (mergedItemTradable !== undefined) {
          existing.tradable = mergedItemTradable;
        }
        existing.drops = item.drops || [];
        existing.wikiaUrl = item.wikiaUrl || null;
        existing.exalted = item.exalted || false;
        if (typeof item.masterable === "boolean") {
          existing.masterable = item.masterable;
        }
        existing.components = item.components || [];
        if (!existing.productCategory && item.productCategory) {
          existing.productCategory = item.productCategory;
        }
        if (!existing.type && item.type) {
          existing.type = item.type;
        }
        if (!existing.description && item.description) {
          existing.description = item.description;
        }
        // Prefer WFCD ducats over PEP when available
        if (wfcdRootDucats != null) {
          existing.ducats = wfcdRootDucats;
        }
        wfcdSupplementCount++;
      }
    }

    log.log(
      `[ItemDB] @wfcd/items: ${wfcdNewCount} new + ${wfcdSupplementCount} supplemented + ${wfcdComponentNewCount} component entries + ${wfcdComponentSupplementCount} component supplements`,
    );
    return wfcdNewCount;
  } catch (err) {
    log.warn("[ItemDB] @wfcd/items not available:", err.message);
    return 0;
  }
}

// ─── Post-process: ensure all items have best possible image ───────────────

function resolveAllImages() {
  let resolved = 0;
  let browseWfFallback = 0;
  let noImage = 0;

  for (const [uniqueName, item] of Object.entries(itemsByUniqueName)) {
    if (item.imageUrl) {
      resolved++;
      continue;
    }

    // Try browse.wf URL as fallback
    if (item.browseWfUrl) {
      item.imageUrl = item.browseWfUrl;
      browseWfFallback++;
      continue;
    }

    // Try looking up wfcd by uniqueName
    const wfcd = wfcdItemsByUniqueName[uniqueName];
    if (wfcd?.imageUrl) {
      item.imageUrl = wfcd.imageUrl;
      resolved++;
      continue;
    }

    noImage++;
  }

  log.log(
    `[ItemDB] Images: ${resolved} wfcd, ${browseWfFallback} browse.wf fallback, ${noImage} none`,
  );
}

// ─── Fallback name extraction ──────────────────────────────────────────────

function extractFallbackName(uniqueName) {
  if (!uniqueName) return "Unknown";
  const segments = uniqueName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return name;
}

// ─── Public API ────────────────────────────────────────────────────────────

function buildDatabase() {
  log.time("[ItemDB] Total build time");

  const pepCount = loadPublicExportPlus();
  const wfcdCount = loadWfcdItems();
  resolveAllImages();

  log.log(`[ItemDB] Total: ${Object.keys(itemsByUniqueName).length} items`);
  log.timeEnd("[ItemDB] Total build time");

  if (pepCount === 0 && wfcdCount === 0) {
    log.error("[ItemDB] WARNING: No item data loaded! Run 'npm install' to get packages.");
  }
}

function lookupItem(uniqueName) {
  return itemsByUniqueName[uniqueName] || null;
}

function lookupName(uniqueName) {
  const item = itemsByUniqueName[uniqueName];
  if (item) return item.name;
  return extractFallbackName(uniqueName);
}

function lookupImage(uniqueName) {
  const item = itemsByUniqueName[uniqueName];
  return item?.imageUrl || null;
}

// Serializable lookup for renderer via IPC
function getRendererLookup() {
  const lookup = {};
  for (const [key, item] of Object.entries(itemsByUniqueName)) {
    lookup[key] = {
      name: item.name,
      category: item.category,
      imageUrl: item.imageUrl,
      isPrime: item.isPrime,
      tradable: typeof item.tradable === "boolean" ? item.tradable : undefined,
      masteryReq: item.masteryReq || 0,
      vaulted: item.vaulted || false,
      exalted: item.exalted || false,
      masterable: typeof item.masterable === "boolean" ? item.masterable : undefined,
      type: item.type || "",
      isBuildComponent: item.isBuildComponent === true,
      description: item.description || "",
      productCategory: item.productCategory || null,
      ducats: typeof item.ducats === "number" ? item.ducats : null,
      components: (item.components || []).map((c) => ({
        name: c.name || "",
        uniqueName: c.uniqueName || "",
        tradable: typeof c.tradable === "boolean" ? c.tradable : undefined,
        itemCount: c.itemCount || 1,
        drops: (c.drops || []).map((d) => ({
          location: d.location || "",
          type: d.type || "",
          chance: d.chance || 0,
          rarity: d.rarity || "",
        })),
      })),
      drops: (item.drops || []).slice(0, 20).map((d) => ({
        location: d.location || "",
        type: d.type || "",
        chance: d.chance || 0,
        rarity: d.rarity || "",
      })),
      wikiaUrl: item.wikiaUrl || null,
    };
  }
  return lookup;
}

// Direct access to internal store (for main-process services like masteryHelper)
function getAllItems() {
  return itemsByUniqueName;
}

module.exports = {
  buildDatabase,
  lookupItem,
  lookupName,
  lookupImage,
  getRendererLookup,
  getAllItems,
};
