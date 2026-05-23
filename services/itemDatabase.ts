/**
 * itemDatabase.ts — Item database service.
 * Primary:  warframe-public-export-plus (Sainan/calamity-inc) — raw game data
 * Fallback: @wfcd/items (WFCD) — curated community data with proven image CDN
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sanitizeDisplayName } from "../config/shared/displayName";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeDucats } from "../config/shared/numeric";
import { normalizeWfmSlug } from "../config/shared/wfm";
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

  return parent ? `${parent} ${finalComponent}` : finalComponent;
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

interface ItemEntry {
  name: string;
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
/** Maps resultType (the produced item's uniqueName) → recipe data. */
let recipesByResultType: Record<string, RecipeData> = {};

function loadDict(): Record<string, string> {
  const attempts: string[] = [];

  try {
    const d = require("warframe-public-export-plus/dict.en.json");
    if (d && typeof d === "object" && Object.keys(d).length > 0) {
      log.info(`[ItemDB] dict.en.json loaded via require (${Object.keys(d).length} strings)`);
      return d;
    }
  } catch (e) {
    attempts.push(`require: ${normalizeErrorMessage(e)}`);
  }

  try {
    const modPath = require.resolve("warframe-public-export-plus/package.json");
    const modDir = path.dirname(modPath);
    const dictPath = path.join(modDir, "dict.en.json");
    if (fs.existsSync(dictPath)) {
      const d = JSON.parse(fs.readFileSync(dictPath, "utf-8"));
      log.info(`[ItemDB] dict.en.json loaded from disk (${Object.keys(d).length} strings)`);
      return d;
    } else {
      attempts.push(`disk: file not found at ${dictPath}`);
    }
  } catch (e) {
    attempts.push(`disk: ${normalizeErrorMessage(e)}`);
  }

  try {
    const pep = require("warframe-public-export-plus");
    if (pep.getString && typeof pep.getString === "function") {
      log.info("[ItemDB] Using pep.getString() for name resolution");
      return { __getString: pep.getString };
    }
    for (const key of ["dict", "dictEn", "dict_en", "strings"]) {
      if (pep[key] && typeof pep[key] === "object") {
        log.info(`[ItemDB] dict found via pep.${key}`);
        return pep[key];
      }
    }
  } catch (e) {
    attempts.push(`main export: ${normalizeErrorMessage(e)}`);
  }

  log.warn("[ItemDB] Could not load dict.en.json. Tried:", attempts.join(" | "));
  log.warn(
    "[ItemDB] Names from public-export-plus will fall back to @wfcd/items or path extraction",
  );
  return {};
}

