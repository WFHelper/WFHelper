const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;
const MAX_NOTES_LEN = 2000;

/** Total over unknown input; shared by the IPC guard and the run tracker. */
export function normalizeRunTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Total over unknown input. */
export function normalizeRunNotes(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw.replace(/\r\n?/g, "\n")) {
    // Control characters corrupt the index and the list rendering; tab and
    // newline stay so a multi-line note keeps its shape.
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    if (out.length + ch.length > MAX_NOTES_LEN) break;
    out += ch;
  }
  return out.trim();
}
