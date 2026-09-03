// Derives per-faction star-chart planets from DE's ExportRegions, so a codex
// entry the wiki gives no spawn context for can still name where to look.

// DE tags every node with an FC_ code. Codes with no codex partition (Tenno,
// Duviri) are skipped rather than pooled into "unaffiliated", which would
// invent a spawn hint out of two unrelated nodes.
const REGION_FACTION_KEYS = {
  FC_GRINEER: "grineer",
  FC_CORPUS: "corpus",
  FC_INFESTATION: "infestation",
  FC_OROKIN: "orokin",
  FC_SENTIENT: "sentient",
  FC_MITW: "themurmur",
  FC_TECHROT: "techrot",
  FC_SCALDRA: "scaldra",
};

// nodeType 0 is a permanent mission node. Relays, junctions, Dormizone and
// conclave are not spawn locations, and the Dark Sectors (nodeType 4) would
// put Infested on nearly every planet, which stops being a useful hint.
const MISSION_NODE_TYPE = 0;

/** Localised system name; a dict path DE ships no translation for is unusable. */
function systemLabel(systemName, dict) {
  if (typeof systemName !== "string" || !systemName.trim()) return null;
  if (!systemName.startsWith("/")) return systemName.trim();
  const label = dict?.[systemName];
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

/** Sorted distinct planet names per codex faction key. */
export function buildFactionPlanets(regions, dict) {
  const byFaction = new Map();
  for (const node of Object.values(regions ?? {})) {
    if (!node || node.nodeType !== MISSION_NODE_TYPE) continue;
    const key = REGION_FACTION_KEYS[node.faction];
    if (!key) continue;
    const planet = systemLabel(node.systemName, dict);
    if (!planet) continue;
    if (!byFaction.has(key)) byFaction.set(key, new Set());
    byFaction.get(key).add(planet);
  }
  const out = {};
  for (const key of [...byFaction.keys()].sort()) {
    out[key] = [...byFaction.get(key)].sort((a, b) => a.localeCompare(b));
  }
  return out;
}
