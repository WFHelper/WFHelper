// Parser for a wiki Module:Enemies/data/<faction> Lua page (CC BY-SA). Split out
// of the build script so a fixture test can exercise it without network access.

/** Reads a Lua `Field = { "a", "b" }` list; returns null when absent or empty. */
function stringList(block, field) {
  const match = new RegExp(`\\b${field}\\s*=\\s*\\{([^}]*)\\}`).exec(block);
  if (!match) return null;
  const values = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1].trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

function text(block, field) {
  const value = new RegExp(`\\b${field}\\s*=\\s*"([^"]*)"`).exec(block)?.[1]?.trim();
  return value || null;
}

// Each enemy's General block carries InternalName, Name and Scans in one brace
// group; field order varies, so pluck fields independently per block. BaseLevel
// sits in the sibling Stats block, still inside the slice this split produces.
export function parseEntries(lua, faction) {
  const entries = [];
  const blocks = lua.split(/General\s*=\s*\{/).slice(1);
  for (const block of blocks) {
    const internal = /InternalName\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const name = /\bName\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const scans = /\bScans\s*=\s*(\d+)/.exec(block)?.[1];
    const image = /\bImage\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null;
    if (!internal || !name || !scans) continue;
    const baseLevel = /\bBaseLevel\s*=\s*(\d+)/.exec(block)?.[1];
    entries.push({
      internal,
      name,
      scans: Number(scans),
      faction,
      image,
      planets: stringList(block, "Planets"),
      tileSets: stringList(block, "TileSets"),
      missions: stringList(block, "Missions"),
      type: text(block, "Type"),
      description: text(block, "Description"),
      link: text(block, "Link"),
      baseLevel: baseLevel ? Number(baseLevel) : null,
    });
  }
  return entries;
}
