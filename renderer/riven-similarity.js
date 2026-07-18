/**
 * @param {string[]} myStatNames
 * @param {Array<{ name?: string | null }>} listingStats
 * @returns {{ pct: number, matchedNames: Set<string> }}
 */
export function computeRivenStatSimilarity(myStatNames, listingStats) {
  if (!myStatNames.length || !Array.isArray(listingStats) || !listingStats.length) {
    return { pct: 0, matchedNames: new Set() };
  }

  const listingNames = listingStats
    .map((stat) => String(stat.name || "").trim().toLowerCase())
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
