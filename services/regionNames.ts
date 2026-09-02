// Shared node/mission/faction naming from DE's own region table and language
// dictionaries. Used by the arbitration schedule and the world-state parser.

import fs from "node:fs";
import path from "node:path";

import { normalizeErrorMessage } from "../config/shared/errors";
import { titleCase } from "../config/shared/textNormalize";
import { DEFAULT_GAME_LOCALE, getGameLocale } from "./gameLocale";
import { withScope } from "./logger";

const log = withScope("regionNames");

/** Only Infestation and Orokin differ from the FC_ tail fallback; in game they
 *  read as Infested and Corrupted. The rest are spelled out for the whole set. */
const FACTION_LABELS: Record<string, string> = {
  FC_GRINEER: "Grineer",
  FC_CORPUS: "Corpus",
  FC_INFESTATION: "Infested",
  FC_OROKIN: "Corrupted",
  FC_SENTIENT: "Sentient",
  FC_NARMER: "Narmer",
};

type RegionEntry = {
  name?: unknown;
  systemName?: unknown;
  missionName?: unknown;
  missionType?: unknown;
  faction?: unknown;
  minEnemyLevel?: unknown;
  maxEnemyLevel?: unknown;
};

export interface RegionTranslation {
  regions: Record<string, RegionEntry>;
  dict: Record<string, string>;
}

let _translation: RegionTranslation | null = null;
const _localeDicts = new Map<string, Record<string, string>>();

/** DE region table plus the English dictionary; loaded once per process. */
export function loadRegionTranslation(): RegionTranslation {
  if (_translation) return _translation;
  try {
    const pep = require("warframe-public-export-plus");
    if (pep?.ExportRegions && pep?.dict_en) {
      _translation = {
        regions: pep.ExportRegions as Record<string, RegionEntry>,
        dict: pep.dict_en as Record<string, string>,
      };
      return _translation;
    }
  } catch (err) {
    log.warn("region data package export failed:", normalizeErrorMessage(err));
  }

  try {
    const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
    _translation = {
      regions: JSON.parse(fs.readFileSync(path.join(pkgDir, "ExportRegions.json"), "utf8")),
      dict: JSON.parse(fs.readFileSync(path.join(pkgDir, "dict.en.json"), "utf8")),
    };
    return _translation;
  } catch (err) {
    log.warn("region data disk fallback failed:", normalizeErrorMessage(err));
  }

  _translation = { regions: {}, dict: {} };
  return _translation;
}

function loadLocaleDict(code: string): Record<string, string> {
  const cached = _localeDicts.get(code);
  if (cached) return cached;

  let dict: Record<string, string> = {};
  try {
    const pep = require("warframe-public-export-plus");
    const fromPackage = pep?.[`dict_${code}`];
    if (fromPackage && typeof fromPackage === "object") {
      dict = fromPackage as Record<string, string>;
    }
  } catch (err) {
    log.warn(`dict ${code} package export failed:`, normalizeErrorMessage(err));
  }

  if (Object.keys(dict).length === 0) {
    try {
      const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
      dict = JSON.parse(fs.readFileSync(path.join(pkgDir, `dict.${code}.json`), "utf8"));
    } catch (err) {
      log.warn(`dict ${code} unavailable, using English:`, normalizeErrorMessage(err));
    }
  }

  _localeDicts.set(code, dict);
  return dict;
}

/** Dictionary lookup; a plain (non key) string passes through unchanged. */
export function resolveDict(dict: Record<string, string>, value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("/")) return value;
  return dict[value] || null;
}

/** Same lookup in the player's game language, with English filling every hole. */
export function localizedDictValue(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("/")) return value;
  const locale = getGameLocale();
  if (locale !== DEFAULT_GAME_LOCALE) {
    const localized = loadLocaleDict(locale)[value];
    if (localized) return localized;
  }
  return loadRegionTranslation().dict[value] || null;
}

/** "Pacific (Earth)", or the raw id when DE has no entry for the node. */
export function nodeLabel(translation: RegionTranslation, nodeId: string): string {
  if (!nodeId) return "Unknown";
  const region = translation.regions[nodeId];
  const nodeName = resolveDict(translation.dict, region?.name) || nodeId;
  const systemName = resolveDict(translation.dict, region?.systemName) || "";
  return systemName ? `${nodeName} (${systemName})` : nodeName;
}

export function missionLabel(
  translation: RegionTranslation,
  region: RegionEntry | undefined,
): string {
  // Per-node mission name from DE's own data (localization dict values are
  // uppercase, e.g. "INFESTED SALVAGE"); truer than a hand-kept MT_ map.
  const resolved = resolveDict(translation.dict, region?.missionName);
  if (resolved) return titleCase(resolved);
  const mt = typeof region?.missionType === "string" ? region.missionType : "";
  if (mt.startsWith("MT_")) return titleCase(mt.slice(3).replace(/_/g, " "));
  return "Unknown";
}

export function factionLabel(faction: unknown): string {
  const fc = typeof faction === "string" ? faction : "";
  if (FACTION_LABELS[fc]) return FACTION_LABELS[fc];
  if (fc.startsWith("FC_")) return titleCase(fc.slice(3).replace(/_/g, " "));
  return "Unknown";
}
