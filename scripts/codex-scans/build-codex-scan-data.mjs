// Builds Codex scan data from the Warframe wiki enemy modules (CC BY-SA) and
// DE PublicExport animals, objects and fragments.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseEntries } from "./parseEnemyModule.mjs";

const FACTIONS = [
  "grineer",
  "corpus",
  "infestation",
  "orokin",
  "sentient",
  "stalker",
  "narmer",
  "themurmur",
  "techrot",
  "scaldra",
  "anarchs",
  "unaffiliated",
];

const OUT_FILE = path.join(process.cwd(), "src", "data", "codexScanRequirements.json");

// The wiki answers a spoofed browser UA with a 403 challenge page, so keep this
// one; a transient 403 still happens under load and is worth a single retry.
async function fetchWikiRaw(page) {
  const url = `https://wiki.warframe.com/w/${page}?action=raw`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "WFHelper data build" } });
    if (res.ok) return res.text();
    if (attempt === 0 && (res.status === 403 || res.status === 429)) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }
    throw new Error(`${page}: HTTP ${res.status} - refusing to overwrite`);
  }
  throw new Error(`${page}: unreachable - refusing to overwrite`);
}

const all = new Map();
for (const faction of FACTIONS) {
  const entries = parseEntries(await fetchWikiRaw(`Module:Enemies/data/${faction}`), faction);
  if (entries.length === 0)
    throw new Error(`${faction}: no entries parsed - refusing to overwrite`);
  for (const entry of entries) {
    if (!all.has(entry.internal)) all.set(entry.internal, entry);
  }
  console.log(`${faction}: ${entries.length} entries`);
}

if (all.size < 300) {
  console.error(`only ${all.size} entries parsed - refusing to overwrite`);
  process.exit(1);
}

// The wiki module points a few entries at DE's red pixel codex sprites; the
// wiki's own pages display these renders instead.
const WIKI_IMAGE_OVERRIDES = {
  "Decaying Battalyst": "SentientTrooper.png",
  "Decaying Conculyst": "SentientMeleeTrooper.png",
  "Kavor Defector": "KavorDefector.png",
  "Senta Turret": "FortressAutoTurret.png",
};
for (const entry of all.values()) {
  if (entry.image && (entry.image === "?" || !entry.image.includes("."))) entry.image = null;
  const override = WIKI_IMAGE_OVERRIDES[entry.name];
  if (override) entry.image = override;
}

// Conservation animals, codex objects, lore fragments and songs are absent
// from the wiki enemy modules but present in profile scan stats; DE's export
// carries their names, icons and (for codex sections) required scan counts.
const pepDir = path.join(process.cwd(), "node_modules", "warframe-public-export-plus");
const readPep = (file) => JSON.parse(fs.readFileSync(path.join(pepDir, file), "utf-8"));
const dictEn = readPep("dict.en.json");

// DE's own agent-to-avatar mapping. A wiki InternalName is an Agent path but a
// profile records scans against Avatar paths, and guessing the pairing by suffix
// merged distinct enemies (Corrupted Heavy Gunner is OrokinMinigunBombard on the
// wiki and OrokinHeavyFemaleAvatar in a profile).
const enemies = readPep("ExportEnemies.json");

const LEADER_PATH_RE = /(AvatarLeader|LeaderAvatar|Leader)$/i;
const baseAvatarPath = (avatarPath) =>
  avatarPath.replace(/AvatarLeader$/i, "Avatar").replace(/LeaderAvatar$/i, "Avatar");

// null marks a path two entries claim, which is unusable rather than a coin flip.
const avatarOwners = new Map();
function claimAvatar(avatarPath, internal, eximus) {
  const key = avatarPath.toLowerCase();
  const seen = avatarOwners.get(key);
  if (seen === undefined) avatarOwners.set(key, { internal, eximus });
  else if (seen && seen.internal !== internal) avatarOwners.set(key, null);
}
for (const internal of all.keys()) {
  const types = enemies.agents[internal]?.avatarTypes;
  if (!types) {
    if (enemies.avatars[internal]) claimAvatar(internal, internal, false);
    continue;
  }
  for (const [kind, avatarPath] of Object.entries(types)) {
    // RARE is a spawn variant rather than its own codex entry, so its own path
    // decides which of the two rows it feeds.
    const eximus = kind === "EXIMUS" || (kind === "RARE" && /Leader/i.test(avatarPath));
    claimAvatar(avatarPath, internal, eximus);
  }
}

