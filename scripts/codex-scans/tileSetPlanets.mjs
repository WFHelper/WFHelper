// Derives tileset to star-chart planets from the wiki Module:Missions/data, so an
// enemy the enemy modules give a tileset but no Planets list for still names a place.

// Nodes that are not enemy spawn locations. Hubs matter most: the Pontis Tower
// hub would otherwise put "Uranus Proxima" on the Orokin Tower tileset, and a
// relay only holds enemies during Follie's Hunt, which is its own node type.
const SKIP_TYPES = new Set(["Conclave", "Hub", "Relay", "Solar Rail Junction"]);

// Enemy-module names the mission table spells differently. Murex is absent on
// purpose: no star-chart node uses it, so it stays unmapped rather than guessed.
const TILE_SET_ALIASES = {
  "Kuva Fortress": "Grineer Asteroid Fortress",
  "The Undercroft": "Duviri",
};

const field = (line, name) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(line)?.[1]?.trim() ?? "";

/** Sorted distinct planets per wiki tileset name. MissionDetails writes one node
 *  per line, so a line is a node; a node with no InternalName is not on the star
 *  chart (Phorid Alert sits on a pseudo-planet called "Invasion"). */
export function buildTileSetPlanets(lua) {
  const start = typeof lua === "string" ? lua.indexOf('["MissionDetails"]') : -1;
  if (start < 0) return {};
  const byTileSet = new Map();
  for (const line of lua.slice(start).split(/\r?\n/)) {
    if (!/Tileset\s*=/.test(line)) continue;
    const tileSet = field(line, "Tileset");
    const planet = field(line, "Planet");
    if (!tileSet || !planet || !field(line, "InternalName")) continue;
    if (SKIP_TYPES.has(field(line, "Type"))) continue;
    if (!byTileSet.has(tileSet)) byTileSet.set(tileSet, new Set());
    byTileSet.get(tileSet).add(planet);
  }
  const out = {};
  for (const key of [...byTileSet.keys()].sort((a, b) => a.localeCompare(b))) {
    out[key] = [...byTileSet.get(key)].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/** Narrows the star-chart map to the tilesets the enemy entries name. Names no
 *  node covers come back in `unmapped` instead of being dropped silently. */
export function selectTileSetPlanets(byTileSet, tileSetNames) {
  const planets = {};
  const unmapped = [];
  for (const name of [...new Set(tileSetNames)].sort((a, b) => a.localeCompare(b))) {
    const source = byTileSet[TILE_SET_ALIASES[name] ?? name];
    if (source && source.length > 0) planets[name] = source;
    else unmapped.push(name);
  }
  return { planets, unmapped };
}
