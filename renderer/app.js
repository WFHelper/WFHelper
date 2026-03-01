// ═══════════════════════════════════════════════════════════════════════════
// WARFRAME COMPANION — Renderer Logic
// ═══════════════════════════════════════════════════════════════════════════

let inventoryData = null;
let parsedItems = [];
let itemDb = {};
let wfmItems = {};
let masteryData = null;
let worldData = null;
let worldLastFetch = 0;
let worldLoading = false;
let worldFissureMode = localStorage.getItem("wf_fissure_mode") === "steel" ? "steel" : "normal";
let currentView = "welcome";
let currentFilter = "all";
let searchQuery = "";
let masteryCatFilter = "all";
let masteryStatusFilter = "all";
let masterySearchQuery = "";
let debugMode = localStorage.getItem("wf_debug_mode") === "1";
const OVERLAY_SETTINGS_DEFAULTS = {
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  cropPreset: "balanced",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15000,
};
let overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
let overlaySettingsLoaded = false;

// ─── Warframe.market My Orders state ──────────────────────────────────────
let marketSession   = { loggedIn: false, userName: null, platform: "pc" };
let marketOrders    = { sell: [], buy: [] };
let marketTypeTab   = "sell";  // "sell" | "buy"
let marketStatus    = null;    // "online" | "ingame" | "invisible"
let marketSelected  = new Set(); // order IDs selected for bulk actions
let orderModalMode  = "create"; // "create" | "edit"
let orderModalEditId = null;    // orderId being edited
let orderItemChoice = null;     // { id, url_name, item_name, thumb } from catalog
let itemSearchTimer = null;

// ─── Relic Planner State ────────────────────────────────────────────────
let relicDb          = null;  // { groups: {}, byUniqueName: {} }
let relicTierFilter  = "all";
let relicSearch      = "";
let relicOwnedCounts = {};    // groupKey → { intact, exceptional, flawless, radiant }
let _openRelicGroup  = null;  // currently open in detail overlay
let relicSquadSize   = 1;     // 1=Solo, 2=Duo, 3=Trio, 4=Squad
let relicSortMode    = "tier"; // tier | ev_desc | ev_asc
let relicQualityMode = "best"; // best | intact | exceptional | flawless | radiant
let relicEvCache     = new Map(); // key: `${groupKey}|${squad}|${quality}` -> number
let relicEvNoDataCache = new Map(); // key -> timestamp ms
let relicEvPending   = new Set(); // keys currently being fetched
let relicGroupPriceCache = new Map(); // groupKey -> { transient, qualities: {quality: { rewards, prices, hasAnyPrice }} }
let relicGroupPricePending = new Set(); // groupKey currently being price-populated
let relicEvWarmupRunning = false;
let relicEvWarmupToken   = 0;
let relicEvWarmupComplete = false;
const RELIC_EV_BATCH_SIZE = 20;
const RELIC_EV_WORKERS = 2;
const RELIC_EV_NODATA_TTL_MS = 2 * 60 * 1000;
const RELIC_PRICE_REFRESH_MS = 10 * 60 * 1000;
let relicLastPriceRefreshMs = 0;
let relicPriceRefreshTimer = null;