// DE writes 5 when an avatar states no requirement: a non-5 value agrees with the
// wiki 153 times against 7, while 5 agrees 303 and contradicts 297. Both in-game
// checks of a 5 (Rana Del, Terra Elite Embattor MOA) read 3.
const PLACEHOLDER_SCANS = 5;
function statedScans(avatarPath) {
  const req = enemies.avatars[avatarPath]?.codexScansRequired;
  return Number.isFinite(req) && req > 0 && req !== PLACEHOLDER_SCANS ? req : null;
}
// The wiki lists no Eximus entries at all, and they do not inherit the base count
// (Arid Butcher needs 20 scans, its Eximus 3), so only the export can state them.
for (const entry of all.values()) {
  const eximusPath = enemies.agents[entry.internal]?.avatarTypes?.EXIMUS;
  if (eximusPath) entry.eximusScans = statedScans(eximusPath);
}

const EE_FACTION_KEYS = {
  anarch: "anarchs",
  infested: "infestation",
  mitw: "themurmur",
  narmerveil: "narmer",
  "orokin empire": "orokin",
  orokinempire: "orokin",
};
function factionKey(faction) {
  const raw = String(faction || "").toLowerCase();
  const mapped = EE_FACTION_KEYS[raw] || raw;
  return FACTIONS.includes(mapped) ? mapped : "unaffiliated";
}
const MIRROR_BASE = "https://assets.wfhelper.com";

// Matches services/itemDatabase.ts toIconMirrorUrl: same source URL, same hash.
function deIconMirror(iconPath) {
  if (typeof iconPath !== "string" || !iconPath.startsWith("/")) return null;
  const sourceUrl = `https://browse.wf${iconPath}`;
  const rawExt = path.extname(iconPath).toLowerCase();
  const ext = rawExt && rawExt.length <= 8 ? rawExt : ".png";
  const hash = crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 24);
  return { sourceUrl, mirrorUrl: `${MIRROR_BASE}/icons/${hash}${ext}` };
}

// Lore fragment pages pair each Codex display name with its wiki artwork.
const FRAGMENT_PAGES = [
  "Fragments/Cephalon",
  "Fragments/Fish",
  "Fragments/Glass",
  "Fragments/Ghoul",
  "Fragments/Revenant",
  "Fragments/Solaris United",
  "Fragments/Partnership",
  "Fragments/The Tenets",
  // Fragments/Duviri is absent on purpose: every block there has an empty
  // image field, so the parse below yields nothing and refuses to overwrite.
  "Fragments/Albrecht",
  "Fragments/Isleweaver",
];
// Solaris filenames carry the vendor omitted from the fragment field.
const SOLARIS_VENDORS = {
  Eudico: "Eudico",
  Legs: "Legs",
  LittleDuck: "Little Duck's",
  RudeZuud: "Rude Zuud's",
  Smokefinger: "Smokefinger's",
  TheBusiness: "The Business'",
  Ticker: "Ticker's",
};
const normFragmentName = (name) =>
  name.toLowerCase().replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const fragmentImageByName = new Map();
