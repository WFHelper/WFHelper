import { masteryXpToRank } from "../../config/shared/masteryXp.js";
import type { Translator } from "./i18n.js";

/**
 * Rank the account already holds: the profile rank, or the rank its XP total
 * covers when a mastery test is still pending.
 */
function bankedMasteryRank(currentRank: number, totalXp: number): number {
  return Math.max(currentRank, masteryXpToRank(totalXp));
}

/** Rank the Easy Mastery items would reach, or null when they stay inside a rank
 *  the account already holds. */
export function easyMasteryPotentialRank(
  currentRank: number | null,
  totalXp: number | null,
  easyXp: number,
): number | null {
  if (currentRank == null || totalXp == null) return null;
  if (!Number.isFinite(totalXp) || !Number.isFinite(easyXp)) return null;
  const projected = masteryXpToRank(totalXp + Math.max(0, easyXp));
  return projected > bankedMasteryRank(currentRank, totalXp) ? projected : null;
}

// The banked line stands on its own: with an empty Foundry the account still
// wants to know how far its XP reaches (Discord, Silber: the line vanished).
export function masteryProjectionSubtext(
  t: Translator,
  currentRank: number,
  totalXp: number,
  readyXp: number,
  locale: string,
): string | null {
  if (!Number.isFinite(totalXp)) return null;

  const bankedRank = bankedMasteryRank(currentRank, totalXp);
  const banked =
    bankedRank > currentRank ? t("mastery.projection.banked", { rank: bankedRank }) : null;
  if (!Number.isFinite(readyXp) || readyXp <= 0) return banked;

  const projectedRank = Math.max(bankedRank, masteryXpToRank(totalXp + readyXp));
  const formattedReadyXp = readyXp.toLocaleString(locale);

  if (projectedRank > bankedRank) {
    const raised = t("mastery.projection.foundryRaises", {
      rank: projectedRank,
      xp: formattedReadyXp,
    });
    return banked ? `${banked} · ${raised}` : raised;
  }

  const ready = t("mastery.projection.readyInFoundry", { xp: formattedReadyXp });
  return banked ? `${banked} · ${ready}` : ready;
}