// WFM price cache: slug → { median, timestamp }
const wfmPriceCache = {};
const WORLD_REFRESH_MS = 120000;
const PLANET_ICON_PATHS = {
  earth: "../assets/world-icons/earth.webp",
  cetus: "../assets/world-icons/earth.webp",
  vallis: "../assets/world-icons/vallis.webp",
  cambion: "../assets/world-icons/cambion.webp",
};
const RELIC_ICON_PATHS = {
  lith: "../assets/world-icons/relic-lith.png",
  meso: "../assets/world-icons/relic-meso.png",
  neo: "../assets/world-icons/relic-neo.png",
  axi: "../assets/world-icons/relic-axi.png",
  requiem: "../assets/world-icons/relic-requiem.png",
  omnia: "../assets/world-icons/relic-requiem.png",
  default: "../assets/world-icons/relic-lith.png",
};
function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeTo(date) {
  if (!date) return "N/A";
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "Refreshing...";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m ${s}s`;
}

function timeToStrict(date) {
  if (!date) return "N/A";
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "Refreshing...";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function nextDailyResetUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
}

function nextWeeklyResetUtc(now = new Date()) {
  const day = now.getUTCDay(); // Sun=0 ... Sat=6
  let daysUntilMonday = (8 - day) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0));
}

function worldLine(label, value, rightClass = "") {
  return `<div class="world-line"><span class="world-left">${esc(label)}</span><span class="world-right ${rightClass}">${esc(value)}</span></div>`;
}

function fissureTierClass(tier = "") {
  const t = tier.toLowerCase();
  if (t.includes("lith")) return "lith";
  if (t.includes("meso")) return "meso";
  if (t.includes("neo")) return "neo";
  if (t.includes("axi")) return "axi";
  if (t.includes("requiem")) return "requiem";
  if (t.includes("omnia")) return "omnia";
  return "default";
}

function relicIconSvg(tier = "") {
  const cls = fissureTierClass(tier);
  const src = RELIC_ICON_PATHS[cls] || RELIC_ICON_PATHS.default;
  return `<span class="relic-icon ${cls}" title="${esc(tier || "Relic")}"><img class="relic-icon-img" src="${esc(src)}" alt="${esc(tier || "Relic")}"></span>`;
}

function worldIcon(kind) {
  function imgPlanet(key, cls, alt) {
    const src = PLANET_ICON_PATHS[key];
    if (!src) return "";
    return `<span class="world-icon ${cls}"><img class="world-icon-img" src="${esc(src)}" alt="${esc(alt)}"></span>`;
  }

  const icons = {
    earth: imgPlanet("earth", "world-icon-earth", "Earth"),
    cetus: imgPlanet("cetus", "world-icon-cetus", "Cetus"),
    vallis: imgPlanet("vallis", "world-icon-vallis", "Orb Vallis"),
    cambion: imgPlanet("cambion", "world-icon-cambion", "Cambion Drift"),
    baro: `<span class="world-icon world-icon-baro">
      <svg viewBox="0 0 40 40">
        <defs>
          <radialGradient id="wg-baro" cx="45%" cy="40%" r="50%">
            <stop offset="0%" stop-color="#fbbf24"/>
            <stop offset="100%" stop-color="#92400e"/>
          </radialGradient>
        </defs>
        <circle cx="20" cy="20" r="16" fill="url(#wg-baro)" opacity="0.2"/>
        <path d="M13 14h14l-2 14H15l-2-14z" fill="none" stroke="#d4a843" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M16 14v-2a4 4 0 018 0v2" fill="none" stroke="#d4a843" stroke-width="1.5"/>
        <circle cx="20" cy="21" r="2" fill="#d4a843" opacity="0.5"/>
      </svg>
    </span>`,
    resurgence: `<span class="world-icon world-icon-resurgence">
      <svg viewBox="0 0 40 40">
        <defs>
          <radialGradient id="wg-resurg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#fde68a"/>
            <stop offset="100%" stop-color="#b45309"/>
          </radialGradient>
        </defs>
        <circle cx="20" cy="20" r="16" fill="url(#wg-resurg)" opacity="0.15"/>
        <circle cx="20" cy="20" r="6" fill="none" stroke="#d4a843" stroke-width="1.5"/>
        <path d="M20 8v4M20 28v4M8 20h4M28 20h4" stroke="#d4a843" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M12.3 12.3l2.8 2.8M24.9 24.9l2.8 2.8M27.7 12.3l-2.8 2.8M15.1 24.9l-2.8 2.8" stroke="#d4a843" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      </svg>
    </span>`,
  };
  return icons[kind] || icons.earth;
}

function worldLineIcon(kind, label, value, rightClass = "") {
  return `<div class="world-line"><span class="world-left">${worldIcon(kind)}${esc(label)}</span><span class="world-right ${rightClass}">${esc(value)}</span></div>`;
}

function cycleTimeDisplay(apiTimeLeft, expiryIso) {
  const api = (apiTimeLeft || "").trim();
  if (api && !/^0h?\s*0m?\s*(0s)?$/i.test(api) && !/^0m?\s*0s?$/i.test(api)) return api;
  return timeTo(parseIsoDate(expiryIso));
}

function extractPrimeNames(text) {
  if (!text) return [];
  const out = new Set();
  const matches = text.match(/(?:Prime\s+[A-Za-z']+(?:\s+[A-Za-z']+)*)|(?:[A-Za-z']+(?:\s+[A-Za-z']+)*\s+Prime)/gi) || [];
  for (const m of matches) {
    const s = m.trim().replace(/\s{2,}/g, " ");
    if (/^prime\s+/i.test(s)) {
      const rest = s.replace(/^prime\s+/i, "").trim();
      if (rest) out.add(`${rest} Prime`);
    } else {
      out.add(s);
    }
  }
  return [...out];
}

function isLikelyPrimeGear(name = "") {
  if (!/prime/i.test(name)) return false;
  if (/(scarf|armor|syandana|ephemera|sigil|glyph|emote|sugatra|operator|mask|noggle|pack)/i.test(name)) return false;
  return true;
}

function isResurgenceCandidate(entry = {}) {
  const name = entry.name || "";
  const category = (entry.category || "").toLowerCase();
  const product = (entry.productCategory || "").toLowerCase();
  const type = (entry.type || "").toLowerCase();

  if (!isLikelyPrimeGear(name)) return false;
  if (/(scarf|armor|syandana|ephemera|sigil|glyph|emote|sugatra|operator|mask|noggle|accessories)/i.test(name)) return false;

  // Prefer playable gear categories in resurgence display.
  if (["warframe", "weapon", "companion", "warframes", "primary", "secondary", "melee", "sentinels", "pets", "sentinel weapons"].includes(category)) return true;
  if (["suits", "longguns", "pistols", "melee", "sentinels", "sentinelweapons"].includes(product)) return true;
  if (/(warframe|rifle|shotgun|sniper|bow|pistol|melee|sentinel|companion)/.test(type)) return true;
  return false;
}

function canonicalName(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildOwnedMaps(data) {
  const ownedUnique = new Set();
  const ownedNames = new Set();
  if (!data) return { ownedUnique, ownedNames };

  const invKeys = [
    "Suits", "LongGuns", "Pistols", "Melee", "Sentinels", "SentinelWeapons",
    "SpaceSuits", "SpaceGuns", "SpaceMelee", "OperatorAmps", "MechSuits",
  ];

  for (const key of invKeys) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e?.ItemType) continue;
      ownedUnique.add(e.ItemType);
      const db = itemDb[e.ItemType];
      if (db?.name) ownedNames.add(db.name.toLowerCase());
    }
  }
  return { ownedUnique, ownedNames };
}

function normalizePlatValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(Math.abs(n)));
}

function debugLog(scope, message, payload) {
  if (!debugMode) return;
  if (payload !== undefined) {
    console.log(`[Debug][${scope}] ${message}`, payload);
  } else {
    console.log(`[Debug][${scope}] ${message}`);
  }
}

function setDebugModeUi(enabled) {
  debugMode = !!enabled;
  localStorage.setItem("wf_debug_mode", debugMode ? "1" : "0");
  const btn = document.getElementById("debug-toggle");
  if (btn) {
    btn.textContent = `Debug: ${debugMode ? "ON" : "OFF"}`;
    btn.classList.toggle("active", debugMode);
  }
}

function clampOverlayNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeOverlayHotkey(value) {
  const raw = String(value || "").trim();
  if (!raw) return OVERLAY_SETTINGS_DEFAULTS.hotkey;
  if (!raw.includes("+")) return raw.toUpperCase();
  return raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("+");
}

function normalizeOverlaySettings(raw) {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const cropPreset = String(candidate.cropPreset || "").toLowerCase();
  return {
    autoTriggerEnabled: candidate.autoTriggerEnabled !== undefined
      ? !!candidate.autoTriggerEnabled
      : OVERLAY_SETTINGS_DEFAULTS.autoTriggerEnabled,
    hotkeyEnabled: candidate.hotkeyEnabled !== undefined
      ? !!candidate.hotkeyEnabled
      : OVERLAY_SETTINGS_DEFAULTS.hotkeyEnabled,
    hotkey: normalizeOverlayHotkey(candidate.hotkey ?? OVERLAY_SETTINGS_DEFAULTS.hotkey),
    cropPreset: ["balanced", "tight", "wide"].includes(cropPreset) ? cropPreset : OVERLAY_SETTINGS_DEFAULTS.cropPreset,
    ocrPasses: Math.floor(clampOverlayNumber(candidate.ocrPasses, 1, 6, OVERLAY_SETTINGS_DEFAULTS.ocrPasses)),
    matchThreshold: clampOverlayNumber(candidate.matchThreshold, 0.55, 0.95, OVERLAY_SETTINGS_DEFAULTS.matchThreshold),
    ocrTimeoutMs: Math.floor(clampOverlayNumber(candidate.ocrTimeoutMs, 4000, 30000, OVERLAY_SETTINGS_DEFAULTS.ocrTimeoutMs)),
  };
}

function setOverlaySettingsStatus(message, isError = false) {
  const el = document.getElementById("setting-overlay-status");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", !!isError);
}

function applyOverlaySettingsToForm(settings) {
  const auto = document.getElementById("setting-overlay-auto-trigger");
  const hotkeyEnabled = document.getElementById("setting-overlay-hotkey-enabled");
  const hotkey = document.getElementById("setting-overlay-hotkey");
  const cropPreset = document.getElementById("setting-overlay-crop-preset");
  const ocrPasses = document.getElementById("setting-overlay-ocr-passes");
  const threshold = document.getElementById("setting-overlay-threshold");
  const timeout = document.getElementById("setting-overlay-timeout");
  if (!auto || !hotkeyEnabled || !hotkey || !cropPreset || !ocrPasses || !threshold || !timeout) return;

  auto.checked = !!settings.autoTriggerEnabled;
  hotkeyEnabled.checked = !!settings.hotkeyEnabled;
  hotkey.value = settings.hotkey || OVERLAY_SETTINGS_DEFAULTS.hotkey;
  hotkey.disabled = !hotkeyEnabled.checked;
  cropPreset.value = settings.cropPreset || OVERLAY_SETTINGS_DEFAULTS.cropPreset;
  ocrPasses.value = String(settings.ocrPasses ?? OVERLAY_SETTINGS_DEFAULTS.ocrPasses);
  threshold.value = String(settings.matchThreshold ?? OVERLAY_SETTINGS_DEFAULTS.matchThreshold);
  timeout.value = String(settings.ocrTimeoutMs ?? OVERLAY_SETTINGS_DEFAULTS.ocrTimeoutMs);
}

function readOverlaySettingsFromForm() {
  return normalizeOverlaySettings({
    autoTriggerEnabled: document.getElementById("setting-overlay-auto-trigger")?.checked,
    hotkeyEnabled: document.getElementById("setting-overlay-hotkey-enabled")?.checked,
    hotkey: document.getElementById("setting-overlay-hotkey")?.value,
    cropPreset: document.getElementById("setting-overlay-crop-preset")?.value,
    ocrPasses: document.getElementById("setting-overlay-ocr-passes")?.value,
    matchThreshold: document.getElementById("setting-overlay-threshold")?.value,
    ocrTimeoutMs: document.getElementById("setting-overlay-timeout")?.value,
  });
}

async function loadOverlaySettingsPanel(force = false) {
  if (!window.api.getOverlaySettings) return;
  if (overlaySettingsLoaded && !force) {
    applyOverlaySettingsToForm(overlaySettings);
    return;
  }
  try {
    const loaded = await window.api.getOverlaySettings();
    overlaySettings = normalizeOverlaySettings(loaded);
    overlaySettingsLoaded = true;
    applyOverlaySettingsToForm(overlaySettings);
    setOverlaySettingsStatus("");
  } catch (err) {
    overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
    applyOverlaySettingsToForm(overlaySettings);
    setOverlaySettingsStatus("Failed to load settings.", true);
    console.error("Overlay settings load failed:", err);
  }
}

async function saveOverlaySettingsPanel() {
  if (!window.api.setOverlaySettings) return;
  const payload = readOverlaySettingsFromForm();
  try {
    const saved = await window.api.setOverlaySettings(payload);
    overlaySettings = normalizeOverlaySettings(saved);
    applyOverlaySettingsToForm(overlaySettings);
    overlaySettingsLoaded = true;
    setOverlaySettingsStatus("Saved.");
  } catch (err) {
    setOverlaySettingsStatus("Failed to save settings.", true);
    console.error("Overlay settings save failed:", err);
  }
}

async function resetOverlaySettingsPanel() {
  overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
  applyOverlaySettingsToForm(overlaySettings);
  if (!window.api.setOverlaySettings) {
    setOverlaySettingsStatus("Defaults restored in form.");
    return;
  }
  try {
    const saved = await window.api.setOverlaySettings(overlaySettings);
    overlaySettings = normalizeOverlaySettings(saved);
    applyOverlaySettingsToForm(overlaySettings);
    overlaySettingsLoaded = true;
    setOverlaySettingsStatus("Defaults restored.");
  } catch (err) {
    setOverlaySettingsStatus("Failed to restore defaults.", true);
    console.error("Overlay settings reset failed:", err);
  }
}

// ─── Name & Image Resolution ───────────────────────────────────────────────

function resolveItem(internalName) {
  if (itemDb[internalName]) return itemDb[internalName];
  if (!internalName) return { name: "Unknown", imageUrl: null };
  const segments = internalName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return { name, imageUrl: null, category: "Unknown" };
}

const DB_PRODUCT_TO_FILTER = {
  Suits: "warframes",
  LongGuns: "primary",
  Pistols: "secondary",
  Melee: "melee",
  Sentinels: "companions",
  SentinelWeapons: "companions",
  SpaceSuits: "archwing",
  SpaceGuns: "archwing",
  SpaceMelee: "archwing",
  OperatorAmps: "amps",
  MechSuits: "necramech",
};

const MASTERY_CATEGORY_ORDER = ["Warframes", "Primary", "Secondary", "Melee", "Companions", "Archwing", "Amps", "Necramech"];

function orderMasteryCategories(categories) {
  const set = new Set(categories);
  const ordered = MASTERY_CATEGORY_ORDER.filter(c => set.has(c));
  const extras = [...set].filter(c => !MASTERY_CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...extras];
}

function inferCategoryFromDb(internalName, invCategory, dbEntry = {}) {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return "amps";
  const productCategory = dbEntry.productCategory || null;
  if (productCategory && DB_PRODUCT_TO_FILTER[productCategory]) {
    return DB_PRODUCT_TO_FILTER[productCategory];
  }
  return invCategory;
}

function shouldHideInventoryItem(internalName, dbEntry = {}, resolved = {}) {
  // WFCD may store exalted as an array on warframes (their attached exalted weapons).
  // Only treat explicit boolean true as "this item is an exalted weapon".
  if (dbEntry.exalted === true) return "wfcd-exalted-flag";
  if (dbEntry.productCategory === "SpecialItems") return "specialitems-product-category";
  if (typeof dbEntry.type === "string" && /exalted/i.test(dbEntry.type)) return "type-exalted";
  if (resolved?.name && /^(Exalted Blade|Regulators(?: Prime)?|Iron Staff(?: Prime)?|Dex Pixia(?: Prime)?|Artemis Bow(?: Prime)?|Desert Wind(?: Prime)?)$/i.test(resolved.name)) return "name-exalted-list";
  if (/\/ExaltedWeapons?\//i.test(internalName)) return "path-exaltedweapons";
  if (/\/SpecialItems\//i.test(internalName)) return "path-specialitems";
  return null;
}

// ─── Inventory Parsing ─────────────────────────────────────────────────────

function parseInventory(data) {
  const items = [];
  const categoryCounts = {};
  const categories = [
    { key: "Suits",           cat: "warframes",  label: "Warframe" },
    { key: "LongGuns",        cat: "primary",    label: "Primary" },
    { key: "Pistols",         cat: "secondary",  label: "Secondary" },
    { key: "Melee",           cat: "melee",      label: "Melee" },
    { key: "Sentinels",       cat: "companions", label: "Companion" },
    { key: "SentinelWeapons", cat: "companions", label: "Companion" },
    { key: "SpaceSuits",      cat: "archwing",   label: "Archwing" },
    { key: "SpaceGuns",       cat: "archwing",   label: "Archwing" },
    { key: "SpaceMelee",      cat: "archwing",   label: "Archwing" },
    { key: "OperatorAmps",    cat: "amps",       label: "Amp" },
    { key: "MechSuits",       cat: "necramech",  label: "Necramech" },
  ];

  for (const { key, cat, label } of categories) {
    if (!data[key]) continue;
    for (const entry of data[key]) {
      const resolved = resolveItem(entry.ItemType);
      const dbEntry = itemDb[entry.ItemType] || {};
      const hideReason = shouldHideInventoryItem(entry.ItemType, dbEntry, resolved);
      if (hideReason) {
        debugLog("Inventory", `Exclude ${resolved.name} | ${entry.ItemType} | reason=${hideReason}`);
        continue;
      }

      const finalCategory = inferCategoryFromDb(entry.ItemType, cat, dbEntry);
      const finalLabel = categories.find(c => c.cat === finalCategory)?.label || label;
      const categorySource = finalCategory !== cat
        ? (dbEntry.productCategory ? `productCategory:${dbEntry.productCategory}` : "path:/OperatorAmplifiers/")
        : `inventory:${key}`;
      if (finalCategory !== cat) {
        debugLog("Inventory", `Reclassify ${resolved.name} | ${entry.ItemType} | ${cat} -> ${finalCategory}`);
      }
      categoryCounts[finalCategory] = (categoryCounts[finalCategory] || 0) + 1;

      items.push({
        name: resolved.name,
        internalName: entry.ItemType,
        category: finalCategory,
        categoryLabel: finalLabel,
        rank: entry.XP ? Math.min(30, Math.floor(entry.XP / 6000)) : 0,
        maxRank: 30,
        imageUrl: resolved.imageUrl,
        isPrime: resolved.isPrime || false,
        masteryReq: resolved.masteryReq || 0,
        vaulted: resolved.vaulted || false,
        tradable: dbEntry.tradable || resolved.isPrime || false,
        description: dbEntry.description || "",
        components: dbEntry.components || [],
        drops: dbEntry.drops || [],
        wikiaUrl: dbEntry.wikiaUrl || null,
        debugReason: `show:inventory; cat:${categorySource}; dbCat:${dbEntry.category || "?"}; product:${dbEntry.productCategory || "?"}; type:${dbEntry.type || "?"}`,
      });
    }
  }
  debugLog("Inventory", `Parsed ${items.length} items`, categoryCounts);
  return items;
}

function parseFoundry(data) {
  const building = [];
  const recipes = [];

  if (data.PendingRecipes) {
    for (const recipe of data.PendingRecipes) {
      const resolved = resolveItem(recipe.ItemType);
      let endDate = null;
      try {
        endDate = recipe.CompletionDate
          ? new Date(recipe.CompletionDate.$date?.$numberLong
              ? parseInt(recipe.CompletionDate.$date.$numberLong)
              : recipe.CompletionDate.$date || recipe.CompletionDate)
          : null;
      } catch {}
      building.push({ name: resolved.name, imageUrl: resolved.imageUrl, endDate });
    }
  }

  if (data.Recipes) {
    for (const recipe of data.Recipes) {
      const resolved = resolveItem(recipe.ItemType);
      recipes.push({ name: resolved.name, imageUrl: resolved.imageUrl, count: recipe.ItemCount || 1 });
    }
  }
  return { building, recipes };
}

function parseResources(data) {
  const resources = [];
  if (data.MiscItems) {
    for (const item of data.MiscItems) {
      const resolved = resolveItem(item.ItemType);
      resources.push({ name: resolved.name, imageUrl: resolved.imageUrl, internalName: item.ItemType, count: item.ItemCount || 0 });
    }
  }
  resources.sort((a, b) => b.count - a.count);
  return resources;
}

// ─── Image Helper ──────────────────────────────────────────────────────────

function imgTag(url, name, cls = "item-img") {
  if (!url) {
    return `<div class="${cls} img-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="M20 14l-4-4L6 20"/></svg></div>`;
  }
  return `<img class="${cls}" src="${esc(url)}" alt="${esc(name)}" loading="lazy" />`;
}

function setupImageErrorHandlers() {
  document.querySelectorAll("img:not([data-error-handled])").forEach(img => {
    img.setAttribute("data-error-handled", "1");
    img.addEventListener("error", () => {
      const placeholder = document.createElement("div");
      placeholder.className = img.className + " img-placeholder";
      placeholder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
      img.replaceWith(placeholder);
    });
  });
}

// ─── WFM Price Fetching (v1 statistics, matching user's GAS script) ──────

