// Riven dissolve endo: 100*(MR-8) + floor(22.5 * 2^rank) + 200*rerolls - 7.
// wiki.warframe.com documents no formula (checked 2026-08-31; Riven_Mods and
// Endo cover fusion cost only); the source is the Fandom mirror, which the
// community calculators agree with: https://warframe.fandom.com/wiki/Riven_Mods

const RIVEN_ENDO_PER_MASTERY_RANK = 100;
const RIVEN_ENDO_MASTERY_BASE = 8;
const RIVEN_ENDO_RANK_FACTOR = 22.5;
const RIVEN_ENDO_PER_REROLL = 200;
const RIVEN_ENDO_CONSTANT = -7;

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}

/** Endo a riven dissolves for. Inputs are clamped to the ranges the game can
 *  produce so a hostile auction payload cannot drive the result anywhere. */
export function rivenDissolveEndo(masteryRank: number, modRank: number, rerolls: number): number {
  const mr = clampInt(masteryRank, 8, 16);
  const rank = clampInt(modRank, 0, 8);
  const rolls = clampInt(rerolls, 0, 10_000);
  const total =
    RIVEN_ENDO_PER_MASTERY_RANK * (mr - RIVEN_ENDO_MASTERY_BASE) +
    Math.floor(RIVEN_ENDO_RANK_FACTOR * 2 ** rank) +
    RIVEN_ENDO_PER_REROLL * rolls +
    RIVEN_ENDO_CONSTANT;
  return Math.max(0, total);
}

/** Endo per platinum asked. Zero-or-less prices have no ratio rather than an
 *  infinite one, so a free listing can never satisfy a minimum. */
export function rivenEndoPerPlat(
  masteryRank: number,
  modRank: number,
  rerolls: number,
  platinum: number,
): number | null {
  if (!Number.isFinite(platinum) || platinum <= 0) return null;
  return rivenDissolveEndo(masteryRank, modRank, rerolls) / platinum;
}
