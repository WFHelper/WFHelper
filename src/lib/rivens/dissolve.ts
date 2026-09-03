import { rivenDissolveEndo } from "../../../config/shared/rivenEndo.js";

/** Rerolls past this make a mediocre roll worth more as endo than as a trade. */
const DISSOLVE_REROLL_HINT = 5;
/** A maxed card is worth this much on rank alone, so rank counts as well. */
const DISSOLVE_ENDO_HINT = 3000;

interface DissolveCandidate {
  attributeGrade: string;
  masteryReq: number;
  currentRank: number;
  rerolls: number;
}

/** Endo the riven dissolves for, but only when its attributes are weak enough
 *  for dissolving to be worth suggesting. Null means show nothing. */
export function rivenDissolveHint(riven: DissolveCandidate): number | null {
  if (riven.attributeGrade !== "Bad" && riven.attributeGrade !== "OK") return null;
  const endo = rivenDissolveEndo(riven.masteryReq, riven.currentRank, riven.rerolls);
  if (riven.rerolls < DISSOLVE_REROLL_HINT && endo < DISSOLVE_ENDO_HINT) return null;
  return endo;
}