async function fetchWfmPrice(itemName) {
  if (!itemName) return null;
  const key = itemName.toLowerCase();

  // Find slug from v2 map
  const mapping = wfmItems[key] || wfmItems[`${key} set`] || wfmItems[key.replace(/ set$/i, "")] || null;
  let slug = mapping?.url_name;

  // Guess slug if not in map
  if (!slug) {
    slug = key.replace(/['']/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  if (!slug) return null;

  // Check cache (5 min TTL)
  if (wfmPriceCache[slug] && (Date.now() - wfmPriceCache[slug].timestamp < 300000)) {
    return wfmPriceCache[slug];
  }

  // Try slug, then slug_set
  const slugsToTry = slug.endsWith("_set") ? [slug] : [slug + "_set", slug];
  for (const trySlug of slugsToTry) {
    try {
      const resp = await fetch(
        `https://api.warframe.market/v1/items/${trySlug}/statistics`,
        {
          headers: {
            Platform: "pc",
            Language: "en",
            Crossplay: "true",
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "WarframeCompanion/1.0",
          },
        }
      );
      if (!resp.ok) continue;
      const json = await resp.json();
      const payload = json?.payload;
      if (!payload) continue;

      const closed = payload.statistics_closed || {};
      const live = payload.statistics_live || {};
      const hours48 = closed["48hours"] || closed["48_hours"] || [];
      const live48 = live["48hours"] || live["48_hours"] || [];

      const rows = [...hours48, ...live48]
        .filter(x => !x.order_type || x.order_type === "sell")
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

      const latest = rows.length ? rows[rows.length - 1] : null;
      const median = latest && (
        latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price
      );

      if (median != null) {
        const normalized = normalizePlatValue(median);
        if (normalized == null) continue;
        const result = { median: normalized, slug: trySlug, timestamp: Date.now() };
        wfmPriceCache[slug] = result;
        return result;
      }
    } catch (e) {
      console.warn(`[WFM] stats fetch failed for ${trySlug}:`, e.message);
    }
  }
  return null;
}

// ─── Item Detail Overlay ───────────────────────────────────────────────────

function openItemDetail(item) {
  const overlay = document.getElementById("item-detail-overlay");
  overlay.style.display = "flex";

  // Image
  const imgWrap = document.getElementById("item-detail-img");
  imgWrap.innerHTML = item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" />`
    : `<div class="img-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></div>`;

  // Name
  document.getElementById("item-detail-name").textContent = item.name;

  // Tags
  const tags = [];
  if (item.isPrime) tags.push('<span class="detail-tag prime">PRIME</span>');
  if (item.vaulted) tags.push('<span class="detail-tag vaulted">VAULTED</span>');
  if (item.status === "mastered") tags.push('<span class="detail-tag mastered">MASTERED</span>');
  else if (item.status === "progress") tags.push('<span class="detail-tag progress">IN PROGRESS</span>');
  else if (item.status === "missing") tags.push('<span class="detail-tag missing">MISSING</span>');
  document.getElementById("item-detail-tags").innerHTML = tags.join("");

  // Meta
  const meta = [];
  if (item.categoryLabel || item.category) meta.push(item.categoryLabel || item.category);
  if (item.masteryReq) meta.push(`MR ${item.masteryReq}`);
  if (item.rank != null && item.maxRank) meta.push(`Rank ${item.rank}/${item.maxRank}`);
  document.getElementById("item-detail-meta").textContent = meta.join(" · ");

  // Description
  const dbEntry = item.internalName ? (itemDb[item.internalName] || {}) : {};
  document.getElementById("item-detail-desc").textContent = item.description || dbEntry.description || "";

  // Components
  const compSection = document.getElementById("item-detail-components-section");
  const compContainer = document.getElementById("item-detail-components");
  const components = item.components || dbEntry.components || [];

  if (components.length > 0) {
    compSection.style.display = "block";
    compContainer.innerHTML = components.map(comp => {
      const ownedCount = comp.ownedCount ?? 0;
      const needed = comp.itemCount || 1;
      let stateClass = "not-owned";
      let countClass = "has-none";
      if (ownedCount >= needed) { stateClass = "owned"; countClass = "has-enough"; }
      else if (ownedCount > 0) { stateClass = "partial"; countClass = "has-some"; }

      return `<div class="detail-comp-row ${stateClass}" data-comp='${esc(JSON.stringify(comp))}' data-parent="${esc(item.name)}">
        <span class="comp-name">${esc(comp.name || "Unknown")}</span>
        <span class="comp-count ${countClass}">${ownedCount}/${needed}</span>
      </div>`;
    }).join("");

    // Bind click events on components
    compContainer.querySelectorAll(".detail-comp-row").forEach(row => {
      row.addEventListener("click", () => {
        try {
          const comp = JSON.parse(row.dataset.comp);
          openComponentDetail(comp, row.dataset.parent);
        } catch (e) { console.error("Comp click error:", e); }
      });
    });
  } else {
    compSection.style.display = "none";
  }

  // Acquisition
  const acqSection = document.getElementById("item-detail-acquisition-section");
  const acqContainer = document.getElementById("item-detail-acquisition");
  const drops = item.drops || dbEntry.drops || [];

  if (drops.length > 0) {
    acqSection.style.display = "block";
    acqContainer.innerHTML = drops.slice(0, 10).map(d =>
      `<div class="drop-entry"><span class="drop-location">${esc(d.location)}</span>${d.rarity ? `<span class="drop-rarity">(${esc(d.rarity)})</span>` : ""}</div>`
    ).join("") + (drops.length > 10 ? `<div class="drop-entry" style="opacity:0.5">...and ${drops.length - 10} more sources</div>` : "");
  } else {
    acqSection.style.display = "none";
  }

  // Market price
  const marketEl = document.getElementById("item-detail-market");
  const isTradable = item.tradable || item.isPrime || !!(wfmItems[(item.name || "").toLowerCase()] || wfmItems[(item.name + " Set").toLowerCase()]);

  if (isTradable) {
    marketEl.innerHTML = "Loading price...";
    updateMarketPrice(item.name, marketEl);
  } else {
    marketEl.innerHTML = "Item is not tradable.";
  }

  setupImageErrorHandlers();
}

async function updateMarketPrice(itemName, el) {
  try {
    const result = await fetchWfmPrice(itemName);
    if (result && result.median != null) {
      const plat = normalizePlatValue(result.median);
      if (plat == null) throw new Error("Invalid market value");
      el.innerHTML = `<span class="market-price">~${plat} platinum</span> <span style="opacity:0.6">(48h median)</span>
        <br><button class="market-link-btn" data-url="https://warframe.market/items/${result.slug}">Open on warframe.market</button>`;
      el.querySelector(".market-link-btn")?.addEventListener("click", () => {
        window.api.openExternal(`https://warframe.market/items/${result.slug}`);
      });
    } else {
      // Still show a link even if no stats
      const mapping = wfmItems[(itemName || "").toLowerCase()] || wfmItems[(itemName + " set").toLowerCase()];
      if (mapping) {
        el.innerHTML = `No recent price data.<br><button class="market-link-btn" data-url="https://warframe.market/items/${mapping.url_name}">Open on warframe.market</button>`;
        el.querySelector(".market-link-btn")?.addEventListener("click", () => {
          window.api.openExternal(`https://warframe.market/items/${mapping.url_name}`);
        });
      } else {
        el.textContent = "No listing found for this item.";
      }
    }
  } catch (e) {
    el.textContent = "Failed to load price data.";
  }
}

function closeItemDetail() {
  document.getElementById("item-detail-overlay").style.display = "none";
}

// ─── Component Detail Overlay ─────────────────────────────────────────────

function openComponentDetail(comp, parentName) {
  const overlay = document.getElementById("comp-detail-overlay");
  overlay.style.display = "flex";

  document.getElementById("comp-detail-name").textContent = comp.name || "Unknown Component";

  const meta = [];
  if (parentName) meta.push(parentName);
  if (comp.tradable) meta.push("Tradable");
  const needed = comp.itemCount || 1;
  const owned = comp.ownedCount ?? 0;
  meta.push(`${owned}/${needed} owned`);
  document.getElementById("comp-detail-meta").textContent = meta.join(" · ");

  // Drops
  const dropsSection = document.getElementById("comp-detail-drops-section");
  const dropsContainer = document.getElementById("comp-detail-drops");
  const drops = comp.drops || [];

  if (drops.length > 0) {
    dropsSection.style.display = "block";
    dropsContainer.innerHTML = drops.slice(0, 15).map(d =>
      `<div class="drop-entry"><span class="drop-location">${esc(d.location)}</span>${d.rarity ? `<span class="drop-rarity">(${esc(d.rarity)})</span>` : ""}</div>`
    ).join("");
  } else {
    dropsSection.style.display = "none";
  }

  // Market price for component
  const marketEl = document.getElementById("comp-detail-market");
  const compName = comp.name || "";
  const isTradable = comp.tradable || !!(wfmItems[compName.toLowerCase()]);

  if (isTradable) {
    marketEl.innerHTML = "Loading price...";
    updateMarketPrice(compName, marketEl);
  } else {
    marketEl.innerHTML = "Component is not tradable.";
  }
}

function closeComponentDetail() {
  document.getElementById("comp-detail-overlay").style.display = "none";
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function renderInventory() {
  const grid = document.getElementById("inventory-grid");
  let filtered = parsedItems;

  if (currentFilter !== "all") filtered = filtered.filter(i => i.category === currentFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.categoryLabel.toLowerCase().includes(q) ||
      i.internalName.toLowerCase().includes(q)
    );
  }

  filtered.sort((a, b) => {
    if ((a.rank >= a.maxRank) !== (b.rank >= b.maxRank)) return a.rank >= a.maxRank ? -1 : 1;
    if (a.isPrime !== b.isPrime) return a.isPrime ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  document.querySelector("#view-inventory .view-header h2").textContent = `Inventory (${filtered.length})`;

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><p>No items found</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map((item, idx) => {
    const mastered = item.rank >= item.maxRank;
    const pct = mastered ? 100 : Math.max(0, Math.min(99, Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));
    return `
    <div class="item-card ${mastered ? "mastered" : ""} ${item.isPrime ? "prime" : ""}" data-inv-idx="${idx}">
      <div class="item-img-wrap">
        ${imgTag(item.imageUrl, item.name)}
        ${item.isPrime ? '<span class="prime-badge">PRIME</span>' : ""}
        ${item.vaulted ? '<span class="vault-badge">V</span>' : ""}
      </div>
      <div class="item-body">
        <span class="item-name">${esc(item.name)}</span>
        <span class="item-type">${esc(item.categoryLabel)}${item.masteryReq ? ` · MR ${item.masteryReq}` : ""}</span>
        <div class="item-rank-bar"><div class="rank-fill ${mastered ? "max" : "partial"}" style="width:${(item.rank / item.maxRank) * 100}%"></div></div>
        <span class="item-rank-text">${item.rank}/${item.maxRank}</span>
        ${debugMode ? `<span class="debug-reason">${esc(item.debugReason || `show:inventory; progress:${pct}%`)}</span>` : ""}
      </div>
    </div>`;
  }).join("");

  // Bind click events
  grid.querySelectorAll(".item-card[data-inv-idx]").forEach(card => {
    card.addEventListener("click", () => {
      const item = filtered[parseInt(card.dataset.invIdx)];
      if (item) openItemDetail(item);
    });
  });

  setupImageErrorHandlers();
}

function renderFoundry() {
  if (!inventoryData) return;
  const { building, recipes } = parseFoundry(inventoryData);

  const buildList = document.getElementById("foundry-building-list");
  buildList.innerHTML = !building.length
    ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p>Nothing currently building</p></div>`
    : building.map(item => {
      const timeStr = item.endDate ? formatTimeRemaining(item.endDate) : "Unknown";
      const isReady = item.endDate && item.endDate <= new Date();
      return `<div class="foundry-item"><div class="foundry-item-left"><div class="foundry-img-wrap">${imgTag(item.imageUrl, item.name, "foundry-img")}</div><span class="foundry-item-name">${esc(item.name)}</span></div><span class="foundry-timer ${isReady ? "ready" : ""}">${isReady ? "READY" : timeStr}</span></div>`;
    }).join("");

  const recipeList = document.getElementById("foundry-recipes-list");
  recipeList.innerHTML = !recipes.length
    ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg><p>No blueprints</p></div>`
    : [...recipes].sort((a, b) => b.count - a.count).slice(0, 100).map(item => `
      <div class="foundry-item"><div class="foundry-item-left"><div class="foundry-img-wrap">${imgTag(item.imageUrl, item.name, "foundry-img")}</div><span class="foundry-item-name">${esc(item.name)}</span></div><span class="count-badge">${item.count}</span></div>`).join("");

  setupImageErrorHandlers();
}

function renderResources() {
  if (!inventoryData) return;
  const resources = parseResources(inventoryData);
  const grid = document.getElementById("resource-grid");
  const query = (document.getElementById("resource-search")?.value || "").toLowerCase();

  let filtered = resources;
  if (query) filtered = filtered.filter(r =>
    r.name.toLowerCase().includes(query) ||
    r.internalName.toLowerCase().includes(query)
  );

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>No resources found</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map(r => `
    <div class="resource-card">
      <div class="resource-img-wrap">${imgTag(r.imageUrl, r.name, "resource-img")}</div>
      <div class="resource-info">
        <span class="resource-name">${esc(r.name)}</span>
        <span class="resource-count">${formatNumber(r.count)}</span>
      </div>
    </div>`).join("");

  setupImageErrorHandlers();
}

// ─── World View ─────────────────────────────────────────────────────────────

async function loadWorldData(force = false) {
  const now = Date.now();
  if (worldLoading) return;
  if (!force && worldData && (now - worldLastFetch) < WORLD_REFRESH_MS) {
    renderWorld();
    return;
  }

  worldLoading = true;
  renderWorld();
  try {
    const data = await window.api.getWorldState();
    if (!data) throw new Error("No data returned");
    worldData = data;
    worldLastFetch = Date.now();
  } catch (e) {
    console.error("Failed to load world data:", e.message);
  } finally {
    worldLoading = false;
  }

  renderWorld();
}

function renderWorld() {
  const grid = document.getElementById("world-grid");
  if (!grid) return;
  if (worldLoading && !worldData) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Loading world data...</p></div>`;
    return;
  }
  if (!worldData) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>World data unavailable</p></div>`;
    return;
  }

  try {
    const now = new Date();

  // Prime Resurgence (Varzia / vault trader)
  const varzia = worldData.vaultTrader || null;
  const varziaExpiry = parseIsoDate(varzia?.expiry);
  const varziaAct = parseIsoDate(varzia?.activation);
  const varziaActive = !!(varziaAct && varziaExpiry && now >= varziaAct && now < varziaExpiry);
  const varziaTime = varziaActive ? timeTo(varziaExpiry) : timeTo(varziaAct);
  const varziaInventory = (varzia?.inventory || []).map(i => {
    const db = i?.uniqueName ? itemDb[i.uniqueName] : null;
    const raw = db?.name || i.item || "Unknown";
    return raw
      .replace(/\bM\s*P\s*V\b/gi, "")
      .replace(/\b(single|dual)\s*pack\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  });
  const dbByName = new Map();
  for (const [u, v] of Object.entries(itemDb || {})) {
    if (!v?.name) continue;
    dbByName.set(v.name.toLowerCase(), { ...v, uniqueName: u });
  }
  const dbByCanonical = new Map();
  for (const [u, v] of Object.entries(itemDb)) {
    if (!v?.name) continue;
    const c = canonicalName(v.name);
    if (!dbByCanonical.has(c)) dbByCanonical.set(c, { ...v, uniqueName: u });
  }
  const { ownedUnique, ownedNames } = buildOwnedMaps(inventoryData);
  const featuredPrimes = [];
  const seenPrime = new Set();

  // Prefer direct uniqueName entries with reliable images.
  for (const inv of (varzia?.inventory || [])) {
    const db = inv?.uniqueName ? itemDb[inv.uniqueName] : null;
    if (!db || !db.name || !db.imageUrl || !isResurgenceCandidate(db)) continue;
    const key = db.name.toLowerCase();
    if (seenPrime.has(key)) continue;
    seenPrime.add(key);
    featuredPrimes.push({
      name: db.name,
      imageUrl: db.imageUrl,
      owned: ownedUnique.has(inv.uniqueName) || ownedNames.has(key),
    });
    if (featuredPrimes.length >= 9) break;
  }

  // Fill from pack labels when direct unique names are incomplete.
  if (featuredPrimes.length < 9) {
    for (const name of varziaInventory) {
      for (const primeName of extractPrimeNames(name)) {
        const cleaned = primeName
          .replace(/\bpower suit\b/gi, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        const db = dbByName.get(cleaned.toLowerCase()) || dbByCanonical.get(canonicalName(cleaned));
        if (!db || !db.imageUrl || !isResurgenceCandidate(db)) continue;
        const key = db.name.toLowerCase();
        if (seenPrime.has(key)) continue;
        seenPrime.add(key);
        featuredPrimes.push({
          name: db.name,
          imageUrl: db.imageUrl,
          owned: (db.uniqueName && ownedUnique.has(db.uniqueName)) || ownedNames.has(key),
        });
        if (featuredPrimes.length >= 9) break;
      }
      if (featuredPrimes.length >= 9) break;
    }
  }

  // Baro
  const baro = worldData.voidTrader || null;
  const baroActivation = parseIsoDate(baro?.activation);
  const baroExpiry = parseIsoDate(baro?.expiry);
  const baroActive = !!(baroActivation && baroExpiry && now >= baroActivation && now < baroExpiry);
  const baroTime = baroActive ? timeTo(baroExpiry) : timeTo(baroActivation);

  // Planet resets / cycles
  const earth = worldData.earthCycle || {};
  const cetus = worldData.cetusCycle || {};
  const vallis = worldData.vallisCycle || {};
  const cambion = worldData.cambionCycle || {};

  const earthLabel = earth.isDay ? "Day" : "Night";
  const cetusLabel = cetus.isDay ? "Day" : "Night";
  const vallisLabel = vallis.isWarm ? "Warm" : "Cold";
  const cambionLabel = (cambion.active || "").toString().toUpperCase() || "Unknown";

  // Fissures
  const nowMs = Date.now();
  const fissuresAll = (worldData.fissures || [])
    .filter(f => !f.expired && ((parseIsoDate(f.expiry)?.getTime() || 0) > (nowMs + 1500)))
    .sort((a, b) => (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0));

  const fissures = fissuresAll.filter(f => (worldFissureMode === "steel" ? f.isHard === true : f.isHard !== true));
  const tierOrder = ["Lith", "Meso", "Neo", "Axi", "Requiem", "Omnia"];
  const fissureGroups = tierOrder
    .map(tier => ({
      tier,
      missions: fissures.filter(f => (f.tier || "").toLowerCase() === tier.toLowerCase()).slice(0, 3),
    }))
    .filter(g => g.missions.length > 0);

  // Reset timers
  const dailyReset = nextDailyResetUtc(now);
  const weeklyReset = nextWeeklyResetUtc(now);
  const sortieReset = parseIsoDate(worldData.sortie?.expiry);
  const steelPathReset = parseIsoDate(worldData.steelPath?.expiry);

  // Circuit / Duviri
  const duviri = worldData.duviriCycle || {};
  const duviriState = (duviri.state || "unknown").toString();
  const duviriExpiry = parseIsoDate(duviri.expiry);
  const duviriChoicesNormal = (duviri.choices || []).find(c => c.category === "normal")?.choices || [];
  const duviriChoicesHard = (duviri.choices || []).find(c => c.category === "hard")?.choices || [];

  grid.innerHTML = `
    <div class="world-layout">
      <div class="world-left-col">
        <div class="world-card">
          <div class="world-top-row">
            <span class="world-pill">${worldIcon("resurgence")}Prime Resurgence</span>
            <span class="world-pill warn">${worldIcon("baro")}Baro in ${esc(baroTime)}</span>
          </div>
          ${worldLine("Location", varzia?.location || "Varzia")}
          <div class="world-line"><span class="world-left">Status</span><span class="world-pill ${varziaActive ? "good" : "warn"}">${varziaActive ? "Active" : "Upcoming"}</span></div>
          ${featuredPrimes.length ? `
            <div class="resurgence-grid">
              ${featuredPrimes.map((p) => `
                <div class="resurgence-item ${p.owned ? "owned" : ""}">
                  <div class="resurgence-img-wrap">${imgTag(p.imageUrl, p.name, "resurgence-img")}</div>
                  <span class="resurgence-name">${esc(p.name)}</span>
                </div>`).join("")}
            </div>
          ` : `<div class="world-left">No featured prime items found</div>`}
          <div class="resurgence-next">Next rotation in: <strong>${esc(varziaTime)}</strong></div>
        </div>

        <div class="world-card">
          <h3>Planet Cycles</h3>
          ${(earth.expiry || cetus.expiry || vallis.expiry || cambion.expiry) ? `
            ${worldLineIcon("earth",   `Earth ${earthLabel}`,       cycleTimeDisplay(earth.timeLeft,   earth.expiry))}
            ${worldLineIcon("cetus",   `Cetus ${cetusLabel}`,       cycleTimeDisplay(cetus.timeLeft,   cetus.expiry))}
            ${worldLineIcon("vallis",  `Vallis ${vallisLabel}`,     cycleTimeDisplay(vallis.timeLeft,  vallis.expiry))}
            ${worldLineIcon("cambion", `Cambion ${cambionLabel}`,   cycleTimeDisplay(cambion.timeLeft, cambion.expiry))}
          ` : `<div class="world-left" style="color:var(--text-muted);font-size:12px;line-height:1.6">
            Cycle timers are not included in the official DE API. Check in-game or on the Warframe wiki.
          </div>`}
        </div>

        <div class="world-card">
          <h3>Reset Timers</h3>
          ${worldLine("Weekly resets", timeTo(weeklyReset))}
          ${worldLine("Daily sortie", timeTo(sortieReset || dailyReset))}
          ${worldLine("Daily reset", timeTo(dailyReset))}
          ${worldLine("Steel Path honors", timeTo(steelPathReset || weeklyReset))}
        </div>

        <div class="world-card">
          <h3>The Circuit</h3>
          ${worldLine(`Duviri ${duviriState}`, timeTo(duviriExpiry))}
          <div class="world-left" style="margin-top:6px;">Normal Rotation</div>
          <div class="world-circuit-list">${duviriChoicesNormal.map(n => `<span class="world-pill">${esc(n)}</span>`).join("") || `<span class="world-left">No data</span>`}</div>
          <div class="world-left" style="margin-top:8px;">Steel Path Rotation</div>
          <div class="world-circuit-list">${duviriChoicesHard.map(n => `<span class="world-pill">${esc(n)}</span>`).join("") || `<span class="world-left">No data</span>`}</div>
        </div>
      </div>

      <div class="world-right-col">
        <div class="world-card world-fissure-card">
          <div class="world-fissure-header">
            <h3>Void Fissures</h3>
            <div class="fissure-mode-toggle">
              <button class="fissure-mode-btn ${worldFissureMode === "normal" ? "active" : ""}" data-fmode="normal">Normal</button>
              <button class="fissure-mode-btn ${worldFissureMode === "steel" ? "active" : ""}" data-fmode="steel">Steel Path</button>
            </div>
          </div>
          <div class="world-fissure-list">
            ${fissureGroups.length ? fissureGroups.map(g => `
              <div class="world-fissure-group">
                <div class="world-fissure-group-head">
                  ${relicIconSvg(g.tier)}
                  <span class="world-fissure-tier">${esc(g.tier)}</span>
                </div>
                ${g.missions.map(f => `
                  <div class="world-fissure-line">
                    <div class="world-fissure-mission">
                      <span class="world-fissure-chevron">⌃</span>
                      <strong>${esc(f.missionType || "Mission")}</strong>
                      <span class="world-fissure-node">(${esc(f.node || "Unknown Node")})</span>
                    </div>
                    <span class="world-right">${esc(timeToStrict(parseIsoDate(f.expiry)))}</span>
                  </div>
                `).join("")}
              </div>
            `).join("") : `<div class="world-left">No active ${worldFissureMode === "steel" ? "Steel Path" : "Normal"} fissures</div>`}
          </div>
        </div>
      </div>
    </div>
  `;

    grid.querySelectorAll(".fissure-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        worldFissureMode = btn.dataset.fmode === "steel" ? "steel" : "normal";
        localStorage.setItem("wf_fissure_mode", worldFissureMode);
        renderWorld();
      });
    });
  } catch (err) {
    console.error("renderWorld error:", err);
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>World data unavailable</p></div>`;
  }
}

// ─── Mastery Helper ───────────────────────────────────────────────────────

async function loadMasteryData() {
  masteryData = await window.api.getMasteryProgress();
  if (!masteryData) return;
  debugLog("Mastery", `Loaded ${masteryData.items?.length || 0} mastery items`);

  // Build category filter tabs dynamically
  const catContainer = document.getElementById("mastery-category-filters");
  const cats = orderMasteryCategories(Object.keys(masteryData.stats.byCategory));
  catContainer.innerHTML = `<button class="filter-tab active" data-mcat="all">All</button>` +
    cats.map(c => `<button class="filter-tab" data-mcat="${esc(c)}">${esc(c)}</button>`).join("");

  catContainer.querySelectorAll(".filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      catContainer.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      masteryCatFilter = tab.dataset.mcat;
      renderMastery();
    });
  });

  renderMastery();
}

function renderMastery() {
  if (!masteryData) return;

  const { items, stats } = masteryData;

  // ─── Stats overview
  const pct = stats.total > 0 ? ((stats.mastered / stats.total) * 100).toFixed(1) : 0;
  const profileMastery = stats.profileMastery || null;
  const statsEl = document.getElementById("mastery-stats");
  statsEl.innerHTML = `
    <div class="mastery-overview">
      <div class="mastery-ring-wrap">
        <svg class="mastery-ring" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--accent-blue)" stroke-width="8"
            stroke-dasharray="${2 * Math.PI * 52}"
            stroke-dashoffset="${2 * Math.PI * 52 * (1 - stats.mastered / Math.max(stats.total, 1))}"
            stroke-linecap="round" transform="rotate(-90 60 60)"/>
          <text x="60" y="55" text-anchor="middle" fill="var(--text-primary)" font-size="22" font-weight="700" font-family="Rajdhani">${pct}%</text>
          <text x="60" y="72" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="Barlow">MASTERED</text>
        </svg>
      </div>
      <div class="mastery-stat-cards">
        <div class="mstat-card mastered"><div class="mstat-num">${stats.mastered}</div><div class="mstat-label">Mastered</div></div>
        <div class="mstat-card progress"><div class="mstat-num">${stats.inProgress}</div><div class="mstat-label">In Progress</div></div>
        <div class="mstat-card missing"><div class="mstat-num">${stats.missing}</div><div class="mstat-label">Missing</div></div>
        <div class="mstat-card total"><div class="mstat-num">${stats.total}</div><div class="mstat-label">Total</div></div>
        ${profileMastery && profileMastery.rank != null ? `<div class="mstat-card">
          <div class="mstat-num">MR ${profileMastery.rank}</div>
          <div class="mstat-label">${profileMastery.percentToNext != null ? `${profileMastery.percentToNext}% to next` : "Progress unavailable"}</div>
        </div>` : ""}
      </div>
    </div>
    <div class="mastery-cat-bars">
      ${orderMasteryCategories(Object.keys(stats.byCategory)).map(cat => {
        const cs = stats.byCategory[cat];
        const catPct = cs.total > 0 ? ((cs.mastered / cs.total) * 100).toFixed(0) : 0;
        return `<div class="cat-bar-row">
          <span class="cat-bar-label">${esc(cat)}</span>
          <div class="cat-bar-track">
            <div class="cat-bar-fill mastered" style="width:${(cs.mastered / cs.total) * 100}%"></div>
            <div class="cat-bar-fill progress" style="width:${(cs.inProgress / cs.total) * 100}%; left:${(cs.mastered / cs.total) * 100}%"></div>
          </div>
          <span class="cat-bar-nums">${cs.mastered}/${cs.total} <small>(${catPct}%)</small></span>
        </div>`;
      }).join("")}
    </div>`;

  // ─── Filter items
  let filtered = items;
  if (masteryCatFilter !== "all") {
    filtered = filtered.filter(i => i.category === masteryCatFilter);
  }
  if (masteryStatusFilter !== "all") {
    filtered = filtered.filter(i => i.status === masteryStatusFilter);
  }
  if (masterySearchQuery) {
    const q = masterySearchQuery.toLowerCase();
    filtered = filtered.filter(i => {
      if (i.name.toLowerCase().includes(q)) return true;
      if (i.category.toLowerCase().includes(q)) return true;
      if (i.uniqueName.toLowerCase().includes(q)) return true;
      if (i.keywords && i.keywords.some(kw => kw.includes(q))) return true;
      return false;
    });
  }
  debugLog("Mastery", `Render filters cat=${masteryCatFilter} status=${masteryStatusFilter} query="${masterySearchQuery}" -> ${filtered.length} items`);

  // Sort: mastered first, then in-progress, then missing
  const statusOrder = { mastered: 0, progress: 1, missing: 2 };
  filtered.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
    return a.name.localeCompare(b.name);
  });

  // ─── Render grid
  const grid = document.getElementById("mastery-grid");

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>No items match your filters</p></div>`;
    return;
  }

  grid.innerHTML = filtered.map((item, idx) => {
    const wfm = wfmItems[item.name.toLowerCase()];
    const marketLink = wfm ? `https://warframe.market/items/${wfm.url_name}` : null;
    const mastered = item.status === "mastered";
    const missing = item.status === "missing";
    const nextPct = missing ? 0 : Math.max(0, Math.min(100, Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));

    // Component dots
    const compDots = (item.components || []).slice(0, 8).map(comp => {
      const isOwned = comp.owned || (comp.ownedCount >= (comp.itemCount || 1));
      return `<span class="comp-dot ${isOwned ? "owned" : "missing"}" title="${esc(comp.name || "?")}: ${isOwned ? "owned" : "missing"}" data-comp='${esc(JSON.stringify(comp))}' data-parent="${esc(item.name)}"></span>`;
    }).join("");

    return `
    <div class="item-card mastery-card ${item.status} ${item.isPrime ? "prime" : ""}" data-m-idx="${idx}">
      <div class="item-img-wrap">
        ${imgTag(item.imageUrl, item.name)}
        ${item.isPrime ? '<span class="prime-badge">P</span>' : ""}
        ${item.vaulted ? '<span class="vault-badge">V</span>' : ""}
        <span class="status-indicator ${item.status}"></span>
      </div>
      <div class="item-body">
        <span class="item-name">${esc(item.name)}</span>
        <span class="item-type">${esc(item.category)}${item.masteryReq ? ` · MR ${item.masteryReq}` : ""}</span>
        ${!missing ? `
          <div class="item-rank-bar"><div class="rank-fill ${mastered ? "max" : "partial"}" style="width:${item.maxRank > 0 ? (item.rank / item.maxRank) * 100 : 0}%"></div></div>
          <span class="item-rank-text">Lv ${item.rank}/${item.maxRank} · ${nextPct}%</span>
        ` : `<span class="mastery-missing-label">Not owned</span>`}
        ${debugMode ? `<span class="debug-reason">${esc(item.debugReason || "show:mastery")}</span>` : ""}
        ${compDots ? `<div class="comp-dots">${compDots}</div>` : ""}
        ${marketLink ? `<a class="wfm-link" data-url="${esc(marketLink)}" title="View on warframe.market">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H3v10h10v-3"/><path d="M9 2h5v5"/><path d="M14 2L7 9"/></svg>
        </a>` : ""}
      </div>
    </div>`;
  }).join("");

  // Bind card click → detail overlay
  grid.querySelectorAll(".mastery-card[data-m-idx]").forEach(card => {
    card.addEventListener("click", (e) => {
      // Don't open detail if clicking wfm link or comp dot
      if (e.target.closest(".wfm-link") || e.target.closest(".comp-dot")) return;
      const item = filtered[parseInt(card.dataset.mIdx)];
      if (item) openItemDetail(item);
    });
  });

  // Bind comp dot clicks
  grid.querySelectorAll(".comp-dot").forEach(dot => {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        const comp = JSON.parse(dot.dataset.comp);
        openComponentDetail(comp, dot.dataset.parent);
      } catch (err) { console.error("Comp dot click error:", err); }
    });
  });

  // Handle wfm link clicks
  grid.querySelectorAll(".wfm-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.api.openExternal(link.dataset.url);
    });
  });

  setupImageErrorHandlers();
}

