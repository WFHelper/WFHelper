// Mirrors the arbi.guide analyzer tile maps (images + alignment catalog) into
// .icon-mirror/public/arbi-minimaps/ and src/data/arbiMinimaps.json. The images
// and their calibration matrices are arbi.guide's work (remesis), credited in
// the Arbitrations tab and in Settings > About.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outDir = path.join(repoRoot, ".icon-mirror", "public", "arbi-minimaps");
const jsonPath = path.join(repoRoot, "src", "data", "arbiMinimaps.json");

const ANALYZER_URL = "https://arbi.guide/analyzer/";
const USER_AGENT = "WFHelper icon mirror (+https://wfhelper.com)";
const timeoutMs = Math.max(5000, Number(process.env.ICON_MIRROR_TIMEOUT_MS) || 30000);

// Only bare file names are ever written; anything else is a poisoned catalog.
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9+~._-]*\.webp$/;

async function fetchWithTimeout(url, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function parseCatalogSource(source) {
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("catalog has no object literal");
  const parsed = JSON.parse(source.slice(start, end + 1));
  if (!parsed || typeof parsed.catalog !== "object" || typeof parsed.nodes !== "object") {
    throw new Error("catalog is missing catalog/nodes");
  }
  return parsed;
}

function fileNameOf(src) {
  const withoutQuery = String(src || "").split("?")[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
}

// levelPaths is arbi.guide's provenance, unused by us.
function catalogEntryOf(entry, file) {
  const { levelPaths: _levelPaths, ...kept } = entry;
  return { ...kept, src: file };
}

const analyzerHtml = await fetchText(ANALYZER_URL);
const scriptRef = /["']\.\/minimaps\/(catalog-[A-Za-z0-9._-]+\.js)["']/.exec(analyzerHtml);
if (!scriptRef) {
  console.error("could not find ./minimaps/catalog-*.js in the analyzer page");
  process.exit(1);
}
const catalogUrl = new URL(`./minimaps/${scriptRef[1]}`, ANALYZER_URL).href;
const parsed = parseCatalogSource(await fetchText(catalogUrl));

fs.mkdirSync(outDir, { recursive: true });

let downloaded = 0;
let skipped = 0;
const failures = [];
const catalog = {};

for (const [key, entry] of Object.entries(parsed.catalog)) {
  const file = fileNameOf(entry.src);
  if (!SAFE_FILE.test(file)) {
    failures.push({ key, reason: `unsafe file name "${file}"` });
    continue;
  }
  // src is written relative to the analyzer page, not to the catalog script.
  const imageUrl = new URL(entry.src, ANALYZER_URL).href;
  const dest = path.join(outDir, file);
  try {
    const local = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
    if (local > 0) {
      const head = await fetchWithTimeout(imageUrl, "HEAD");
      if (head.ok && Number(head.headers.get("content-length")) === local) {
        skipped++;
        catalog[key] = catalogEntryOf(entry, file);
        continue;
      }
    }
    const res = await fetchWithTimeout(imageUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1000) throw new Error(`suspiciously small (${bytes.length}B)`);
    // A miss on Pages returns the SPA shell with HTTP 200, so check the magic.
    if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
      throw new Error("response is not a webp");
    }
    fs.writeFileSync(dest, bytes);
    downloaded++;
  } catch (err) {
    failures.push({ key, reason: String(err?.message || err) });
    continue;
  }
  catalog[key] = catalogEntryOf(entry, file);
}

const nodes = {};
for (const [node, keys] of Object.entries(parsed.nodes)) {
  const usable = (Array.isArray(keys) ? keys : []).filter((key) => key in catalog);
  if (usable.length) nodes[node] = usable;
}

// Formatted here so regenerating never leaves a format:check diff behind.
const payload = JSON.stringify({
  source: "arbi.guide (remesis)",
  fetchedAt: new Date().toISOString(),
  version: parsed.version ?? null,
  catalog,
  nodes,
});
const prettierConfig = (await resolveConfig(jsonPath)) || {};
fs.writeFileSync(
  jsonPath,
  await format(payload, { ...prettierConfig, parser: "json", filepath: jsonPath }),
  "utf-8",
);

console.log(
  `arbi minimaps: ${downloaded} downloaded, ${skipped} already present, ${failures.length} failed`,
);
console.log(`catalog: ${Object.keys(catalog).length} layouts, ${Object.keys(nodes).length} nodes`);
for (const failure of failures) console.warn(`  ${failure.key}: ${failure.reason}`);
if (failures.length) process.exit(1);
