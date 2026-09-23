// Keep WFCD as the offline fallback when live DE exports are unavailable.

import crypto from "node:crypto";
import path from "node:path";

import { isInfestedMechPart } from "../config/shared/componentNames";
import { fallbackNameFromUniqueName, sanitizeDisplayName } from "../config/shared/displayName";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeDucats } from "../config/shared/numeric";
import { normalizeWfmSlug } from "../config/shared/wfm";
import type { MarketAcquisition } from "../config/shared/marketAcquisition";
import { WIKI_ITEM_ART } from "../config/shared/wikiItemArt";
import { WIKI_MOD_ART, WIKI_MOD_ART_BY_NAME } from "../config/shared/wikiModArt";
import { readPepDict, readPepExport, readWfcdItems } from "./bundledGameData";
import { getGameLocale, isLocalizingNames, localizeName } from "./gameLocale";
import * as publicExportSource from "./publicExportSource";
import { correctedDropRarity } from "./relicRarity";
import { withScope } from "./logger";
import type {
  PepExportItem,
  DropEntry,
  ComponentEntry,
  RecipeData,
  RendererItemEntry,
} from "./types/gameData";

const log = withScope("itemDatabase");

// Source image URLs are rewritten to the WFHelper icon mirror before they reach the renderer.
const WFCD_CDN = "https://cdn.warframestat.us/img/";
const BROWSE_WF = "https://browse.wf";
const ICON_MIRROR_BASE_URL = (
  process.env.WFHELPER_ICON_MIRROR_URL || "https://assets.wfhelper.com"
).replace(/\/+$/, "");
const IMAGE_LOG_CATEGORY_LIMIT = 5;
const IMAGE_LOG_SAMPLE_LIMIT = 5;

export function toIconMirrorUrl(sourceUrl: string | null | undefined): string | null {
  const trimmed = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (process.env.WFHELPER_ICON_MIRROR_DISABLED === "1") return trimmed;
    if (parsed.hostname === new URL(ICON_MIRROR_BASE_URL).hostname) return trimmed;

    const ext = path.extname(parsed.pathname).toLowerCase();
    const hash = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
    return `${ICON_MIRROR_BASE_URL}/icons/${hash}${ext && ext.length <= 8 ? ext : ".png"}`;
  } catch {
    return null;
  }
}

function buildWfcdImageUrl(imageName: string | null | undefined): string | null {
  const trimmed = typeof imageName === "string" ? imageName.trim() : "";
  return trimmed ? WFCD_CDN + trimmed : null;
}

// DE's export ships the flat mod texture; the wiki has the framed card players
// know. Mirror-only, so the manifest builder never takes it for an upstream URL.
function wikiCardArtUrl(uniqueName: string, category: string, displayName: string): string | null {
  if (process.env.WFHELPER_ICON_MIRROR_DISABLED === "1") return null;
  // Per-item overrides are keyed by uniqueName and win over everything, so an
  // item DE draws badly is fixed without widening the category gate below.
  const item = WIKI_ITEM_ART[uniqueName];
  if (item) return `${ICON_MIRROR_BASE_URL}/item-art/${encodeURIComponent(item)}.webp`;
  if (category !== "Mod" && category !== "Arcane") return null;
  // The wiki's internal names have drifted from DE's for railjack mods and
  // stances, so the display name is the only join left for those.
  const stem = WIKI_MOD_ART[uniqueName] ?? WIKI_MOD_ART_BY_NAME[displayName];
  return stem ? `${ICON_MIRROR_BASE_URL}/mod-art/${encodeURIComponent(stem)}.webp` : null;
}

function chooseImageUrl(...urls: Array<string | null | undefined>): string | null {
  return toIconMirrorUrl(urls.find((url) => typeof url === "string" && url.trim()));
}

