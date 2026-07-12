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
const indexPath = path.join(publicRoot, "index.html");
const sourceListPath = path.join(outputRoot, "source-urls.txt");
const headersPath = path.join(publicRoot, "_headers");

// The app rewrites icons to the mirror at runtime. Manifest generation needs
// the original upstream URLs so the hash paths match the downloaded files.
process.env.WFHELPER_ICON_MIRROR_DISABLED = "1";

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

const exportImages = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "node_modules", "warframe-public-export-plus", "ExportImages.json"),
    "utf-8",
  ),
);

// texture path -> contentHash; bundled package seed + DE live-manifest top-up (bundled lags patches)
const fallbackHashByPath = new Map(
  Object.entries(exportImages)
    .filter(([, value]) => value?.contentHash)
    .map(([texturePath, value]) => [texturePath, value.contentHash]),
);

// browse.wf lags DE's CDN on freshly added textures; give the downloader DE's copy to fall back to
function toFallbackUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  if (parsed.hostname !== "browse.wf") return null;
  const contentHash = fallbackHashByPath.get(parsed.pathname);
  return contentHash ? `https://content.warframe.com/PublicExport${parsed.pathname}!${contentHash}` : null;
}

function addUrl(urls, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return;
  urls.add(trimmed);
}

// items newer than the bundled packages only have icons in DE's live overlay
async function loadOverlayFromDE() {
  const publicExport = requireCompiled("services/publicExportSource.js");
  await publicExport.refreshOverlayFromDE();
  const overlay = publicExport.getOverlay();
  if (!overlay) {
    console.warn("[icon-mirror] DE overlay unavailable - manifest limited to bundled packages");
    return;
  }
  for (const textureLocation of Object.values(overlay.images || {})) {
    const [texturePath, contentHash] = textureLocation.split("!");
    if (texturePath && contentHash) fallbackHashByPath.set(texturePath, contentHash);
  }
  const total = Object.values(overlay.exports).reduce(
    (count, items) => count + Object.keys(items || {}).length,
    0,
  );
  console.log(
    `[icon-mirror] DE overlay loaded (${total} items, ${Object.keys(overlay.images || {}).length} image mappings)`,
  );
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
      "/*",
      "  Access-Control-Allow-Origin: *",
      "  Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "  Referrer-Policy: no-referrer",
      "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "",
      "/icons/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "",
      "/manifest.json",
      "  Cache-Control: public, max-age=300",
      "",
    ].join("\n"),
  );
}

function writeIndex(manifest) {
  fs.writeFileSync(
    indexPath,
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      "  <title>WFHelper Icon Mirror</title>",
      "  <style>",
      "    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #101418; color: #e8eef5; }",
      "    main { width: min(560px, calc(100vw - 32px)); }",
      "    h1 { margin: 0 0 12px; font-size: 28px; font-weight: 650; }",
      "    p { margin: 0 0 16px; color: #aeb9c6; line-height: 1.5; }",
      "    a { color: #7cc7ff; }",
      "    code { color: #e8eef5; }",
      "  </style>",
      "</head>",
      "<body>",
      "  <main>",
      "    <h1>WFHelper Icon Mirror</h1>",
      `    <p>This static mirror currently serves ${manifest.count} generated icon files for the WFHelper desktop app.</p>`,
      '    <p><a href="/manifest.json">Open manifest.json</a></p>',
      "    <p>Icon files live under <code>/icons/&lt;hash&gt;.&lt;ext&gt;</code>.</p>",
      "  </main>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
}

fs.mkdirSync(publicRoot, { recursive: true });

const urls = new Set();
await loadOverlayFromDE();
collectItemDatabaseUrls(urls);
collectRelicDatabaseUrls(urls);

const entries = [...urls].sort().map((sourceUrl) => {
  const parsed = new URL(sourceUrl);
  const fallbackUrl = toFallbackUrl(sourceUrl);
  return {
    sourceUrl,
    sourceHost: parsed.hostname,
    mirrorPath: toMirrorPath(sourceUrl),
    ...(fallbackUrl ? { fallbackUrl } : {}),
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
writeIndex(manifest);
writeHeaders();

console.log(`[icon-mirror] wrote ${entries.length} icon entries to ${manifestPath}`);
console.log(`[icon-mirror] host counts: ${JSON.stringify(hostCounts)}`);