// ─── Warframe.market My Orders ─────────────────────────────────────────

function updateStatusButtons(status) {
  marketStatus = status || null;
  document.querySelectorAll(".status-btn").forEach(btn => {
    btn.classList.toggle("status-active", btn.dataset.status === marketStatus);
  });
}

async function loadMarketView() {
  try {
    marketSession = await window.api.wfmGetSession();
  } catch (e) {
    console.error("[Market] getSession failed:", e);
  }
  renderMarketView();
  if (marketSession.loggedIn) {
    fetchMarketOrders();
    try {
      const me = await window.api.wfmGetMe();
      if (me && me.status) updateStatusButtons(me.status);
    } catch (e) {
      console.warn("[Market] getMe failed:", e);
    }
  }
}

function renderMarketView() {
  const loginPanel = document.getElementById("market-login-panel");
  const mainPanel  = document.getElementById("market-main-panel");
  if (marketSession.loggedIn) {
    loginPanel.style.display = "none";
    mainPanel.style.display  = "block";
    const badge = document.getElementById("market-user-badge");
    if (badge) badge.textContent = marketSession.userName ? `@${marketSession.userName}` : "";
  } else {
    loginPanel.style.display = "flex";
    mainPanel.style.display  = "none";
  }
}

async function fetchMarketOrders() {
  const listEl = document.getElementById("market-orders-list");
  listEl.innerHTML = `<div class="market-loading">Loading orders…</div>`;
  try {
    const result = await window.api.wfmGetOrders();
    if (result.error) {
      if (result.error.includes("Not logged") || result.error.includes("expired")) {
        marketSession = { loggedIn: false, userName: null, platform: "pc" };
        renderMarketView();
        return;
      }
      listEl.innerHTML = `<div class="market-error">${esc(result.error)}</div>`;
      return;
    }
    marketOrders = result;
    marketSelected.clear();
    renderOrdersList();
  } catch (e) {
    listEl.innerHTML = `<div class="market-error">${esc(e.message)}</div>`;
  }
}

