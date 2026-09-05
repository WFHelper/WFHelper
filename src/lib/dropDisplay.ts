/** Shared rendering of a drop row's rarity and chance, so the Wiki table, the
 *  enemy panel and the acquisition list stay in one vocabulary. */

const RARITY_COLOUR: Record<string, string> = {
  Common: "var(--rarity-common)",
  Uncommon: "var(--rarity-uncommon)",
  Rare: "var(--rarity-rare)",
  // Only relic and bounty tables spell this one, and it shares the rare colour.
  Legendary: "var(--rarity-rare)",
};

/** Muted for anything the drop tables spell in a way this list does not know. */
export function dropRarityColour(rarity: string): string {
  return RARITY_COLOUR[rarity] ?? "var(--text-muted)";
}

/** Drop chances carry up to two decimals upstream; trailing zeroes are dropped. */
export function formatDropChance(chance: number): string {
  if (!Number.isFinite(chance)) return "";
  return `${Math.round(chance * 100) / 100}%`;
}
