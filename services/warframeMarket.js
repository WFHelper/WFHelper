const log = require('./logger').withScope('warframeMarket');
// ═══════════════════════════════════════════════════════════════════════════
// Warframe.Market Service (v2 API)
// Fetches public item list (no auth) for name→slug mapping
// Used to link items to market pages from mastery helper
// ═══════════════════════════════════════════════════════════════════════════

const WFM_V2_BASE = "https://api.warframe.market/v2";
const WFM_V2_HEADERS = {
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
  "User-Agent": "WarframeCompanion/1.0",
};

let wfmItems = [];          // Raw items from v2
let wfmByName = {};          // item_name (lowercase) → { slug, item_name }
let loaded = false;

function unwrapData(obj) {
  if (!obj) return null;
  if (obj.data !== undefined) return obj.data;
  if (obj.payload !== undefined) return obj.payload;
  return obj;
}

async function fetchItemList() {
  try {
    let items = [];

    // Try /items first, then /collections/items as fallback (matches user's GAS script)
    for (const path of ["/items", "/collections/items"]) {
      if (items.length) break;
      try {
        const resp = await fetch(`${WFM_V2_BASE}${path}`, { headers: WFM_V2_HEADERS });
        if (!resp.ok) continue;
        const json = await resp.json();
        const data = unwrapData(json);

        if (!data) continue;

        if (Array.isArray(data.items)) {
          items = data.items;
        } else if (data.items && typeof data.items === "object") {
          items = Object.entries(data.items).map(([k, v]) =>
            (v && typeof v === "object") ? { _slug: k, ...v } : { _slug: k }
          );
        } else if (Array.isArray(data)) {
          items = data;
        }
      } catch (e) {
        log.warn(`[WFMarket] v2 ${path} failed:`, e.message);
      }
    }

    wfmItems = items;

    // Build lookup by lowercase English name
    wfmByName = {};
    for (const item of wfmItems) {
      const slug = item.slug || item.url_name || item._slug || "";
      if (!slug) continue;

      // v2 uses i18n.en.itemName or i18n.en.item_name
      const name =
        item?.i18n?.en?.itemName ||
        item?.i18n?.en?.item_name ||
        item?.item_name ||
        item?.itemName ||
        item?.name ||
        "";

      if (name) {
        const key = name.toLowerCase();
        wfmByName[key] = { slug, item_name: name };
      }

      // Also index by slug-derived name for items without i18n
      const slugName = slug
        .replace(/_set$/, "")
        .replace(/_/g, " ")
        .replace(/\b[a-z]/g, (c) => c.toUpperCase());
      const slugKey = slugName.toLowerCase();
      if (!wfmByName[slugKey]) {
        wfmByName[slugKey] = { slug, item_name: name || slugName };
      }
    }

    loaded = true;
    log.log(`[WFMarket] v2 loaded ${wfmItems.length} items, ${Object.keys(wfmByName).length} name mappings`);
    return wfmItems.length;
  } catch (err) {
    log.error("[WFMarket] Failed to fetch item list:", err.message);
    return 0;
  }
}

function lookupByName(itemName) {
  if (!itemName) return null;
  let result = wfmByName[itemName.toLowerCase()];
  if (result) return result;

  // Try with/without " Set" suffix
  result = wfmByName[(itemName + " set").toLowerCase()];
  if (result) return result;
  result = wfmByName[itemName.replace(/ set$/i, "").toLowerCase()];
  return result || null;
}

function getMarketUrl(itemName) {
  const item = lookupByName(itemName);
  if (!item) return null;
  return `https://warframe.market/items/${item.slug}`;
}

function isLoaded() {
  return loaded;
}

// Serializable lookup for renderer
function getRendererLookup() {
  const lookup = {};
  for (const [key, item] of Object.entries(wfmByName)) {
    lookup[key] = {
      url_name: item.slug,
      item_name: item.item_name,
    };
  }
  return lookup;
}

module.exports = {
  fetchItemList,
  lookupByName,
  getMarketUrl,
  isLoaded,
  getRendererLookup,
};