function renderOrdersList() {
  const listEl = document.getElementById("market-orders-list");
  const orders = marketOrders[marketTypeTab] || [];
  updateBulkBar();

  if (!orders.length) {
    listEl.innerHTML = `<div class="market-empty">No ${marketTypeTab} orders. Click <strong>+ New Order</strong> to create one.</div>`;
    return;
  }

  listEl.innerHTML = orders.map(o => {
    const visClass   = o.visible ? "order-vis-on" : "order-vis-off";
    const visLabel   = o.visible ? "Visible" : "Hidden";
    const checked    = marketSelected.has(o.id) ? "checked" : "";
    const rankBadge  = o.modRank != null ? `<span class="order-rank-badge">R${o.modRank}</span>` : "";
    const thumb      = o.itemThumb ? `<img src="${esc(o.itemThumb)}" alt="${esc(o.itemName)}" class="order-item-thumb" loading="lazy">` : `<div class="order-item-thumb order-item-thumb-placeholder"></div>`;
    return `
      <div class="order-row" data-id="${esc(o.id)}">
        <input type="checkbox" class="order-checkbox" ${checked} title="Select for bulk action">
        <div class="order-item-info">
          ${thumb}
          <span class="order-item-name">${esc(o.itemName)}${rankBadge}</span>
        </div>
        <div class="order-meta">
          <span class="order-plat"><svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5.5"/><path d="M5 7h4M7 5v4"/></svg> ${esc(String(o.platinum))}</span>
          <span class="order-qty">x${esc(String(o.quantity))}</span>
          <span class="order-vis ${visClass}">${esc(visLabel)}</span>
        </div>
        <div class="order-actions">
          <button class="btn-sm btn-secondary order-edit-btn" data-id="${esc(o.id)}" title="Edit">Edit</button>
          <button class="btn-sm btn-danger   order-del-btn"  data-id="${esc(o.id)}" title="Delete">&times;</button>
        </div>
      </div>`;
  }).join("");

  // Bind checkbox
  listEl.querySelectorAll(".order-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.closest(".order-row")?.dataset.id;
      if (!id) return;
      if (cb.checked) marketSelected.add(id); else marketSelected.delete(id);
      updateBulkBar();
    });
  });

  // Bind edit
  listEl.querySelectorAll(".order-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id  = btn.dataset.id;
      const all = [...(marketOrders.sell || []), ...(marketOrders.buy || [])];
      const order = all.find(o => o.id === id);
      if (order) openOrderModal("edit", order);
    });
  });

  // Bind delete
  listEl.querySelectorAll(".order-del-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteOrder(btn.dataset.id));
  });
}

function updateBulkBar() {
  const bar   = document.getElementById("market-bulk-bar");
  const count = document.getElementById("market-bulk-count");
  const n     = marketSelected.size;
  bar.style.display = n > 0 ? "flex" : "none";
  if (count) count.textContent = `${n} selected`;
}

async function deleteOrder(orderId) {
  if (!orderId) return;
  if (!confirm("Delete this order?")) return;
  const result = await window.api.wfmDeleteOrder(orderId);
  if (result.error) { alert(`Delete failed: ${result.error}`); return; }
  // Remove from local state
  marketOrders.sell = marketOrders.sell.filter(o => o.id !== orderId);
  marketOrders.buy  = marketOrders.buy.filter(o => o.id !== orderId);
  marketSelected.delete(orderId);
  renderOrdersList();
}

// ─── Order modal ────────────────────────────────────────────────────────────

function openOrderModal(mode, order = null) {
  orderModalMode   = mode;
  orderModalEditId = order?.id || null;
  orderItemChoice  = null;

  const overlay  = document.getElementById("order-modal-overlay");
  const title    = document.getElementById("order-modal-title");
  const submitBtn = document.getElementById("order-modal-submit");
  const itemField = document.getElementById("order-item-field");
  const typeField = document.getElementById("order-type-field");
  const errorEl  = document.getElementById("order-modal-error");

  errorEl.style.display = "none";
  errorEl.textContent   = "";

  if (mode === "edit" && order) {
    title.textContent       = "Edit Order";
    submitBtn.textContent   = "Save Changes";
    itemField.style.display = "none";
    typeField.style.display = "none";
    document.getElementById("order-platinum").value = order.platinum;
    document.getElementById("order-quantity").value  = order.quantity;
    document.getElementById("order-visible").checked = order.visible;
    if (order.modRank != null) {
      document.getElementById("order-rank-field").style.display = "block";
      document.getElementById("order-rank").value = order.modRank;
    } else {
      document.getElementById("order-rank-field").style.display = "none";
    }
  } else {
    title.textContent       = "New Order";
    submitBtn.textContent   = "Create Order";
    itemField.style.display = "block";
    typeField.style.display = "block";
    document.getElementById("order-item-search").value = "";
    document.getElementById("order-item-selected").style.display = "none";
    document.getElementById("order-item-selected").innerHTML = "";
    document.getElementById("order-item-dropdown").style.display = "none";
    document.getElementById("order-item-dropdown").innerHTML = "";
    document.querySelectorAll("input[name='order-type']").forEach(r => { r.checked = r.value === "sell"; });
    document.getElementById("order-platinum").value = "";
    document.getElementById("order-quantity").value  = "1";
    document.getElementById("order-visible").checked = true;
    document.getElementById("order-rank-field").style.display = "none";
  }

  overlay.style.display = "flex";
}