function isLikelyBuildComponent(uniqueName: string, componentName: string = ""): boolean {
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

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pickTradable(currentValue: unknown, incomingValue: unknown): boolean | undefined {
  const current = normalizeOptionalBoolean(currentValue);
  const incoming = normalizeOptionalBoolean(incomingValue);

  return current !== undefined ? current : incoming;
}

function isWeaponPartRecipePath(uniqueName: string = ""): boolean {
  return /\/Types\/Recipes\/Weapons\/WeaponParts?\//i.test(String(uniqueName || ""));
}

function resolveComponentTradable(
  componentTradable: unknown,
  parentTradable: unknown,
  uniqueName: string = "",
): boolean | undefined {
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

function buildComponentDisplayName(
  parentName: string,
  componentName: string,
  forceBlueprintSuffix: boolean = false,
): string {
  const parent = sanitizeDisplayName(parentName);
  const component = sanitizeDisplayName(componentName);

  if (!parent && !component) return "Unknown";
  if (!component) return parent || "Unknown";

  let finalComponent = component;
  if (forceBlueprintSuffix && !/\bblueprint$/i.test(finalComponent)) {
    finalComponent = `${finalComponent} Blueprint`;
  }

  if (!parent) return finalComponent;

  // A component overlapping the parent's tail is already a full item name.
  const parentWords = parent.split(/\s+/);
  const componentWords = finalComponent.split(/\s+/);
  for (let k = Math.min(parentWords.length, componentWords.length); k > 0; k--) {
    const parentTail = parentWords.slice(-k).join(" ").toLowerCase();
    const componentHead = componentWords.slice(0, k).join(" ").toLowerCase();
    if (parentTail === componentHead) return finalComponent;
  }

  return `${parent} ${finalComponent}`;
}

function buildComponentAliasUniqueNames(uniqueName: string = ""): string[] {
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

interface ItemEntry extends MarketAcquisition {
  name: string;
  nameIsFallback?: true;
  category: string;
  imageUrl: string | null;
  browseWfUrl?: string | null;
  isPrime: boolean;
  masteryReq: number;
  masterable?: boolean;
  tradable?: boolean;
  vaulted: boolean;
  exalted?: boolean;
  description: string;
  /** `/Lotus/Language/...` key `name` was resolved from, for game-language lookup. */
  nameKey?: string | null;
  productCategory: string | null;
  ducats: number | null;
  _source: string;
  type?: string;
  wikiaUrl?: string | null;
  components?: ComponentEntry[];
  drops?: DropEntry[];
  isBuildComponent?: boolean;
  componentOf?: string;
}

let itemsByUniqueName: Record<string, ItemEntry> = {};
let wfcdItemsByUniqueName: Record<string, ItemEntry> = {};
// Bundled sentinel weapon -> sentinel, from DE's export.
let sentinelWeapons = new Map<string, string>();
/** Maps resultType (the produced item's uniqueName) -> recipe data. */
let recipesByResultType: Record<string, RecipeData> = {};
/** Maps blueprint uniqueName -> resultType it builds. */
let resultTypeByBlueprint: Record<string, string> = {};
/** Blueprints DE marks consumeOnUse=false: the copy survives its own build. */
let reusableBlueprints = new Set<string>();
/** resultType -> Market credit price, null when DE offers the blueprint at no listed price. */
let marketCreditsByResultType: Record<string, number | null> = {};
/** resultTypes whose blueprint is a clan dojo research project. */
let dojoResearchResultTypes = new Set<string>();

function loadDict(): Readonly<Record<string, string>> {
  let failure = "file missing";
  try {
    const dict = readPepDict("en");
    const count = dict ? Object.keys(dict).length : 0;
    if (dict && count > 0) {
      log.info(`[ItemDB] dict.en.json loaded from disk (${count} strings)`);
      return dict;
    }
  } catch (e) {
    failure = normalizeErrorMessage(e);
  }

  log.warn("[ItemDB] Could not load dict.en.json:", failure);
  log.warn(
    "[ItemDB] Names from public-export-plus will fall back to @wfcd/items or path extraction",
  );
  return {};
}

function loadPublicExportPlus(): number {
  try {
    const dict = loadDict();

    function resolveName(nameKey: string | null | undefined): string | null {
      if (!nameKey) return null;
      if (!nameKey.startsWith("/")) return nameKey;
      return dict[nameKey] || null;
    }

    function resolveIcon(iconPath: string | null | undefined): string | null {
      if (!iconPath) return null;
      return BROWSE_WF + iconPath;
    }

    const VOID_PROJECTION_RE = /VoidProjection/i;

    const exportMappings = [
      { exportKey: "ExportWarframes", category: "Warframe" },
      { exportKey: "ExportWeapons", category: "Weapon" },
      { exportKey: "ExportSentinels", category: "Companion" },
      { exportKey: "ExportResources", category: "Resource" },
      { exportKey: "ExportKeys", category: "Key" },
      { exportKey: "ExportRecipes", category: "Recipe" },
      { exportKey: "ExportGear", category: "Gear" },
      { exportKey: "ExportArcanes", category: "Arcane" },
      { exportKey: "ExportUpgrades", category: "Mod" },
      { exportKey: "ExportMisc", category: "Misc" },
      { exportKey: "ExportRelics", category: "Relic" },
      { exportKey: "ExportRailjackWeapons", category: "Railjack" },
      { exportKey: "ExportFusionBundles", category: "Fusion" },
      { exportKey: "ExportCustoms", category: "Cosmetic" },
      { exportKey: "ExportFlavour", category: "Cosmetic" },
      { exportKey: "ExportDrones", category: "Gear" },
    ];

    let pepCount = 0;

    // Gap-fill from DE's export: bundled wins on shared uniqueNames, DE-only
    // items get added (covers frames/weapons newer than the bundled package).
    const overlayExports = publicExportSource.getOverlay()?.exports as
      | Record<string, Record<string, PepExportItem>>
      | undefined;

    const tables = exportMappings.map((mapping) => ({
      ...mapping,
      baseData: readPepExport(mapping.exportKey),
    }));
    for (const { exportKey, category, baseData } of tables) {
      const overlayData = overlayExports?.[exportKey];
      const exportData = overlayData ? { ...overlayData, ...(baseData || {}) } : baseData;
      if (!exportData || typeof exportData !== "object") continue;

      for (const [uniqueName, item] of Object.entries(exportData) as [string, PepExportItem][]) {
        if (!uniqueName || uniqueName === "default") continue;

        // Relics have no name field - build from era + category (e.g. "Axi A2 Relic")
        const relicName =
          exportKey === "ExportRelics" && item.era && item.category
            ? `${item.era} ${item.category} Relic`
            : null;

        // Recipes have no name - resolve via resultType (e.g. "Sands of Inaros Blueprint")
        let recipeName: string | null = null;
        let recipeNameIsFallback = false;
        if (exportKey === "ExportRecipes" && !item.name && item.resultType) {
          const resultEntry = itemsByUniqueName[item.resultType];
          if (resultEntry?.name) {
            recipeName = `${resultEntry.name} Blueprint`;
            recipeNameIsFallback = resultEntry.nameIsFallback === true;
          }
        }

        const sourceName = relicName || recipeName || resolveName(item.name);
        const resolvedName = sanitizeDisplayName(
          sourceName || fallbackNameFromUniqueName(uniqueName),
        );

        const pepDucats =
          typeof item.primeSellingPrice === "number" && Number.isFinite(item.primeSellingPrice)
            ? Math.max(0, Math.round(item.primeSellingPrice))
            : null;

        // For recipes without an icon, inherit from the result item
        const recipeIcon =
          !item.icon && item.resultType
            ? (itemsByUniqueName[item.resultType]?.browseWfUrl ?? null)
            : null;

        // Only a plain dict resolve is re-localizable: relic and recipe names are
        // composed from English words that no dictionary key covers.
        const nameKey =
          !relicName && !recipeName && typeof item.name === "string" && item.name.startsWith("/")
            ? item.name
            : null;

        // DE lists relics the bundled package lacks only under ExportResources.
        // Bundled rows keep their own category, base projection types included.
        const itemCategory =
          category === "Resource" && !baseData?.[uniqueName] && VOID_PROJECTION_RE.test(uniqueName)
            ? "Relic"
            : category;

        itemsByUniqueName[uniqueName] = {
          name: resolvedName,
          ...(!sourceName || recipeNameIsFallback ? { nameIsFallback: true as const } : {}),
          nameKey,
          category: itemCategory,
          imageUrl: wikiCardArtUrl(uniqueName, itemCategory, resolvedName),
          browseWfUrl: resolveIcon(item.icon) || recipeIcon,
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
        if (exportKey === "ExportSentinels" && typeof item.defaultWeapon === "string") {
          sentinelWeapons.set(item.defaultWeapon, uniqueName);
        }
      }
    }

    log.info(`[ItemDB] public-export-plus: ${pepCount} items indexed`);
    return pepCount;
  } catch (err) {
    log.warn("[ItemDB] warframe-public-export-plus not available:", normalizeErrorMessage(err));
    return 0;
  }
}

function loadWfcdItems(): number {
  try {
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

    const items = readWfcdItems(CATEGORIES);
    let wfcdNewCount = 0;
    let wfcdSupplementCount = 0;
    let wfcdComponentNewCount = 0;
    let wfcdComponentSupplementCount = 0;

    // Top-level WFCD components already carry their complete tradable name.
    const wfcdStandaloneNames = new Map<string, string>();
    for (const item of items) {
      if (item.uniqueName && item.name) {
        wfcdStandaloneNames.set(item.uniqueName, sanitizeDisplayName(item.name));
      }
    }

    for (const item of items) {
      if (!item.uniqueName) continue;

      // Fix upstream relic rarity labels before any entry copies these arrays
      // (item entries, component entries, and the merge path all reuse them).
      item.drops = correctDropRarities(item.drops);
      for (const comp of item.components || []) {
        comp.drops = correctDropRarities(comp.drops);
      }

      const wfcdImageUrl = buildWfcdImageUrl(item.imageName);

      const wfcdRootDucats = normalizeDucats(item.ducats);

      const wfcdEntry: ItemEntry = {
        name: sanitizeDisplayName(item.name || "Unknown"),
        category: item.category || "Misc",
        imageUrl: chooseImageUrl(item.wikiaThumbnail, wfcdImageUrl),
        isPrime: sanitizeDisplayName(item.name || "").includes("Prime"),
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

      if (item.components) {
        for (const comp of item.components) {
          if (comp.uniqueName) {
            const componentLooksLikePart = isLikelyBuildComponent(comp.uniqueName, comp.name);
            const componentAliasUniqueNames = buildComponentAliasUniqueNames(comp.uniqueName);
            const componentUsesBlueprintAlias = componentAliasUniqueNames.length > 0;
            const forceComponentBlueprintName = /Component$/i.test(comp.uniqueName);
            const compDucats = normalizeDucats(comp.ducats);
            const compIsStandaloneItem =
              wfcdStandaloneNames.get(comp.uniqueName)?.toLowerCase() ===
              sanitizeDisplayName(comp.name || "").toLowerCase();
            const componentName = buildComponentDisplayName(
              compIsStandaloneItem ? "" : item.name,
              comp.name,
              forceComponentBlueprintName,
            );

            // "blueprint.png" is a generic placeholder that 404s on the WFCD CDN -
            // fall back to the parent item's image for blueprint components.
            const existingComponent = itemsByUniqueName[comp.uniqueName];
            const compWfcdImageUrl =
              comp.imageName && comp.imageName !== "blueprint.png"
                ? buildWfcdImageUrl(comp.imageName)
                : null;
            const compImageUrl = chooseImageUrl(
              existingComponent?.browseWfUrl,
              wfcdEntry.imageUrl,
              compWfcdImageUrl,
            );

            const componentEntry: ItemEntry = {
              ...wfcdEntry,
              name: componentName,
              imageUrl: compImageUrl,
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

            if (!existingComponent) {
              itemsByUniqueName[comp.uniqueName] = componentEntry;
              wfcdComponentNewCount++;
            } else {
              if (
                componentEntry.name &&
                (!existingComponent.name ||
                  existingComponent.nameIsFallback ||
                  String(existingComponent.name).startsWith("/Lotus/") ||
                  componentLooksLikePart)
              ) {
                existingComponent.name = componentEntry.name;
                delete existingComponent.nameIsFallback;
              }

              if (!existingComponent.imageUrl && componentEntry.imageUrl) {
                existingComponent.imageUrl = componentEntry.imageUrl;
              }

              if (componentEntry.vaulted) {
                existingComponent.vaulted = true;
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
                  delete existingBlueprint.nameIsFallback;
                }

                const aliasWfcdImageUrl = buildWfcdImageUrl(comp.imageName) || wfcdImageUrl;
                const aliasImage = chooseImageUrl(
                  existingBlueprint.browseWfUrl,
                  wfcdEntry.imageUrl,
                  aliasWfcdImageUrl,
                );
                if (!existingBlueprint.imageUrl && aliasImage) {
                  existingBlueprint.imageUrl = aliasImage;
                }

                if (wfcdEntry.vaulted) {
                  existingBlueprint.vaulted = true;
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
        itemsByUniqueName[item.uniqueName] = wfcdEntry;
        wfcdNewCount++;
      } else {
        const existing = itemsByUniqueName[item.uniqueName];

        existing.imageUrl = chooseImageUrl(
          wikiCardArtUrl(item.uniqueName, existing.category, existing.name),
          existing.browseWfUrl,
          item.wikiaThumbnail,
          wfcdImageUrl,
        );

        if ((existing.nameIsFallback || existing.name.startsWith("/Lotus/")) && item.name) {
          const cleanedName = sanitizeDisplayName(item.name);
          existing.name = cleanedName;
          delete existing.nameIsFallback;
          existing.isPrime = cleanedName.includes("Prime");
        }

        const mergedItemTradable = pickTradable(existing.tradable, item.tradable);
        if (mergedItemTradable !== undefined) {
          existing.tradable = mergedItemTradable;
        }
        // DE's export has no vault status at all; @wfcd is the only source.
        if (wfcdEntry.vaulted) {
          existing.vaulted = true;
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
        if (wfcdRootDucats != null) {
          existing.ducats = wfcdRootDucats;
        }
        wfcdSupplementCount++;
      }
    }

    log.info(
      `[ItemDB] @wfcd/items: ${wfcdNewCount} new + ${wfcdSupplementCount} supplemented + ${wfcdComponentNewCount} component entries + ${wfcdComponentSupplementCount} component supplements`,
    );
    return wfcdNewCount;
  } catch (err) {
    log.warn("[ItemDB] @wfcd/items not available:", normalizeErrorMessage(err));
    return 0;
  }
}

function resolveAllImages(): void {
  let preResolved = 0;
  let browseWfSourced = 0;
  let noImage = 0;
  const noImageCategories = new Map<string, number>();
  const noImageSamples: string[] = [];

  for (const [uniqueName, item] of Object.entries(itemsByUniqueName)) {
    if (item.imageUrl) {
      preResolved++;
      continue;
    }

    if (item.browseWfUrl) {
      item.imageUrl = toIconMirrorUrl(item.browseWfUrl);
      browseWfSourced++;
      continue;
    }

    const wfcd = wfcdItemsByUniqueName[uniqueName];
    if (wfcd?.imageUrl) {
      item.imageUrl = wfcd.imageUrl;
      preResolved++;
      continue;
    }

    noImage++;
    const category = item.category || "Unknown";
    noImageCategories.set(category, (noImageCategories.get(category) || 0) + 1);
    if (noImageSamples.length < IMAGE_LOG_SAMPLE_LIMIT) {
      noImageSamples.push(`${item.name || fallbackNameFromUniqueName(uniqueName)} (${category})`);
    }
  }

  const mirrorEnabled = process.env.WFHELPER_ICON_MIRROR_DISABLED !== "1";
  log.info(
    `[ItemDB] Images: mirror=${ICON_MIRROR_BASE_URL} (${mirrorEnabled ? "enabled" : "disabled"}), ${preResolved} mirrored from resolved sources, ${browseWfSourced} mirrored from browse.wf source paths, ${noImage} unresolved`,
  );
  if (noImage > 0) {
    const categorySummary = [...noImageCategories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, IMAGE_LOG_CATEGORY_LIMIT)
      .map(([category, count]) => `${category} ${count}`)
      .join(", ");
    log.info(
      `[ItemDB] Images unresolved: no upstream icon URL in PEP/WFCD/browse.wf; top categories: ${categorySummary}; samples: ${noImageSamples.join(", ")}`,
    );
  }
}

interface PepRecipeItem {
  resultType?: string;
  buildPrice?: number;
  buildTime?: number;
  num?: number;
  consumeOnUse?: boolean;
  creditsCost?: number;
  excludeFromMarket?: boolean;
  ingredients?: { ItemType: string; ItemCount: number }[];
}

function buildRecipeIndex(): void {
  try {
    const baseRecipes = readPepExport("ExportRecipes") as Record<string, PepRecipeItem> | undefined;
    const overlayRecipes = publicExportSource.getOverlay()?.exports.ExportRecipes as
      | Record<string, PepRecipeItem>
      | undefined;
    const exportData = overlayRecipes ? { ...overlayRecipes, ...(baseRecipes || {}) } : baseRecipes;
    if (!exportData || typeof exportData !== "object") return;

    recipesByResultType = {};
    resultTypeByBlueprint = {};
    reusableBlueprints = new Set();
    marketCreditsByResultType = {};
    dojoResearchResultTypes = new Set();
    let count = 0;
    for (const [recipeKey, item] of Object.entries(exportData) as [string, PepRecipeItem][]) {
      if (!item.resultType || !Array.isArray(item.ingredients)) continue;
      resultTypeByBlueprint[recipeKey] = item.resultType;
      if (item.consumeOnUse === false) reusableBlueprints.add(recipeKey);
      // DE's raw export has no market fields, so an overlay-only recipe cannot claim one.
      if (baseRecipes?.[recipeKey] && item.excludeFromMarket !== true) {
        const credits =
          typeof item.creditsCost === "number" && Number.isFinite(item.creditsCost)
            ? item.creditsCost
            : null;
        // Several recipes can build one item, so a listed price beats a missing one.
        if (marketCreditsByResultType[item.resultType] == null) {
          marketCreditsByResultType[item.resultType] = credits;
        }
      }
      recipesByResultType[item.resultType] = {
        buildPrice: item.buildPrice || 0,
        buildTime: item.buildTime || 0,
        num: item.num || 1,
        blueprintUniqueName: recipeKey,
        // consumeOnUse=false = infinite-use blueprint: one copy covers any build count
        ...(item.consumeOnUse === false ? { reusableBlueprint: true } : {}),
        ingredients: item.ingredients.map((i) => ({
          uniqueName: i.ItemType,
          count: i.ItemCount || 1,
        })),
      };
      count++;
    }

    // Dojo research is keyed by the recipe uniqueName, so it joins to an item
    // only through that recipe's resultType.
    const research = (
      readPepExport("ExportDojoRecipes") as { research?: Record<string, unknown> } | undefined
    )?.research;
    for (const researchKey of Object.keys(research || {})) {
      const resultType = resultTypeByBlueprint[researchKey];
      if (resultType) dojoResearchResultTypes.add(resultType);
    }

    log.info(
      `[ItemDB] Recipe index: ${count} recipes by resultType, ${Object.keys(marketCreditsByResultType).length} market blueprints, ${dojoResearchResultTypes.size} dojo research results`,
    );
  } catch {
    log.warn("[ItemDB] Could not build recipe index");
  }
}

// Market and dojo facts live on the recipe, not the item, and the wfcd pass can
// replace a whole entry, so stamp them once every loader has run.
function applyAcquisitionSources(): void {
  let market = 0;
  let dojo = 0;
  for (const [resultType, credits] of Object.entries(marketCreditsByResultType)) {
    const entry = itemsByUniqueName[resultType];
    if (!entry) continue;
    entry.marketBuyable = true;
    if (credits != null) entry.marketCredits = credits;
    market++;
  }
  for (const resultType of dojoResearchResultTypes) {
    const entry = itemsByUniqueName[resultType];
    if (!entry) continue;
    entry.dojoResearch = true;
    dojo++;
  }
  log.info(`[ItemDB] Acquisition: ${market} market blueprints, ${dojo} dojo research items`);
}

// Recipe aliases inherit their crafted item's mappings.
function linkBlueprintsToResults(): void {
  let linked = 0;
  for (const [blueprintUn, resultUn] of Object.entries(resultTypeByBlueprint)) {
    const blueprint = itemsByUniqueName[blueprintUn];
    const result = itemsByUniqueName[resultUn];
    if (!blueprint || !result) continue;
    if (blueprint.componentOf || !result.isBuildComponent || !result.componentOf) continue;
    blueprint.isBuildComponent = true;
    blueprint.componentOf = result.componentOf;
    linked++;
  }
  if (linked > 0) log.info(`[ItemDB] Linked ${linked} part blueprints to parents via resultType`);
}

// ExportRecipes loads before ExportGear/Customs/Misc, so a recipe whose result
// sits in a later export missed both its name and its inherited icon.
function inheritBlueprintDisplayFromResults(): void {
  let renamed = 0;
  let icons = 0;
  for (const [blueprintUn, resultUn] of Object.entries(resultTypeByBlueprint)) {
    const blueprint = itemsByUniqueName[blueprintUn];
    const result = itemsByUniqueName[resultUn];
    if (!blueprint || !result) continue;

    if (!blueprint.browseWfUrl && result.browseWfUrl) {
      blueprint.browseWfUrl = result.browseWfUrl;
      icons++;
    }

    // Only rename what nothing else named, and only when the result itself
    // resolved - swapping one path-derived name for another gains nothing.
    if (!result.name) continue;
    if (!blueprint.nameIsFallback || result.nameIsFallback) continue;
    // A warframe part component is already named "... Chassis Blueprint" - that
    // spelling is the item players own and trade, so appending doubles it.
    const derived = sanitizeDisplayName(
      /\bblueprint$/i.test(result.name) ? result.name : `${result.name} Blueprint`,
    );
    delete blueprint.nameIsFallback;
    if (derived === blueprint.name) continue;
    blueprint.name = derived;
    blueprint.isPrime = derived.includes("Prime");
    renamed++;
  }
  if (renamed > 0) log.info(`[ItemDB] Renamed ${renamed} blueprints after their crafted item`);
  if (icons > 0) log.info(`[ItemDB] Inherited ${icons} blueprint icons from their crafted item`);
}

// Bundled sentinel weapons have no relic drops for WFCD to derive vaulting from.
function inheritSentinelWeaponVaulting(): void {
  for (const [weapon, sentinel] of sentinelWeapons) {
    const entry = itemsByUniqueName[weapon];
    if (entry && itemsByUniqueName[sentinel]?.vaulted) entry.vaulted = true;
  }
}

// Venari drops from no relic, so WFCD never vaults her.
const COMPANION_FRAME_PATTERN = /^\/Lotus\/Powersuits\/([^/]+)\/Kavat\/\1(Prime)?KavatPowerSuit$/;

function inheritCompanionFrameVaulting(): void {
  for (const [uniqueName, entry] of Object.entries(itemsByUniqueName)) {
    const match = COMPANION_FRAME_PATTERN.exec(uniqueName);
    if (!match) continue;
    const frame = itemsByUniqueName[`/Lotus/Powersuits/${match[1]}/${match[1]}${match[2] ?? ""}`];
    if (frame?.vaulted) entry.vaulted = true;
  }
}

// WFCD inherits false resource tradability for crafted mech parts.
function applyMechPartTradability(): void {
  let fixed = 0;
  for (const [uniqueName, item] of Object.entries(itemsByUniqueName)) {
    if (!isInfestedMechPart(uniqueName)) continue;
    if (item.tradable === true) continue;
    item.tradable = true;
    fixed++;
  }
  if (fixed > 0) log.info(`[ItemDB] Marked ${fixed} Necramech part items tradable`);
}

export function buildDatabase(): void {
  log.time("[ItemDB] Total build time");

  // Reset so a rebuild (e.g. after the DE export refresh) starts clean.
  itemsByUniqueName = {};
  nameSlugIndex = null;
  wfcdItemsByUniqueName = {};
  sentinelWeapons = new Map();
  recipesByResultType = {};
  rendererLookup = null;
  resultTypeByBlueprint = {};
  reusableBlueprints = new Set();
  marketCreditsByResultType = {};
  dojoResearchResultTypes = new Set();

  const pepCount = loadPublicExportPlus();
  buildRecipeIndex();
  const wfcdCount = loadWfcdItems();
  inheritSentinelWeaponVaulting();
  inheritCompanionFrameVaulting();
  applyMechPartTradability();
  linkBlueprintsToResults();
  inheritBlueprintDisplayFromResults();
  applyAcquisitionSources();
  resolveAllImages();

  log.info(`[ItemDB] Total: ${Object.keys(itemsByUniqueName).length} items`);
  log.timeEnd("[ItemDB] Total build time");

  if (pepCount === 0 && wfcdCount === 0) {
    log.error("[ItemDB] WARNING: No item data loaded! Run 'npm install' to get packages.");
  }
}

export function lookupItem(uniqueName: string): ItemEntry | null {
  return itemsByUniqueName[uniqueName] || null;
}

interface NameIndexEntry {
  order: number;
  uniqueName: string;
  item: ItemEntry;
}

/** First match in build order, and the first that also carries part metadata. */
interface NameIndexBucket {
  strong: NameIndexEntry | null;
  first: NameIndexEntry;
}

interface NameSlugIndex {
  byName: Map<string, NameIndexBucket>;
  bySlug: Map<string, NameIndexBucket>;
}

// Rebuilt lazily because buildDatabase() drops it. The scan this replaces
// slugified all 20k names per call, and the relic reward rows make ~19k calls.
let nameSlugIndex: NameSlugIndex | null = null;

function hasPartMetadata(item: ItemEntry): boolean {
  return Boolean(item.componentOf || item.ducats != null || item.isBuildComponent);
}

function indexUnderKey(
  map: Map<string, NameIndexBucket>,
  key: string,
  entry: NameIndexEntry,
): void {
  const bucket = map.get(key);
  if (!bucket) {
    map.set(key, { strong: hasPartMetadata(entry.item) ? entry : null, first: entry });
    return;
  }
  if (!bucket.strong && hasPartMetadata(entry.item)) bucket.strong = entry;
}

function getNameSlugIndex(): NameSlugIndex {
  if (nameSlugIndex) return nameSlugIndex;

  const byName = new Map<string, NameIndexBucket>();
  const bySlug = new Map<string, NameIndexBucket>();
  let order = 0;
  for (const [uniqueName, item] of Object.entries(itemsByUniqueName)) {
    const entry: NameIndexEntry = { order: order++, uniqueName, item };
    const itemName = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
    if (itemName) indexUnderKey(byName, itemName, entry);
    const itemSlug = normalizeWfmSlug(item.name || "");
    if (itemSlug) indexUnderKey(bySlug, itemSlug, entry);
  }

  nameSlugIndex = { byName, bySlug };
  return nameSlugIndex;
}

function earliestEntry(entries: Array<NameIndexEntry | null>): NameIndexEntry | null {
  let best: NameIndexEntry | null = null;
  for (const entry of entries) {
    if (entry && (!best || entry.order < best.order)) best = entry;
  }
  return best;
}

export function lookupItemByNameOrSlug(
  name: string | null | undefined,
  slug: string | null | undefined,
): { uniqueName: string; item: ItemEntry } | null {
  const normalizedName = typeof name === "string" ? name.trim().toLowerCase() : "";
  const normalizedSlug = typeof slug === "string" ? normalizeWfmSlug(slug) : null;
  if (!normalizedName && !normalizedSlug) return null;

  const index = getNameSlugIndex();
  const buckets = [
    normalizedName ? index.byName.get(normalizedName) : undefined,
    normalizedSlug ? index.bySlug.get(normalizedSlug) : undefined,
  ].filter((bucket): bucket is NameIndexBucket => bucket != null);
  if (buckets.length === 0) return null;

  const best =
    earliestEntry(buckets.map((bucket) => bucket.strong)) ??
    earliestEntry(buckets.map((bucket) => bucket.first));
  return best ? { uniqueName: best.uniqueName, item: best.item } : null;
}

/** True when building this blueprint does not consume the owned copy. */
export function isReusableBlueprint(uniqueName: string): boolean {
  return reusableBlueprints.has(uniqueName);
}

function correctDropRarities(drops?: DropEntry[]): DropEntry[] | undefined {
  return drops?.map((d) => ({
    ...d,
    rarity: correctedDropRarity(d.location || "", d.chance || 0, d.rarity || ""),
  }));
}

function toRendererDrop(d: DropEntry): DropEntry {
  return {
    location: d.location || "",
    type: d.type || "",
    chance: d.chance || 0,
    rarity: d.rarity || "",
  };
}

const BLUEPRINT_PATTERN_KEY = "/Lotus/Language/Items/BlueprintAndItem";
const BLUEPRINT_PATTERN_EN = "|ITEM| Blueprint";

// Recipes carry no name of their own; theirs is composed from the item they build,
// using DE's word-order pattern (Spanish/Russian lead with it, Japanese does not).
function localizeItemName(
  uniqueName: string,
  nameKey: string | null | undefined,
  english: string,
): string {
  if (nameKey) return localizeName(nameKey, english);
  const result = itemsByUniqueName[resultTypeByBlueprint[uniqueName]];
  if (!result) return english;
  return localizeName(BLUEPRINT_PATTERN_KEY, BLUEPRINT_PATTERN_EN).replace(
    "|ITEM|",
    localizeName(result.nameKey, result.name),
  );
}

// `name` stays English because the renderer joins on it; `displayName` appears
// only when the game language actually moved the name, so English users pay nothing.
function localizedPair(uniqueName: string, nameKey: string | null | undefined, english: string) {
  const localized = localizeItemName(uniqueName, nameKey, english);
  return localized === english ? { name: english } : { name: english, displayName: localized };
}

/**
 * displayName for anything built outside getRendererLookup, keyed by uniqueName.
 * Spread it next to an English `name`; it is empty whenever nothing would move.
 */
export function localizedNameFields(
  uniqueName: string | null | undefined,
  english: string,
): { displayName?: string } {
  if (!isLocalizingNames() || !uniqueName) return {};
  const pair = localizedPair(uniqueName, itemsByUniqueName[uniqueName]?.nameKey, english);
  return pair.displayName ? { displayName: pair.displayName } : {};
}

/** True once a mirrored wiki card survived the merge as the item's art - lets a
 *  WIKI_ITEM_ART override on a mod outrank the WFM thumbnail. */
function hasCardArt(imageUrl: string | null): boolean {
  return imageUrl != null && (imageUrl.includes("/mod-art/") || imageUrl.includes("/item-art/"));
}

export function getRendererLookup(): Record<string, RendererItemEntry> {
  const localizing = isLocalizingNames();
  const lookup: Record<string, RendererItemEntry> = {};
// Every window pulls the whole projection at boot and on each item-db-updated, so it
// is built once per database build and game language, then shared read-only.
let rendererLookup: { locale: string; lookup: Record<string, RendererItemEntry> } | null = null;

  for (const [key, item] of Object.entries(itemsByUniqueName)) {
  const locale = getGameLocale();
  if (rendererLookup?.locale === locale) return rendererLookup.lookup;
    lookup[key] = {
      ...(localizing ? localizedPair(key, item.nameKey, item.name) : { name: item.name }),
      ...(item.nameIsFallback ? { nameIsFallback: true as const } : {}),
      category: item.category,
      imageUrl: item.imageUrl,
      ...(hasCardArt(item.imageUrl) ? { cardArt: true } : {}),
      isPrime: item.isPrime,
      tradable: typeof item.tradable === "boolean" ? item.tradable : undefined,
      masteryReq: item.masteryReq || 0,
      vaulted: item.vaulted || false,
      exalted: item.exalted || false,
      masterable: typeof item.masterable === "boolean" ? item.masterable : undefined,
      type: item.type || "",
      isBuildComponent: item.isBuildComponent === true,
      ...(item.componentOf ? { componentOf: item.componentOf } : {}),
      description: item.description || "",
      productCategory: item.productCategory || null,
      ducats: typeof item.ducats === "number" ? item.ducats : null,
      components: (item.components || []).map((c: ComponentEntry) => ({
        // Set parts carry no key of their own, so borrow the part item's.
        ...(localizing
          ? localizedPair(
              c.uniqueName || "",
              c.nameKey ?? itemsByUniqueName[c.uniqueName]?.nameKey,
              c.name || "",
            )
          : { name: c.name || "" }),
        uniqueName: c.uniqueName || "",
        tradable: typeof c.tradable === "boolean" ? c.tradable : undefined,
        itemCount: c.itemCount || 1,
        drops: (c.drops || []).map(toRendererDrop),
      })),
      drops: (item.drops || []).slice(0, 20).map(toRendererDrop),
      wikiaUrl: item.wikiaUrl || null,
      ...(recipesByResultType[key] ? { recipe: recipesByResultType[key] } : {}),
      ...(reusableBlueprints.has(key) ? { reusableBlueprint: true } : {}),
      ...(resultTypeByBlueprint[key] && itemsByUniqueName[resultTypeByBlueprint[key]]
        ? { buildsProduct: resultTypeByBlueprint[key] }
        : {}),
    };
  }
  return lookup;
}

function cloneDropEntry(drop: DropEntry): DropEntry {
  rendererLookup = { locale, lookup };
  return { ...drop };
}

function cloneComponentEntry(component: ComponentEntry): ComponentEntry {
  return {
    ...component,
    ...(component.drops ? { drops: component.drops.map(cloneDropEntry) } : {}),
  };
}

function cloneItemEntry(item: ItemEntry): ItemEntry {
  return {
    ...item,
    ...(item.components ? { components: item.components.map(cloneComponentEntry) } : {}),
    ...(item.drops ? { drops: item.drops.map(cloneDropEntry) } : {}),
  };
}

export function getAllItems(): Readonly<Record<string, Readonly<ItemEntry>>> {
  return Object.fromEntries(
    Object.entries(itemsByUniqueName).map(([uniqueName, item]) => [
      uniqueName,
      cloneItemEntry(item),
    ]),
  );
}
