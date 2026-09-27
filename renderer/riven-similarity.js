// Riven stats that share one attribute under several display/OCR/locTag
// names; compare via this canonical form, never by substring.
/** @type {Record<string, string>} */
const STAT_NAME_CANON = {
  "attack speed": "fire rate",
  "melee damage": "damage",
  "critical chance for slide attack": "slide attack",
  slide: "slide attack",
  recoil: "weapon recoil",
  magazine: "magazine capacity",
  "heavy attack": "heavy attack efficiency",
};

/** @param {string | null | undefined} name */
export function canonicalRivenStatName(name) {
  const n = (name || "").toLowerCase().trim();
  return STAT_NAME_CANON[n] || n;
}

// WFM sends the in-game signed value (zoom -4.4, recoil 4.6) and faction
// damage as a multiplier (0.98), whether the stat is a buff or a curse.
/** @param {{ name?: string | null, value: number }} stat */
export function formatRivenListingStatValue(stat) {
  if (/^Damage Vs /i.test(stat.name || "")) return `x${stat.value.toFixed(2)}`;
  return `${stat.value < 0 ? "−" : "+"}${Math.abs(Math.round(stat.value))}%`;
}

/** @param {string[]} myStatNames @param {Array<{ name?: string | null }>} listingStats
 * @returns {{ pct: number, matchedNames: Set<string> }} */
export function computeRivenStatSimilarity(myStatNames, listingStats) {
  if (!myStatNames.length || !Array.isArray(listingStats) || !listingStats.length) {
    return { pct: 0, matchedNames: new Set() };
  }

  const listingNames = listingStats
    .map((stat) =>
      String(stat.name || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const matchedNames = new Set();
  for (const myName of myStatNames) {
    const match = listingNames.find(
      (name) => name === myName || name.includes(myName) || myName.includes(name),
    );
    if (match) matchedNames.add(match);
  }

  const unionSize = myStatNames.length + listingNames.length - matchedNames.size;
  return {
    pct: unionSize > 0 ? Math.round((matchedNames.size / unionSize) * 100) : 0,
    matchedNames,
  };
}