function closeOrderModal() {
  document.getElementById("order-modal-overlay").style.display = "none";
  document.getElementById("order-item-dropdown").style.display = "none";
  clearTimeout(itemSearchTimer);
}

async function submitOrderModal(e) {
  e.preventDefault();
  const errorEl   = document.getElementById("order-modal-error");
  const submitBtn = document.getElementById("order-modal-submit");
  errorEl.style.display = "none";

  const platinum  = parseInt(document.getElementById("order-platinum").value, 10);
  const quantity  = parseInt(document.getElementById("order-quantity").value,  10);
  const visible   = document.getElementById("order-visible").checked;
  const rankInput = document.getElementById("order-rank");
  const modRank   = document.getElementById("order-rank-field").style.display !== "none"
    ? parseInt(rankInput.value, 10)
    : null;

  if (!Number.isFinite(platinum) || platinum < 1) {
    return showModalError("Price must be at least 1 platinum.");
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return showModalError("Quantity must be at least 1.");
  }

  submitBtn.disabled   = true;
  submitBtn.textContent = orderModalMode === "edit" ? "Saving…" : "Creating…";

  try {
    let result;
    if (orderModalMode === "edit") {
      const updates = { platinum, quantity, visible };
      if (modRank != null && !isNaN(modRank)) updates.modRank = modRank;
      result = await window.api.wfmUpdateOrder(orderModalEditId, updates);
    } else {
      if (!orderItemChoice) return showModalError("Please select an item.");
      const orderType = document.querySelector("input[name='order-type']:checked")?.value || "sell";
      result = await window.api.wfmCreateOrder({
        itemId:    orderItemChoice.id,
        orderType,
        platinum,
        quantity,
        visible,
        ...(modRank != null && !isNaN(modRank) ? { modRank } : {}),
      });
    }

    if (result.error) {
      return showModalError(result.error);
    }

    // Refresh orders
    await fetchMarketOrders();
    closeOrderModal();
  } catch (err) {
    showModalError(err.message);
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = orderModalMode === "edit" ? "Save Changes" : "Create Order";
  }
}

function showModalError(msg) {
  const el = document.getElementById("order-modal-error");
  el.textContent = msg;
  el.style.display = "block";
  // Re-enable submit
  const submitBtn = document.getElementById("order-modal-submit");
  submitBtn.disabled    = false;
  submitBtn.textContent = orderModalMode === "edit" ? "Save Changes" : "Create Order";
}

async function onItemSearchInput(e) {
  const q = e.target.value.trim();
  const dropdown = document.getElementById("order-item-dropdown");
  clearTimeout(itemSearchTimer);
  if (q.length < 2) { dropdown.style.display = "none"; return; }

  itemSearchTimer = setTimeout(async () => {
    const results = await window.api.wfmSearchItems(q, 15);
    if (!results || results.error || !results.length) {
      dropdown.style.display = "none";
      return;
    }
    dropdown.innerHTML = results.map(item => {
      const thumb = item.thumb ? `<img src="${esc(item.thumb)}" alt="" width="24" height="24" loading="lazy">` : `<span class="order-search-no-thumb"></span>`;
      return `<div class="market-item-result" data-item='${esc(JSON.stringify(item))}'>${thumb}<span>${esc(item.item_name)}</span></div>`;
    }).join("");
    dropdown.style.display = "block";

    dropdown.querySelectorAll(".market-item-result").forEach(row => {
      row.addEventListener("click", () => {
        try {
          orderItemChoice = JSON.parse(row.dataset.item);
          document.getElementById("order-item-search").value = "";
          dropdown.style.display = "none";
          const selEl = document.getElementById("order-item-selected");
          const t     = orderItemChoice.thumb ? `<img src="${esc(orderItemChoice.thumb)}" alt="" width="28" height="28" loading="lazy">` : "";
          selEl.innerHTML = `${t}<span>${esc(orderItemChoice.item_name)}</span><button type="button" id="clear-item-choice" class="order-clear-item">&times;</button>`;
          selEl.style.display = "flex";
          selEl.querySelector("#clear-item-choice")?.addEventListener("click", () => {
            orderItemChoice = null;
            selEl.style.display = "none";
            selEl.innerHTML = "";
          });
        } catch (err) { console.error("item parse error:", err); }
      });
    });
  }, 250);
}

function initMarketEventListeners() {
  // Login form
  document.getElementById("market-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email    = document.getElementById("market-email").value.trim();
    const password = document.getElementById("market-password").value;
    const errEl    = document.getElementById("market-login-error");
    const submitBtn = document.getElementById("market-login-submit");
    errEl.style.display = "none";
    submitBtn.disabled   = true;
    submitBtn.textContent = "Signing in…";
    try {
      const result = await window.api.wfmSignIn({ email, password });
      if (!result.loggedIn) {
        errEl.textContent = result.error || "Sign-in failed. Check your credentials.";
        errEl.style.display = "block";
      } else {
        marketSession = result;
        document.getElementById("market-password").value = "";
        renderMarketView();
        fetchMarketOrders();
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    } finally {
      submitBtn.disabled    = false;
      submitBtn.textContent = "Sign In";
    }
  });

  // Logout
  document.getElementById("market-logout-btn").addEventListener("click", async () => {
    await window.api.wfmSignOut();
    marketSession  = { loggedIn: false, userName: null, platform: "pc" };
    marketOrders   = { sell: [], buy: [] };
    marketSelected.clear();
    renderMarketView();
  });

  // Refresh
  document.getElementById("market-refresh-btn").addEventListener("click", fetchMarketOrders);

  // New order
  document.getElementById("market-new-order-btn").addEventListener("click", () => openOrderModal("create"));

  // Type tabs
  document.querySelectorAll("#market-type-tabs .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#market-type-tabs .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      marketTypeTab = tab.dataset.mtype;
      marketSelected.clear();
      renderOrdersList();
    });
  });

  // Bulk actions
  document.getElementById("market-bulk-show").addEventListener("click", async () => {
    if (!marketSelected.size) return;
    const ids = [...marketSelected];
    await window.api.wfmSetVisible(ids, true);
    await fetchMarketOrders();
  });
  document.getElementById("market-bulk-hide").addEventListener("click", async () => {
    if (!marketSelected.size) return;
    const ids = [...marketSelected];
    await window.api.wfmSetVisible(ids, false);
    await fetchMarketOrders();
  });
  document.getElementById("market-bulk-delete").addEventListener("click", async () => {
    if (!marketSelected.size) return;
    if (!confirm(`Delete ${marketSelected.size} order(s)?`)) return;
    const ids = [...marketSelected];
    for (const id of ids) await window.api.wfmDeleteOrder(id);
    await fetchMarketOrders();
  });
  document.getElementById("market-bulk-clear").addEventListener("click", () => {
    marketSelected.clear();
    renderOrdersList();
  });

  // Status buttons
  document.querySelectorAll(".status-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.status;
      if (!status || status === marketStatus) return;
      btn.disabled = true;
      try {
        await window.api.wfmSetStatus(status);
        updateStatusButtons(status);
      } catch (e) {
        console.error("[Market] setStatus failed:", e);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // WFM settings link
  document.getElementById("market-wfm-settings-link").addEventListener("click", (e) => {
    e.preventDefault();
    window.api.openExternal("https://warframe.market/profile/settings#password");
  });

  // Order modal close
  document.getElementById("order-modal-backdrop").addEventListener("click", closeOrderModal);
  document.getElementById("order-modal-close").addEventListener("click",   closeOrderModal);
  document.getElementById("order-modal-cancel").addEventListener("click",   closeOrderModal);

  // Order modal submit
  document.getElementById("order-modal-form").addEventListener("submit", submitOrderModal);

  // Item search in modal
  document.getElementById("order-item-search").addEventListener("input", onItemSearchInput);

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("order-item-dropdown");
    if (dropdown && !dropdown.contains(e.target) && e.target.id !== "order-item-search") {
      dropdown.style.display = "none";
    }
  });
}

// ─── Relic Planner ──────────────────────────────────────────────────

function parseOwnedRelics(data) {
  const owned = {};
  if (!data || !relicDb) return owned;
  for (const entry of (data.LevelKeys || [])) {
    const un    = entry.ItemType;
    const count = entry.ItemCount || 1;
    const info  = relicDb.byUniqueName[un];
    if (!info) continue;
    const { groupKey, quality } = info;
    if (!owned[groupKey]) owned[groupKey] = { intact: 0, exceptional: 0, flawless: 0, radiant: 0 };
    owned[groupKey][quality] = (owned[groupKey][quality] || 0) + count;
  }
  return owned;
}

/**
 * Expected value of the best pick from N independent draws from a relic's reward pool.
 * Uses the order-statistics formula: E[max_N] = Σ_j v_j * (CDF_j^N - CDF_{j-1}^N)
 * where CDF_j = P(single draw ≤ v_j).
 *
 * @param {{chance:number}[]} rewards - relic rewards array (chance in %)
 * @param {(number|null)[]} prices    - WFM prices aligned by index (null = unknown)
 * @param {number} N                  - number of players (1–4)
 * @returns {number} expected platinum value
 */
function computeSquadEV(rewards, prices, N) {
  const items = rewards.map((r, i) => ({
    prob:  r.chance / 100,
    price: prices[i] ?? 0,
  }));

  if (N <= 1) {
    return items.reduce((s, it) => s + it.prob * it.price, 0);
  }

  // Sort ascending, group items with identical prices into one bucket
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const grouped = [];
  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.price === item.price) {
      last.prob += item.prob;
    } else {
      grouped.push({ price: item.price, prob: item.prob });
    }
  }

  let ev = 0;
  let cdfPrev = 0;
  for (const g of grouped) {
    const cdfCur = Math.min(1, cdfPrev + g.prob);
    ev += g.price * (Math.pow(cdfCur, N) - Math.pow(cdfPrev, N));
    cdfPrev = cdfCur;
  }
  return ev;
}

// Fetch WFM price by slug directly (bypass name-to-slug mapping; uses shared cache).
// Returns a status object so callers can distinguish transient failures from real no-data.
async function fetchWfmPriceBySlug(slug) {
  if (!slug) return { status: "no_slug", slug, median: null };
  if (wfmPriceCache[slug] && (Date.now() - wfmPriceCache[slug].timestamp < 300000)) {
    return { ...wfmPriceCache[slug], status: "ok" };
  }
  try {
    const resp = await fetch(
      `https://api.warframe.market/v1/items/${slug}/statistics`,
      { headers: { Platform: "pc", Language: "en", Crossplay: "true", Accept: "application/json",
                   "Accept-Encoding": "identity", "User-Agent": "WarframeCompanion/1.0" } }
    );
    if (!resp.ok) {
      const transient = resp.status === 429 || resp.status >= 500 || resp.status === 408;
      return { status: transient ? "transient" : "no_data", slug, median: null };
    }
    const json = await resp.json();
    const payload = json?.payload;
    if (!payload) return { status: "no_data", slug, median: null };
    const closed  = payload.statistics_closed || {};
    const live    = payload.statistics_live   || {};
    const hours48 = closed["48hours"] || closed["48_hours"] || [];
    const live48  = live["48hours"]   || live["48_hours"]   || [];
    const rows = [...hours48, ...live48]
      .filter(x => !x.order_type || x.order_type === "sell")
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    const latest = rows.length ? rows[rows.length - 1] : null;
    const median = latest && (latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price);
    if (median != null) {
      const normalized = normalizePlatValue(median);
      if (normalized == null) return { status: "no_data", slug, median: null };
      const result = { median: normalized, slug, timestamp: Date.now() };
      wfmPriceCache[slug] = result;
      return { ...result, status: "ok" };
    }
    return { status: "no_data", slug, median: null };
  } catch (e) {
    console.warn(`[Relic] price fetch failed for ${slug}:`, e.message);
    return { status: "transient", slug, median: null };
  }
}

function clearWfmPriceCache() {
  for (const key of Object.keys(wfmPriceCache)) {
    delete wfmPriceCache[key];
  }
}

function refreshRelicPricingCache(force = false) {
  const now = Date.now();
  if (!force && relicLastPriceRefreshMs && (now - relicLastPriceRefreshMs) < RELIC_PRICE_REFRESH_MS) {
    return;
  }
  clearWfmPriceCache();
  relicGroupPriceCache.clear();
  relicGroupPricePending.clear();
  resetRelicEvState();
  relicLastPriceRefreshMs = now;
}

function relicEvCacheKeyFor(groupKey, squadSize, qualityMode) {
  return `${groupKey}|${squadSize}|${qualityMode}`;
}

