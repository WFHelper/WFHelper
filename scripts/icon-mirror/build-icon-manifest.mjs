import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, "..", "..");
const compiledRoot = path.join(repoRoot, ".electron-build");
const outputRoot = path.join(repoRoot, ".icon-mirror");
const publicRoot = path.join(outputRoot, "public");
const manifestPath = path.join(publicRoot, "manifest.json");
const sourceListPath = path.join(outputRoot, "source-urls.txt");
const headersPath = path.join(publicRoot, "_headers");

function requireCompiled(relativePath) {
  const modulePath = path.join(compiledRoot, relativePath);
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      `Missing compiled module ${modulePath}. Run this via "npm run icons:manifest" so build:main runs first.`,
    );
  }
  return require(modulePath);
}

function toExt(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    return ext && ext.length <= 8 ? ext : ".png";
  } catch {
    return ".png";
  }
}

function toMirrorPath(rawUrl) {
  const hash = crypto.createHash("sha256").update(rawUrl).digest("hex").slice(0, 24);
  return `icons/${hash}${toExt(rawUrl)}`;
}

function addUrl(urls, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return;
  urls.add(trimmed);
}

function collectItemDatabaseUrls(urls) {
  const itemDb = requireCompiled("services/itemDatabase.js");
  itemDb.buildDatabase();
  const lookup = itemDb.getRendererLookup();
  for (const item of Object.values(lookup)) {
    addUrl(urls, item?.imageUrl);
  }
}

function collectRelicDatabaseUrls(urls) {
  const relicService = requireCompiled("services/relicService.js");
  const relicDb = relicService.getRelicDatabase();
  for (const group of Object.values(relicDb.groups || {})) {
    addUrl(urls, group?.imageUrl);
    for (const quality of Object.values(group?.qualities || {})) {
      for (const reward of quality?.rewards || []) {
        addUrl(urls, reward?.imageUrl);
      }
    }
  }
}

function writeHeaders() {
  fs.writeFileSync(
    headersPath,
    [
      "/icons/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "  X-Content-Type-Options: nosniff",
      "",
      "/manifest.json",
      "  Cache-Control: public, max-age=300",
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n"),
  );
}

fs.mkdirSync(publicRoot, { recursive: true });

const urls = new Set();
collectItemDatabaseUrls(urls);
collectRelicDatabaseUrls(urls);

const entries = [...urls].sort().map((sourceUrl) => {
  const parsed = new URL(sourceUrl);
  return {
    sourceUrl,
    sourceHost: parsed.hostname,
    mirrorPath: toMirrorPath(sourceUrl),
  };
});

const hostCounts = entries.reduce((counts, entry) => {
  counts[entry.sourceHost] = (counts[entry.sourceHost] || 0) + 1;
  return counts;
}, {});

const manifest = {
  generatedAt: new Date().toISOString(),
  count: entries.length,
  hostCounts,
  entries,
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(sourceListPath, `${entries.map((entry) => entry.sourceUrl).join("\n")}\n`);
writeHeaders();

console.log(`[icon-mirror] wrote ${entries.length} icon entries to ${manifestPath}`);
console.log(`[icon-mirror] host counts: ${JSON.stringify(hostCounts)}`);