function loadPublicExportPlus(): number {
  try {
    const pep = require("warframe-public-export-plus");
    const dict = loadDict();

    function resolveName(nameKey: string | null | undefined): string | null {
      if (!nameKey) return null;
      if (!nameKey.startsWith("/")) return nameKey;
      if ((dict as Record<string, unknown>).__getString)
        return (
          ((dict as Record<string, unknown>).__getString as (k: string) => string | null)(
            nameKey,
          ) || null
        );
      return dict[nameKey] || null;
    }

    function resolveIcon(iconPath: string | null | undefined): string | null {
      if (!iconPath) return null;
      return BROWSE_WF + iconPath;
    }

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

    for (const { exportKey, category } of exportMappings) {
      const exportData = pep[exportKey];
      if (!exportData || typeof exportData !== "object") continue;

      for (const [uniqueName, item] of Object.entries(exportData) as [string, PepExportItem][]) {
        if (!uniqueName || uniqueName === "default") continue;

        // Relics have no name field — build from era + category (e.g. "Axi A2 Relic")
        const relicName =
          exportKey === "ExportRelics" && item.era && item.category
            ? `${item.era} ${item.category} Relic`
            : null;

        // Recipes have no name — resolve via resultType (e.g. "Sands of Inaros Blueprint")
        let recipeName: string | null = null;
        if (exportKey === "ExportRecipes" && !item.name && item.resultType) {
          const resultEntry = itemsByUniqueName[item.resultType];
          if (resultEntry?.name) recipeName = `${resultEntry.name} Blueprint`;
        }

        const resolvedName = sanitizeDisplayName(
          relicName || recipeName || resolveName(item.name) || extractFallbackName(uniqueName),
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

        itemsByUniqueName[uniqueName] = {
          name: resolvedName,
          category,
          imageUrl: null,
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
            const componentName = buildComponentDisplayName(
              item.name,
              comp.name,
              forceComponentBlueprintName,
            );

            // "blueprint.png" is a generic placeholder that 404s on the WFCD CDN —
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

                const aliasWfcdImageUrl = buildWfcdImageUrl(comp.imageName) || wfcdImageUrl;
                const aliasImage = chooseImageUrl(
                  existingBlueprint.browseWfUrl,
                  wfcdEntry.imageUrl,
                  aliasWfcdImageUrl,
                );
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
        itemsByUniqueName[item.uniqueName] = wfcdEntry;
        wfcdNewCount++;
      } else {
        const existing = itemsByUniqueName[item.uniqueName];

        existing.imageUrl = chooseImageUrl(existing.browseWfUrl, item.wikiaThumbnail, wfcdImageUrl);

        if (existing.name.startsWith("/Lotus/") && item.name) {
          const cleanedName = sanitizeDisplayName(item.name);
          existing.name = cleanedName;
          existing.isPrime = cleanedName.includes("Prime");
        }

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
      noImageSamples.push(`${item.name || extractFallbackName(uniqueName)} (${category})`);
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

function extractFallbackName(uniqueName: string): string {
  if (!uniqueName) return "Unknown";
  const segments = uniqueName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return sanitizeDisplayName(name);
}

interface PepRecipeItem {
  resultType?: string;
  buildPrice?: number;
  buildTime?: number;
  num?: number;
  ingredients?: { ItemType: string; ItemCount: number }[];
}

function buildRecipeIndex(): void {
  try {
    const pep = require("warframe-public-export-plus");
    const exportData = pep.ExportRecipes;
    if (!exportData || typeof exportData !== "object") return;

    recipesByResultType = {};
    let count = 0;
    for (const [recipeKey, item] of Object.entries(exportData) as [string, PepRecipeItem][]) {
      if (!item.resultType || !Array.isArray(item.ingredients)) continue;
      recipesByResultType[item.resultType] = {
        buildPrice: item.buildPrice || 0,
        buildTime: item.buildTime || 0,
        num: item.num || 1,
        blueprintUniqueName: recipeKey,
        ingredients: item.ingredients.map((i) => ({
          uniqueName: i.ItemType,
          count: i.ItemCount || 1,
        })),
      };
      count++;
    }
    log.info(`[ItemDB] Recipe index: ${count} recipes by resultType`);
  } catch {
    log.warn("[ItemDB] Could not build recipe index");
  }
}

export function buildDatabase(): void {
  log.time("[ItemDB] Total build time");

  const pepCount = loadPublicExportPlus();
  buildRecipeIndex();
  const wfcdCount = loadWfcdItems();
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

export function lookupItemByNameOrSlug(
  name: string | null | undefined,
  slug: string | null | undefined,
): { uniqueName: string; item: ItemEntry } | null {
  const normalizedName = typeof name === "string" ? name.trim().toLowerCase() : "";
  const normalizedSlug = typeof slug === "string" ? normalizeWfmSlug(slug) : null;
  if (!normalizedName && !normalizedSlug) return null;

  let fallback: { uniqueName: string; item: ItemEntry } | null = null;
  for (const [uniqueName, item] of Object.entries(itemsByUniqueName)) {
    const itemName = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
    const itemSlug = normalizeWfmSlug(item.name || "");
    const matchesName = normalizedName && itemName === normalizedName;
    const matchesSlug = normalizedSlug && itemSlug === normalizedSlug;
    if (!matchesName && !matchesSlug) continue;

    const resolved = { uniqueName, item };
    if (item.componentOf || item.ducats != null || item.isBuildComponent) return resolved;
    fallback = fallback || resolved;
  }

  return fallback;
}

export function getRendererLookup(): Record<string, RendererItemEntry> {
  const lookup: Record<string, RendererItemEntry> = {};
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
      ...(item.componentOf ? { componentOf: item.componentOf } : {}),
      description: item.description || "",
      productCategory: item.productCategory || null,
      ducats: typeof item.ducats === "number" ? item.ducats : null,
      components: (item.components || []).map((c: ComponentEntry) => ({
        name: c.name || "",
        uniqueName: c.uniqueName || "",
        tradable: typeof c.tradable === "boolean" ? c.tradable : undefined,
        itemCount: c.itemCount || 1,
        drops: (c.drops || []).map((d: DropEntry) => ({
          location: d.location || "",
          type: d.type || "",
          chance: d.chance || 0,
          rarity: d.rarity || "",
        })),
      })),
      drops: (item.drops || []).slice(0, 20).map((d: DropEntry) => ({
        location: d.location || "",
        type: d.type || "",
        chance: d.chance || 0,
        rarity: d.rarity || "",
      })),
      wikiaUrl: item.wikiaUrl || null,
      ...(recipesByResultType[key] ? { recipe: recipesByResultType[key] } : {}),
    };
  }
  return lookup;
}

function cloneDropEntry(drop: DropEntry): DropEntry {
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