function relicEvCacheKey(groupKey) {
  return relicEvCacheKeyFor(groupKey, relicSquadSize, relicQualityMode);
}

function getRelicQualityPool(group) {
  if (!group?.qualities) return [];
  if (relicQualityMode === "best") {
    return Object.entries(group.qualities).map(([quality, data]) => ({ quality, data }));
  }
  const data = group.qualities[relicQualityMode];
  return data ? [{ quality: relicQualityMode, data }] : [];
}

function resetRelicEvState() {
  relicEvCache.clear();
  relicEvNoDataCache.clear();
  relicEvPending.clear();
  relicEvWarmupToken++;
  relicEvWarmupRunning = false;
  relicEvWarmupComplete = false;
}

function syncRelicSelectors() {
  document.querySelectorAll("#relic-squad-filters-top .filter-tab").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.squadTop) === relicSquadSize);
  });
  document.querySelectorAll("#relic-quality-filters-top .filter-tab").forEach(btn => {
    btn.classList.toggle("active", (btn.dataset.rqualityTop || "best") === relicQualityMode);
  });
  document.querySelectorAll("#relic-squad-selector .relic-squad-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.squad) === relicSquadSize);
  });
}

function setRelicSquadSize(nextSize) {
  const parsed = Number(nextSize);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.max(1, Math.min(4, Math.floor(parsed)));
  if (clamped === relicSquadSize) {
    syncRelicSelectors();
    return;
  }

  relicSquadSize = clamped;
  syncRelicSelectors();
  if (currentView === "relics") renderRelicList();
  if (_openRelicGroup) {
    const activeQ = document.querySelector("#relic-quality-tabs .filter-tab.active");
    if (activeQ) renderRelicQualityRewards(_openRelicGroup, activeQ.dataset.rqual);
  }
}

function setRelicQualityMode(mode) {
  const allowed = new Set(["best", "intact", "exceptional", "flawless", "radiant"]);
  const next = (mode || "best").toLowerCase();
  if (!allowed.has(next)) return;
  if (next === relicQualityMode) {
    syncRelicSelectors();
    return;
  }

  relicQualityMode = next;
  syncRelicSelectors();
  if (currentView === "relics") renderRelicList();
}

async function computeRelicDisplayEv(group) {
  const cacheKey = relicEvCacheKey(group.key);
  if (relicEvCache.has(cacheKey)) return relicEvCache.get(cacheKey);

  const noDataTs = relicEvNoDataCache.get(cacheKey);
  if (noDataTs && (Date.now() - noDataTs) < RELIC_EV_NODATA_TTL_MS) return null;
  if (relicEvPending.has(cacheKey)) return null;

  if (relicGroupPricePending.has(group.key)) return null;

  relicEvPending.add(cacheKey);
  relicGroupPricePending.add(group.key);
  try {
    let snapshot = relicGroupPriceCache.get(group.key);
    if (!snapshot) {
      snapshot = { transient: false, qualities: {} };
      const qualityEntries = Object.entries(group?.qualities || {});
      for (const [qualityName, qualityData] of qualityEntries) {
        const rewards = qualityData?.rewards || [];
        const results = await Promise.all(
          rewards.map((r) => {
            if (!r?.urlName) return Promise.resolve({ status: "no_slug", median: null });
            return fetchWfmPriceBySlug(r.urlName);
          })
        );
        if (results.some((r) => r?.status === "transient")) snapshot.transient = true;

        const prices = results.map((r) => (r?.status === "ok" ? r.median : null));
        snapshot.qualities[qualityName] = {
          rewards,
          prices,
          hasAnyPrice: prices.some((p) => p != null),
        };
      }
      relicGroupPriceCache.set(group.key, snapshot);
    }

    // Derive all EV combinations from the same fetched reward price snapshot.
    const qualityModes = ["intact", "exceptional", "flawless", "radiant"];
    for (let squad = 1; squad <= 4; squad++) {
      let bestEv = null;

      for (const qm of qualityModes) {
        const qData = snapshot.qualities[qm];
        const qKey = relicEvCacheKeyFor(group.key, squad, qm);
        if (!qData || !qData.hasAnyPrice) {
          if (!snapshot.transient) relicEvNoDataCache.set(qKey, Date.now());
          continue;
        }

        const qEv = computeSquadEV(qData.rewards, qData.prices, squad);
        relicEvCache.set(qKey, qEv);
        relicEvNoDataCache.delete(qKey);
        if (bestEv == null || qEv > bestEv) bestEv = qEv;
      }

      const bestKey = relicEvCacheKeyFor(group.key, squad, "best");
      if (bestEv != null) {
        relicEvCache.set(bestKey, bestEv);
        relicEvNoDataCache.delete(bestKey);
      } else if (!snapshot.transient) {
        relicEvNoDataCache.set(bestKey, Date.now());
      }
    }

    return relicEvCache.get(cacheKey) ?? null;
  } finally {
    relicGroupPricePending.delete(group.key);
    relicEvPending.delete(cacheKey);
  }
}

async function warmRelicEvScores(groups) {
  if (relicEvWarmupRunning) return;

  relicEvWarmupRunning = true;
  relicEvWarmupComplete = false;
  const token = ++relicEvWarmupToken;

  try {
    // Process all unresolved relics in consecutive small batches,
    // then render once at the end so the grid does not keep jumping.
    for (;;) {
      if (token !== relicEvWarmupToken) return;

      const now = Date.now();
      const queue = [];
      for (const g of groups) {
        const key = relicEvCacheKey(g.key);
        if (relicEvCache.has(key) || relicEvPending.has(key)) continue;
        const noDataTs = relicEvNoDataCache.get(key);
        if (noDataTs && (now - noDataTs) < RELIC_EV_NODATA_TTL_MS) continue;
        queue.push(g);
        if (queue.length >= RELIC_EV_BATCH_SIZE) break;
      }

      if (!queue.length) break;

      const workers = Array.from({ length: RELIC_EV_WORKERS }, async () => {
        for (;;) {
          if (token !== relicEvWarmupToken) return;
          const group = queue.shift();
          if (!group) return;
          try {
            await computeRelicDisplayEv(group);
          } catch (err) {
            console.warn("[Relic] EV warmup failed for", group?.name || "unknown", err.message);
          }
        }
      });
      await Promise.all(workers);

      if (token === relicEvWarmupToken && currentView === "relics") {
        renderRelicList();
      }
    }
  } finally {
    if (token === relicEvWarmupToken) {
      relicEvWarmupRunning = false;
      relicEvWarmupComplete = true;
      if (currentView === "relics") renderRelicList();
    }
  }
}

async function loadRelicView() {
  if (!relicDb) {
    const el = document.getElementById("relic-grid");
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Loading relic database…</p></div>`;
    try {
      relicDb = await window.api.getRelicDatabase();
      relicOwnedCounts = parseOwnedRelics(inventoryData);
    } catch (err) {
      el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Failed to load relic database.</p></div>`;
      return;
    }
  }
  renderRelicList();
}

const RELIC_TIER_ORDER = { Lith: 0, Meso: 1, Neo: 2, Axi: 3, Requiem: 4 };

