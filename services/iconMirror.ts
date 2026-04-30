import crypto from "node:crypto";
import path from "node:path";

export const ICON_MIRROR_BASE_URL = (
  process.env.WFHELPER_ICON_MIRROR_URL || "https://assets.wfhelper.com"
).replace(/\/+$/, "");

export function toIconMirrorUrl(sourceUrl: string | null | undefined): string | null {
  const trimmed = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (process.env.WFHELPER_ICON_MIRROR_DISABLED === "1") return trimmed;
    if (parsed.hostname === new URL(ICON_MIRROR_BASE_URL).hostname) return trimmed;

    const ext = path.extname(parsed.pathname).toLowerCase();
    const safeExt = ext && ext.length <= 8 ? ext : ".png";
    const hash = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
    return `${ICON_MIRROR_BASE_URL}/icons/${hash}${safeExt}`;
  } catch {
    return null;
  }
}