for (const page of FRAGMENT_PAGES) {
  const text = await fetchWikiRaw(encodeURI(page));
  let parsedImages = 0;
  for (const block of text.split(/\{\{Fragments\s*\n/).slice(1)) {
    let name = block.match(/(?:^|\|)\s*fragment\s*=\s*([^\n|]+)/)?.[1]?.trim();
    const image = block.match(/(?:^|\|)\s*image\s*=\s*([^\n|]+)/)?.[1]?.trim();
    if (!image) continue;
    const solaris = /^Frag_SU(\w+)_0*(\d+)\.png$/.exec(image);
    if (solaris && SOLARIS_VENDORS[solaris[1]]) {
      name = `${SOLARIS_VENDORS[solaris[1]]} Mem Fragment ${solaris[2]}/5`;
    }
    if (!name) continue;
    parsedImages += 1;
    const key = normFragmentName(name);
    if (!fragmentImageByName.has(key)) fragmentImageByName.set(key, image);
  }
  if (parsedImages === 0)
    throw new Error(`${page}: no fragment artwork parsed - refusing to overwrite`);
}
console.log(`wiki fragment artwork: ${fragmentImageByName.size} names`);

// Albrecht entries carry a set prefix the wiki page titles drop.
function wikiFragmentImage(name) {
  if (!name) return null;
  const key = normFragmentName(name);
  const direct = fragmentImageByName.get(key);
  if (direct) return direct;
  const dash = key.indexOf(" - ");
  return dash >= 0 ? (fragmentImageByName.get(key.slice(dash + 3)) ?? null) : null;
}

const extras = new Map();
const codexIconSources = new Set();
const fragmentImagesUsed = new Set();
function resolveName(rawName) {
  // Some dict entries wrap onto two lines (kuva lich names carry a CRLF).
  return typeof rawName === "string" && rawName.startsWith("/")
    ? (dictEn[rawName] || "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim() || null
    : rawName || null;
}

function addExtra(key, rawName, icon, faction, reqScans, wikiImage = null, eximusScans = null) {
  if (all.has(key) || extras.has(key)) return;
  const name = resolveName(rawName);
  const resolved = icon ? deIconMirror(icon) : null;
  if (!name && !resolved) return;
  if (resolved) codexIconSources.add(resolved.sourceUrl);
  if (!resolved && wikiImage) fragmentImagesUsed.add(wikiImage);
  extras.set(key, {
    name,
    icon: resolved ? resolved.mirrorUrl : wikiImage,
    faction,
    scans: Number.isFinite(reqScans) && reqScans > 0 ? reqScans : null,
    eximusScans: Number.isFinite(eximusScans) && eximusScans > 0 ? eximusScans : null,
  });
}

for (const [key, animal] of Object.entries(readPep("ExportAnimals.json"))) {
  addExtra(key, animal.name, animal.icon, "wildlife", null);
}
const CODEX_SECTION_FACTION = {
  objects: "objects",
  loreFragments: "lore",
  songs: "lore",
  fighterFrames: "objects",
};
// Matching ship decorations fill icons omitted from Codex fragment records.
const resourceIconByName = new Map();
for (const item of Object.values(readPep("ExportResources.json"))) {
  if (!item.icon) continue;
  const name = resolveName(item.name);
  if (!name) continue;
  resourceIconByName.set(name, resourceIconByName.has(name) ? null : item.icon);
}
for (const [section, sectionEntries] of Object.entries(readPep("ExportCodex.json"))) {
  const faction = CODEX_SECTION_FACTION[section] || "objects";
  for (const [key, item] of Object.entries(sectionEntries || {})) {
    const icon = item.icon ?? resourceIconByName.get(resolveName(item.name)) ?? null;
    const wikiImage =
      section === "loreFragments" && !icon ? wikiFragmentImage(resolveName(item.name)) : null;
    addExtra(key, item.name, icon, faction, item.reqScans, wikiImage);
  }
}

// DE records a plant scan against the world path but ships its name and icon on
// the pickup item, and the two disagree on word order, so the pairing is spelled
// out. No export or wiki source states a required scan count for plants.
const PLANT_ITEM_BY_SCAN_NAME = {
  DayCommonPlant: "CommonDayPlantItem",
  DayRarePlant: "RareDayPlantItem",
  DayUnCommonPlant: "UnCommonDayPlantItem",
  GftPlantRuksClawMaturePlant: "GftPlantRuksClawMaturePlantItem",
  MossGroundCoverAPlant: "MossGroundCoverAPlantItem",
  NightCommonPlant: "CommonNightPlantItem",
  NightRarePlant: "RareNightPlantItem",
  NightUnCommonPlant: "UnCommonNightPlantItem",
  WildGingerBPlant: "WildGingerBPlantItem",
  ZenCobraLotusPlant: "ZenCobraLotusPlantItem",
  ZenPitcherPlant: "ZenPitcherPlantItem",
};
const plantResources = readPep("ExportResources.json");
for (const [scanName, itemName] of Object.entries(PLANT_ITEM_BY_SCAN_NAME)) {
  const item = plantResources[`/Lotus/Types/Items/Plants/MiscItems/${itemName}`];
  if (!item) {
    console.warn(`[codex] plant item missing from ExportResources: ${itemName}`);
    continue;
  }
  addExtra(`/Lotus/Types/Items/Plants/${scanName}`, item.name, item.icon, "objects", null);
}

// Enemy avatars no wiki entry reaches. One whose display name belongs to exactly
// one wiki row is that row under another path (an ally, decoy, Shadow or Narmer
// variant); the rest are entries the wiki modules never covered.
const wikiByName = new Map();
for (const entry of all.values()) {
  const key = entry.name.toLowerCase();
  wikiByName.set(key, wikiByName.has(key) ? null : entry.internal);
}
let bridgedByName = 0;
const orphans = [];
for (const [avatarPath, avatar] of Object.entries(enemies.avatars)) {
  if (avatarOwners.has(avatarPath.toLowerCase())) continue;
  const name = resolveName(avatar.name);
  if (!name) continue;
  const twin = wikiByName.get(name.toLowerCase());
  if (twin) {
    claimAvatar(avatarPath, twin, LEADER_PATH_RE.test(avatarPath));
    bridgedByName += 1;
    continue;
  }
  orphans.push([avatarPath, avatar]);
}

// An Eximus avatar is not its own codex entry, so it contributes a count to the
// base rather than a second row under the same display name.
const orphanEximus = new Map();
for (const [avatarPath] of orphans) {
  if (!LEADER_PATH_RE.test(avatarPath)) continue;
  orphanEximus.set(baseAvatarPath(avatarPath).toLowerCase(), avatarPath);
}
let orphanEnemies = 0;
for (const [avatarPath, avatar] of orphans) {
  const leader = LEADER_PATH_RE.test(avatarPath);
  // An Eximus-only orphan still needs the base row its scans hang from.
  const key = leader ? baseAvatarPath(avatarPath) : avatarPath;
  if (leader && enemies.avatars[key]) continue;
  // The in-game codex draws every entry, so an avatar with no art is a spawn
  // helper rather than something the codex lists.
  if (!avatar.icon) continue;
  const eximusPath = leader ? avatarPath : orphanEximus.get(avatarPath.toLowerCase());
  addExtra(
    key,
    avatar.name,
    avatar.icon,
    factionKey(avatar.faction),
    leader ? null : statedScans(avatarPath),
    null,
    eximusPath ? statedScans(eximusPath) : null,
  );
  orphanEnemies += 1;
}
console.log(
  `enemy avatars: ${avatarOwners.size} mapped (${bridgedByName} by name), ${orphanEnemies} new entries`,
);

const sorted = [...all.values()].sort((a, b) => a.internal.localeCompare(b.internal));
// Plain JSON keeps the 15k-line table out of language stats and code review;
// src/data/codexScanRequirements.ts is the hand-written typed shim over it.
const requirements = {};
for (const e of sorted) {
  requirements[e.internal] = {
    name: e.name,
    scans: e.scans,
    faction: e.faction,
    ...(e.image ? { image: e.image } : {}),
    ...(e.eximusScans ? { eximusScans: e.eximusScans } : {}),
    // Spawn context for the enemy detail panel; the wiki omits these per entry.
    ...(e.planets ? { planets: e.planets } : {}),
    ...(e.tileSets ? { tileSets: e.tileSets } : {}),
    ...(e.missions ? { missions: e.missions } : {}),
    ...(e.type ? { type: e.type } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.link && e.link !== e.name ? { link: e.link } : {}),
    ...(e.baseLevel ? { baseLevel: e.baseLevel } : {}),
  };
}

const avatars = {};
for (const [avatarPath, owner] of [...avatarOwners.entries()]
  .filter(([, owner]) => owner !== null)
  .sort(([a], [b]) => a.localeCompare(b))) {
  avatars[avatarPath] = { key: owner.internal, ...(owner.eximus ? { eximus: true } : {}) };
}

const extraInfo = {};
for (const [key, extra] of [...extras.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  extraInfo[key] = {
    ...(extra.name ? { name: extra.name } : {}),
    ...(extra.icon ? { icon: extra.icon } : {}),
    faction: extra.faction,
    ...(extra.scans ? { scans: extra.scans } : {}),
    ...(extra.eximusScans ? { eximusScans: extra.eximusScans } : {}),
  };
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify({ requirements, avatars, extraInfo }, null, 2) + "\n");

// Sidecars for the icon mirror: wiki image filenames the table references, and
// the DE texture source URLs the extras need mirrored.
const images = [
  ...new Set([...sorted.map((e) => e.image), ...fragmentImagesUsed].filter(Boolean)),
].sort();
const IMAGES_FILE = path.join(process.cwd(), "scripts", "icon-mirror", "enemy-images.json");
fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2) + "\n");
const CODEX_ICONS_FILE = path.join(process.cwd(), "scripts", "icon-mirror", "codex-icon-urls.json");
fs.writeFileSync(CODEX_ICONS_FILE, JSON.stringify([...codexIconSources].sort(), null, 2) + "\n");
const withField = (field) => sorted.filter((e) => e[field]).length;
console.log(
  `wrote ${OUT_FILE} with ${sorted.length} enemies + ${extras.size} extras, ` +
    `${Object.keys(avatars).length} avatar paths, ${images.length} wiki images, ` +
    `${codexIconSources.size} DE icon sources`,
);
console.log(
  `spawn context: ${withField("planets")} planets, ${withField("tileSets")} tilesets, ` +
    `${withField("missions")} missions, ${withField("description")} descriptions`,
);