function renderRelicList() {
  if (!relicDb) return;
  const grid = document.getElementById("relic-grid");
  const showEv = true;
  const wantsEvSort = relicSortMode === "ev_desc" || relicSortMode === "ev_asc";
  const sortByEv = wantsEvSort;

  let groups = Object.values(relicDb.groups);
  if (relicTierFilter !== "all") groups = groups.filter(g => g.tier === relicTierFilter);
  if (relicSearch) {
    const q = relicSearch.toLowerCase();
    groups = groups.filter(g => g.name.toLowerCase().includes(q));
  }

  if (sortByEv) {
    const dir = relicSortMode === "ev_desc" ? -1 : 1;
    groups.sort((a, b) => {
      const aEv = relicEvCache.get(relicEvCacheKey(a.key));
      const bEv = relicEvCache.get(relicEvCacheKey(b.key));
      const aMissing = aEv == null;
      const bMissing = bEv == null;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (!aMissing && !bMissing && aEv !== bEv) return dir * (aEv - bEv);
      const ta = RELIC_TIER_ORDER[a.tier] ?? 99;
      const tb = RELIC_TIER_ORDER[b.tier] ?? 99;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
  } else {
    groups.sort((a, b) => {
      const ta = RELIC_TIER_ORDER[a.tier] ?? 99;
      const tb = RELIC_TIER_ORDER[b.tier] ?? 99;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
  }
  if (showEv && !relicEvWarmupRunning) warmRelicEvScores(groups);

  document.querySelector("#view-relics .view-header h2").textContent = `Relic Planner (${groups.length})`;

  if (!groups.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>No relics found</p></div>`;
    return;
  }

  grid.innerHTML = groups.map((g, idx) => {
    const owned      = relicOwnedCounts[g.key];
    const totalOwned = owned ? Object.values(owned).reduce((s, c) => s + c, 0) : 0;
    const tierCls    = fissureTierClass(g.tier);
    const iconSrc    = g.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default;
    const cacheKey   = relicEvCacheKey(g.key);
    const ev         = relicEvCache.get(cacheKey);
    const noDataTs   = relicEvNoDataCache.get(cacheKey);
    const hasFreshNoData = !!(noDataTs && (Date.now() - noDataTs) < RELIC_EV_NODATA_TTL_MS);
    const qLabel = relicQualityMode === "best"
      ? "Best"
      : (relicQualityMode === "exceptional" ? "Ex" : relicQualityMode.charAt(0).toUpperCase() + relicQualityMode.slice(1, 3));
    const valueLabel = ev != null ? `~${ev.toFixed(1)}p` : (hasFreshNoData ? "N/A" : "...");
    const evLabel    = `${qLabel} ${valueLabel}`;
    const evClass    = ev != null ? "has-value" : (hasFreshNoData ? "no-data" : "loading");
    return `
    <div class="relic-card" data-relic-idx="${idx}">
      <div class="relic-card-icon">
        <span class="relic-icon ${tierCls}">
          <img class="relic-icon-img" src="${esc(iconSrc)}" alt="${esc(g.name)}" loading="lazy">
        </span>
      </div>
      <div class="relic-card-body">
        <span class="relic-card-name">${esc(g.name)}</span>
        <span class="relic-card-tier tier-${tierCls}">${esc(g.tier)}</span>
      </div>
      ${showEv ? `<span class="relic-ev-badge ${evClass}">${esc(evLabel)}</span>` : ""}
      ${totalOwned > 0 ? `<span class="relic-owned-badge">×${totalOwned}</span>` : ""}
    </div>`;
  }).join("");

  grid._relicGroups = groups;
  grid.querySelectorAll(".relic-card").forEach(card => {
    card.addEventListener("click", () => {
      const group = grid._relicGroups[parseInt(card.dataset.relicIdx)];
      if (group) openRelicDetail(group);
    });
  });
  setupImageErrorHandlers();
}

function openRelicDetail(group) {
  _openRelicGroup = group;
  const overlay = document.getElementById("relic-detail-overlay");
  overlay.style.display = "flex";

  const tierCls = fissureTierClass(group.tier);
  const iconSrc = group.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default;
  document.getElementById("relic-detail-icon").innerHTML =
    `<span class="relic-icon ${tierCls}" style="width:52px;height:52px;">
       <img class="relic-icon-img" src="${esc(iconSrc)}" alt="${esc(group.name)}" style="width:52px;height:52px;">
     </span>`;

  document.getElementById("relic-detail-name").textContent = group.name;

  const owned = relicOwnedCounts[group.key] || {};
  const qualLabels = { intact: "Intact", exceptional: "Exceptional", flawless: "Flawless", radiant: "Radiant" };
  const ownedParts = Object.entries(qualLabels)
    .filter(([q]) => (owned[q] || 0) > 0)
    .map(([q, label]) => `<span class="relic-owned-pill">${label}: ×${owned[q]}</span>`);
  document.getElementById("relic-detail-owned").innerHTML =
    ownedParts.length ? ownedParts.join("") : `<span style="color:var(--text-muted)">None owned</span>`;

  const qualitiesAvail = ["intact", "exceptional", "flawless", "radiant"].filter(q => group.qualities[q]);
  const tabsEl = document.getElementById("relic-quality-tabs");
  tabsEl.innerHTML = qualitiesAvail.map((q, i) =>
    `<button class="filter-tab ${i === 0 ? "active" : ""}" data-rqual="${q}">${qualLabels[q]}</button>`
  ).join("");

  const firstQual = qualitiesAvail[0] || "intact";
  renderRelicQualityRewards(group, firstQual);

  tabsEl.querySelectorAll(".filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      tabsEl.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      renderRelicQualityRewards(group, tab.dataset.rqual);
    });
  });

  // Sync squad selector to current state and wire buttons
  const squadEl = document.getElementById("relic-squad-selector");
  squadEl.querySelectorAll(".relic-squad-btn").forEach(btn => {
    btn.onclick = () => setRelicSquadSize(btn.dataset.squad);
  });
  syncRelicSelectors();

  setupImageErrorHandlers();
}

async function renderRelicQualityRewards(group, quality) {
  const qualityData = group.qualities[quality];
  if (!qualityData) return;

  const listEl = document.getElementById("relic-rewards-list");
  const evEl   = document.getElementById("relic-ev-total");
  const qualLabel = { intact: "Intact", exceptional: "Exceptional", flawless: "Flawless", radiant: "Radiant" }[quality] || quality;

  function rarityClass(r) {
    const low = (r || "").toLowerCase();
    if (low === "rare") return "rarity-rare";
    if (low === "uncommon") return "rarity-uncommon";
    return "rarity-common";
  }

  function renderRows(rewards, prices) {
    // Per-row EV is always solo (price × chance) — it shows individual item contribution
    const rows = rewards.map((r, i) => {
      const price = prices ? prices[i] : null;
      const ev    = price != null ? (r.chance / 100) * price : null;
      const priceHtml = price != null
        ? `<span class="relic-plat">${price}p</span>`
        : `<span style="color:var(--text-muted)">-</span>`;
      const evHtml = ev != null ? `~${ev.toFixed(1)}p` : "";
      return `
      <div class="relic-reward-row">
        <span class="relic-reward-rarity ${rarityClass(r.rarity)}" title="${esc(r.rarity)}">${esc(r.rarity.charAt(0))}</span>
        <span class="relic-reward-name" title="${esc(r.name)}">${esc(r.name)}</span>
        <span class="relic-reward-chance">${r.chance}%</span>
        <span class="relic-reward-price">${priceHtml}</span>
        <span class="relic-reward-ev">${evHtml}</span>
      </div>`;
    }).join("");
    listEl.innerHTML = `
      <div class="relic-rewards-header">
        <span></span><span>Item</span><span style="text-align:right">Chance</span>
        <span style="text-align:right">Price</span><span style="text-align:right">E.V.</span>
      </div>
      ${rows}`;

    if (!prices) { evEl.innerHTML = "Loading prices…"; return; }

    const hasAnyPrice = prices.some(p => p != null);
    if (!hasAnyPrice) { evEl.innerHTML = `Expected value (${qualLabel}): <strong>N/A</strong> (no price data)`; return; }

    // Squad-adjusted EV using order-statistics formula
    const squadEV = computeSquadEV(rewards, prices, relicSquadSize);
    const squadLabel = relicSquadSize === 1
      ? "Solo"
      : `best of ${relicSquadSize}`;
    evEl.innerHTML = `Expected value (${qualLabel}, ${squadLabel}): <strong>~${squadEV.toFixed(1)} platinum</strong>`;
  }

  renderRows(qualityData.rewards, null);

  const prices = await Promise.all(
    qualityData.rewards.map(r =>
      r.urlName ? fetchWfmPriceBySlug(r.urlName).then(p => p?.median ?? null) : Promise.resolve(null)
    )
  );

  // Only update if the user hasn't switched to a different quality or relic
  const activeTab = document.querySelector("#relic-quality-tabs .filter-tab.active");
  if (activeTab && activeTab.dataset.rqual === quality && _openRelicGroup === group) {
    renderRows(qualityData.rewards, prices);
  }
}

function closeRelicDetail() {
  document.getElementById("relic-detail-overlay").style.display = "none";
  _openRelicGroup = null;
}

// ─── View Switching ──────────────────────────────────────────

function switchView(viewName) {
  if (!inventoryData && viewName !== "welcome" && viewName !== "world" && viewName !== "market" && viewName !== "relics" && viewName !== "settings") {
    viewName = "welcome";
  }
  currentView = viewName;
  document.querySelectorAll(".nav-btn[data-view]").forEach(btn => btn.classList.toggle("active", btn.dataset.view === viewName));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${viewName}`));
  if (viewName === "inventory") renderInventory();
  if (viewName === "foundry") renderFoundry();
  if (viewName === "resources") renderResources();
  if (viewName === "mastery") renderMastery();
  if (viewName === "world") loadWorldData();
  if (viewName === "market") loadMarketView();
  if (viewName === "relics") {
    refreshRelicPricingCache(false);
    loadRelicView();
  }
  if (viewName === "settings") loadOverlaySettingsPanel();
}

function onInventoryLoaded(data) {
  inventoryData = data;
  parsedItems = parseInventory(data);
  document.getElementById("status-text").innerHTML = `<span class="status-dot connected"></span> ${parsedItems.length} items loaded`;
  // Refresh relic owned counts if DB already loaded
  if (relicDb) relicOwnedCounts = parseOwnedRelics(data);
  switchView("inventory");
  loadMasteryData();
}

async function loadInventoryFromFile() {
  const data = await window.api.openInventoryFile();
  if (data) onInventoryLoaded(data);
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function esc(text) { const d = document.createElement("div"); d.textContent = text; return d.innerHTML; }

function formatNumber(num) {
  if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
  return num.toLocaleString();
}

function formatTimeRemaining(endDate) {
  const diff = endDate - new Date();
  if (diff <= 0) return "Ready!";
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

// ─── Init ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  // Debug toggle (persisted)
  setDebugModeUi(debugMode);
  try {
    await window.api.setDebugMode(debugMode);
  } catch (e) {
    console.error("Failed to set main-process debug mode:", e);
  }

  // Load item database
  try {
    itemDb = await window.api.getItemDatabase();
    console.log(`Item DB: ${Object.keys(itemDb).length} entries`);
  } catch (e) { console.error("Item DB failed:", e); }

  // Load warframe.market items (for trade links + price lookups)
  try {
    wfmItems = await window.api.getWfmItems();
    console.log(`WFM items: ${Object.keys(wfmItems).length} entries`);
  } catch (e) { console.error("WFM items failed:", e); }

  // Window controls
  document.getElementById("btn-minimize").addEventListener("click", () => window.api.minimizeWindow());
  document.getElementById("btn-maximize").addEventListener("click", () => window.api.maximizeWindow());
  document.getElementById("btn-close").addEventListener("click", () => window.api.closeWindow());
  document.getElementById("debug-toggle").addEventListener("click", async () => {
    setDebugModeUi(!debugMode);
    try {
      await window.api.setDebugMode(debugMode);
      debugLog("Toggle", `Debug mode set to ${debugMode ? "ON" : "OFF"}`);
      if (currentView === "inventory") renderInventory();
      if (currentView === "mastery") renderMastery();
    } catch (e) {
      console.error("Failed to toggle main-process debug mode:", e);
    }
  });

  // Navigation
  document.querySelectorAll(".nav-btn[data-view]").forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  document.getElementById("btn-load-inventory").addEventListener("click", loadInventoryFromFile);
  document.getElementById("btn-toggle-overlay").addEventListener("click", () => window.api.toggleOverlay());
  document.getElementById("btn-test-overlay").addEventListener("click", () => window.api.simulateRelicTrigger());
  document.getElementById("btn-load-apihelper").addEventListener("click", loadInventoryFromFile);
  document.getElementById("btn-load-manual").addEventListener("click", loadInventoryFromFile);

  const hotkeyToggle = document.getElementById("setting-overlay-hotkey-enabled");
  const hotkeyInput = document.getElementById("setting-overlay-hotkey");
  if (hotkeyToggle && hotkeyInput) {
    hotkeyToggle.addEventListener("change", () => {
      hotkeyInput.disabled = !hotkeyToggle.checked;
    });
  }
  document.getElementById("setting-overlay-save")?.addEventListener("click", async () => {
    await saveOverlaySettingsPanel();
  });
  document.getElementById("setting-overlay-reset")?.addEventListener("click", async () => {
    await resetOverlaySettingsPanel();
  });
  document.getElementById("setting-overlay-test")?.addEventListener("click", () => {
    window.api.simulateRelicTrigger();
    setOverlaySettingsStatus("Test trigger sent.");
  });
  loadOverlaySettingsPanel();

  // Relic price cache refreshes every 10 minutes.
  if (!relicPriceRefreshTimer) {
    relicPriceRefreshTimer = setInterval(() => {
      refreshRelicPricingCache(true);
      if (currentView === "relics") renderRelicList();
    }, RELIC_PRICE_REFRESH_MS);
  }

  // AlecaFrame
  document.getElementById("btn-load-alecaframe").addEventListener("click", async () => {
    const result = await window.api.loadAlecaFrame();
    if (result.success) { onInventoryLoaded(result.data); return; }
    document.getElementById("aleca-actions").style.display = "none";
    document.getElementById("aleca-fallback").style.display = "block";
    document.getElementById("aleca-status").innerHTML = `<span class="status-not-found">Auto-decrypt failed. Use the web parser instead:</span>`;
  });
  document.getElementById("btn-load-aleca-json").addEventListener("click", async () => {
    const data = await window.api.openAlecaFrameJson();
    if (data) onInventoryLoaded(data);
  });

  // Search & filter
  document.getElementById("inventory-search").addEventListener("input", e => { searchQuery = e.target.value; renderInventory(); });
  document.getElementById("resource-search").addEventListener("input", () => renderResources());
  document.getElementById("mastery-search").addEventListener("input", e => { masterySearchQuery = e.target.value; renderMastery(); });
  document.querySelectorAll("#inventory-filters .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#inventory-filters .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentFilter = tab.dataset.filter;
      renderInventory();
    });
  });
  document.querySelectorAll("#mastery-status-filters .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#mastery-status-filters .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      masteryStatusFilter = tab.dataset.mstatus;
      renderMastery();
    });
  });

  // Detail overlay close handlers
  document.getElementById("detail-backdrop").addEventListener("click", closeItemDetail);
  document.getElementById("detail-close").addEventListener("click", closeItemDetail);
  document.getElementById("comp-detail-backdrop").addEventListener("click", closeComponentDetail);
  document.getElementById("comp-detail-close").addEventListener("click", closeComponentDetail);
  document.getElementById("relic-detail-backdrop").addEventListener("click", closeRelicDetail);
  document.getElementById("relic-detail-close").addEventListener("click", closeRelicDetail);

  // Relic tier filter + search
  document.querySelectorAll("#relic-tier-filters .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#relic-tier-filters .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      relicTierFilter = tab.dataset.rtier;
      renderRelicList();
    });
  });
  document.querySelectorAll("#relic-sort-filters .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const nextSort = tab.dataset.rsort || "tier";

      document.querySelectorAll("#relic-sort-filters .filter-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      relicSortMode = nextSort;
      renderRelicList();
    });
  });
  document.querySelectorAll("#relic-squad-filters-top .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      setRelicSquadSize(tab.dataset.squadTop);
    });
  });
  document.querySelectorAll("#relic-quality-filters-top .filter-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      setRelicQualityMode(tab.dataset.rqualityTop || "best");
    });
  });
  document.getElementById("relic-search").addEventListener("input", e => {
    relicSearch = e.target.value;
    renderRelicList();
  });
  syncRelicSelectors();

  // Market event listeners
  initMarketEventListeners();

  // ESC key closes overlays
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (document.getElementById("order-modal-overlay").style.display !== "none") {
        closeOrderModal();
      } else if (document.getElementById("relic-detail-overlay").style.display !== "none") {
        closeRelicDetail();
      } else if (document.getElementById("comp-detail-overlay").style.display !== "none") {
        closeComponentDetail();
      } else if (document.getElementById("item-detail-overlay").style.display !== "none") {
        closeItemDetail();
      }
    }
  });

  // Live updates
  window.api.onInventoryUpdated(data => onInventoryLoaded(data));

  // Check AlecaFrame
  const aleca = await window.api.checkAlecaFrame();
  if (aleca.found) {
    const d = aleca.lastModified ? new Date(aleca.lastModified).toLocaleDateString() : "unknown";
    document.getElementById("aleca-status").innerHTML = `<span class="status-found">✓ Found AlecaFrame data (updated: ${d})</span>`;
    document.getElementById("aleca-actions").style.display = "block";
    document.getElementById("aleca-fallback").style.display = "block";
  } else {
    document.getElementById("aleca-status").innerHTML = `<span class="status-not-found">AlecaFrame not detected.</span>`;
    document.getElementById("aleca-actions").style.display = "none";
    document.getElementById("aleca-fallback").style.display = "none";
  }

  // Auto-load
  const existing = await window.api.getInventory();
  if (existing) onInventoryLoaded(existing);

  // Keep world countdowns fresh while avoiding frequent API fetches.
  setInterval(() => {
    if (currentView !== "world") return;
    const hasJustExpiredFissure = Array.isArray(worldData?.fissures) && worldData.fissures.some(f => {
      if (f?.expired) return false;
      const exp = parseIsoDate(f?.expiry)?.getTime() || 0;
      return exp > 0 && exp <= Date.now();
    });

    if (hasJustExpiredFissure && (Date.now() - worldLastFetch) > 5000) {
      loadWorldData(true);
      return;
    }

    if (!worldData || (Date.now() - worldLastFetch) > WORLD_REFRESH_MS) {
      loadWorldData();
    } else {
      renderWorld();
    }
  }, 1000);
});
