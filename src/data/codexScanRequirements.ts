// Typed shim over the generated table (scripts/codex-scans/build-codex-scan-data.mjs
// writes the JSON; source wiki.warframe.com Module:Enemies/data/*, CC BY-SA).
import data from "./codexScanRequirements.json";
import type { CodexFactionPlanets, CodexRequirement } from "../../config/shared/codexTypes.js";

export const CODEX_SCAN_REQUIREMENTS = data.requirements as Record<string, CodexRequirement>;

// Lowercased avatar paths a profile records scans against, mapped to the entry
// they credit: ExportEnemies agents[].avatarTypes, agents that are their own
// avatar, and leftover avatars bridged to a wiki row by display name.
export const CODEX_SCAN_AVATARS = data.avatars as Record<string, { key: string; eximus?: true }>;

// Profile-only scans from DE PublicExport, with mirrored DE or wiki art.
export const CODEX_EXTRA_INFO = data.extraInfo as Record<
  string,
  { name?: string; icon?: string; faction: string; scans?: number; eximusScans?: number }
>;

// Star-chart planets per faction, from DE's ExportRegions. Optional so an older
// generated table without the key degrades to no spawn hint rather than a crash.
export const CODEX_FACTION_PLANETS: CodexFactionPlanets =
  (data as { factionPlanets?: CodexFactionPlanets }).factionPlanets ?? {};
