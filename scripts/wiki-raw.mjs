// Raw wikitext fetch shared by the data build scripts.

// The wiki answers a spoofed browser UA with a 403 challenge page, so keep this
// one; a transient 403 still happens under load and is worth a single retry.
const USER_AGENT = "WFHelper data build";
const RETRY_DELAY_MS = 30_000;

export async function fetchWikiRaw(page) {
  const url = `https://wiki.warframe.com/w/${page}?action=raw`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) return res.text();
    if (attempt === 0 && (res.status === 403 || res.status === 429)) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    throw new Error(`${page}: HTTP ${res.status} - refusing to overwrite`);
  }
  throw new Error(`${page}: unreachable - refusing to overwrite`);
}
