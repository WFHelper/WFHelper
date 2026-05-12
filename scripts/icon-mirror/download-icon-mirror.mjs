import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outputRoot = path.join(repoRoot, ".icon-mirror");
const publicRoot = path.join(outputRoot, "public");
const manifestPath = path.join(publicRoot, "manifest.json");
const failuresPath = path.join(outputRoot, "download-failures.json");

const concurrency = Math.max(1, Math.min(24, Number(process.env.ICON_MIRROR_CONCURRENCY) || 6));
const timeoutMs = Math.max(5000, Number(process.env.ICON_MIRROR_TIMEOUT_MS) || 30000);
const allowedSourceHosts = new Set(["browse.wf", "cdn.warframestat.us"]);

function readManifest() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}. Run "npm run icons:manifest" first.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function contentTypeToExt(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/png")) return ".png";
  if (normalized.includes("image/jpeg")) return ".jpg";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("image/gif")) return ".gif";
  return null;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "WFHelper icon mirror builder" },
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return { ok: false, reason: "invalid source URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported source protocol ${parsed.protocol || "(none)"}` };
  }
  if (!allowedSourceHosts.has(parsed.hostname)) {
    return { ok: false, reason: `unapproved source host ${parsed.hostname || "(none)"}` };
  }
  return { ok: true, url: parsed.href };
}

async function downloadEntry(entry) {
  const targetPath = path.join(publicRoot, entry.mirrorPath);
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
    return { status: "skipped" };
  }

  const source = validateSourceUrl(entry.sourceUrl);
  if (!source.ok) {
    return { status: "failed", reason: source.reason };
  }

  const response = await fetchWithTimeout(source.url);
  if (!response.ok) {
    return { status: "failed", reason: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    return { status: "failed", reason: `unexpected content-type ${contentType || "(none)"}` };
  }

  const actualExt = contentTypeToExt(contentType);
  if (actualExt && path.extname(targetPath).toLowerCase() !== actualExt) {
    return { status: "failed", reason: `extension/content-type mismatch ${contentType}` };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    return { status: "failed", reason: "empty response" };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, bytes);
  return { status: "downloaded", bytes: bytes.length };
}

async function runPool(entries) {
  const failures = [];
  let nextIndex = 0;
  let downloaded = 0;
  let skipped = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      try {
        const result = await downloadEntry(entry);
        if (result.status === "downloaded") downloaded++;
        if (result.status === "skipped") skipped++;
        if (result.status === "failed") {
          failures.push({ ...entry, reason: result.reason });
        }
      } catch (error) {
        failures.push({
          ...entry,
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      const done = index + 1;
      if (done % 250 === 0 || done === entries.length) {
        console.log(
          `[icon-mirror] ${done}/${entries.length} processed (${downloaded} downloaded, ${skipped} skipped, ${failures.length} failed)`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { downloaded, skipped, failures };
}

const manifest = readManifest();
const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
const { downloaded, skipped, failures } = await runPool(entries);

fs.writeFileSync(failuresPath, `${JSON.stringify(failures, null, 2)}\n`);
console.log(
  `[icon-mirror] complete: ${downloaded} downloaded, ${skipped} skipped, ${failures.length} failed`,
);

if (failures.length > 0 && process.env.ICON_MIRROR_ALLOW_FAILURES !== "1") {
  console.error(`[icon-mirror] failures written to ${failuresPath}`);
  process.exitCode = 1;
}
