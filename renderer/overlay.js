// ── Relic Reward Overlay ──────────────────────────────────────────────
// AUTO-DETECT mode: on EE.log trigger the main process takes a screenshot,
// OCRs the reward screen, and sends matched items here via IPC.
// The overlay auto-populates 1-4 slots and fetches WFM prices instantly.
// If OCR fails (empty items array), slots switch to manual text-input mode.

// Price cache: urlName → { median, ts }
const priceCache = {};
const PRICE_TTL  = 5 * 60 * 1000;

// Per-slot state
const SLOTS = 4;
const slotState = Array.from({ length: SLOTS }, () => ({ item: null, price: null }));

// Item database for manual-mode autocomplete
let relicItems = [];

// ── Helpers ───────────────────────────────────────────────────────────

function rarityClass(r) {
  const low = (r || "").toLowerCase();
  if (low === "rare")     return "r-rare";
  if (low === "uncommon") return "r-uncommon";
  return "r-common";
}

async function fetchPrice(urlName) {
  if (!urlName) return null;
  const cached = priceCache[urlName];
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.median;

  try {
    const resp = await fetch(
      `https://api.warframe.market/v1/items/${urlName}/statistics`,
      { headers: { Platform: "pc", Language: "en", Crossplay: "true", Accept: "application/json" } }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const closed = json?.payload?.statistics_closed || {};
    const live   = json?.payload?.statistics_live   || {};
    const rows   = [
      ...(closed["48hours"] || closed["48_hours"] || []),
      ...(live["48hours"]   || live["48_hours"]   || []),
    ]
      .filter(x => !x.order_type || x.order_type === "sell")
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    const latest = rows.at(-1);
    const val = latest &&
      (latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price);
    if (val != null) {
      const median = Math.round(Math.abs(Number(val)));
      if (isFinite(median) && median > 0) {
        priceCache[urlName] = { median, ts: Date.now() };
        return median;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── DOM helpers ────────────────────────────────────────────────────────

function getSlotEl(idx) { return document.querySelector(`.reward-slot[data-slot="${idx}"]`); }

/** Render a slot from slotState[idx]. */
function renderSlot(idx) {
  const slotEl   = getSlotEl(idx);
  const nameEl   = slotEl.querySelector(".slot-name");
  const priceEl  = slotEl.querySelector(".slot-price");
  const rarEl    = slotEl.querySelector(".slot-rarity");

  const { item, price } = slotState[idx];

  slotEl.classList.remove("has-item", "best-slot", "empty-slot");

  if (!item) {
    slotEl.classList.add("empty-slot");
    nameEl.textContent  = "—";
    nameEl.className    = "slot-name empty";
    priceEl.textContent = "—";
    priceEl.className   = "slot-price muted";
    rarEl.textContent   = "";
    rarEl.className     = "slot-rarity";
    return;
  }

  slotEl.classList.add("has-item");
  nameEl.textContent  = item.name;
  nameEl.className    = "slot-name";
  rarEl.textContent   = (item.rarity || "C").charAt(0).toUpperCase();
  rarEl.className     = `slot-rarity ${rarityClass(item.rarity)}`;

  if (price == null) {
    priceEl.textContent = "…";
    priceEl.className   = "slot-price muted";
  } else if (price === 0) {
    priceEl.textContent = "N/A";
    priceEl.className   = "slot-price muted";
  } else {
    priceEl.textContent = `${price}p`;
    priceEl.className   = "slot-price";
  }
}

/** Highlight the highest-priced slot and update footer. */
function updateBestPick() {
  let bestIdx   = -1;
  let bestPrice = -1;

  slotState.forEach((s, i) => {
    getSlotEl(i).classList.remove("best-slot");
    if (s.price != null && s.price > bestPrice) { bestPrice = s.price; bestIdx = i; }
  });

  const bestEl = document.getElementById("best-value");
  if (bestIdx >= 0 && slotState[bestIdx].item) {
    getSlotEl(bestIdx).classList.add("best-slot");
    bestEl.textContent = `${slotState[bestIdx].item.name} — ${bestPrice}p`;
  } else {
    bestEl.textContent = "Detecting…";
  }
}

// ── Scanning state ─────────────────────────────────────────────────────

function showScanning() {
  document.getElementById("scanning-state").classList.add("visible");
  document.getElementById("slots-grid").style.display = "none";
  document.getElementById("manual-notice").classList.remove("visible");
  document.getElementById("header-sub").textContent = "Detecting…";
  document.getElementById("best-value").textContent  = "Detecting…";
  // Reset state
  for (let i = 0; i < SLOTS; i++) slotState[i] = { item: null, price: null };
}

// ── Auto-detect mode: populate slots from OCR results ──────────────────

/**
 * Fired when main process sends `relic-reward-items`.
 * items: [{name, urlName, rarity}] (0-4 entries)
 * Empty array = OCR ran but found nothing → show manual input fallback.
 */
async function applyItems(items) {
  // Hide spinner, show grid
  document.getElementById("scanning-state").classList.remove("visible");
  document.getElementById("slots-grid").style.display = "";

  const manualMode = !items || items.length === 0;

  // Show manual notice if detection failed
  document.getElementById("manual-notice").classList.toggle("visible", manualMode);

  // Populate slots (up to 4)
  for (let i = 0; i < SLOTS; i++) {
    const item = items && items[i] ? items[i] : null;
    slotState[i].item  = item;
    slotState[i].price = null;

    const slotEl = getSlotEl(i);
    const input  = slotEl.querySelector(".slot-input");
    const nameEl = slotEl.querySelector(".slot-name");

    if (manualMode) {
      // Show text input, hide name div
      input.classList.add("visible");
      nameEl.style.display = "none";
      input.value = "";
    } else {
      // Hide text input, show auto-detected name
      input.classList.remove("visible");
      nameEl.style.display = "";
    }

    renderSlot(i);
  }

  updateBestPick();
  document.getElementById("header-sub").textContent =
    manualMode ? "Detection failed — manual mode" : `${items.length} item(s) found`;

  if (manualMode) {
    // Focus first input in manual mode
    const first = document.querySelector(".slot-input.visible");
    if (first) first.focus();
    return;
  }

  // Auto-fetch prices for all detected items
  await Promise.all(items.slice(0, SLOTS).map(async (item, i) => {
    if (!item?.urlName) { slotState[i].price = 0; renderSlot(i); updateBestPick(); return; }
    const price = await fetchPrice(item.urlName);
    slotState[i].price = price ?? 0;
    renderSlot(i);
    updateBestPick();
  }));
}

// ── Manual mode: text-input autocomplete ───────────────────────────────

let manualTimers = Array(SLOTS).fill(null);

function bestMatch(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  return relicItems.find(i => i.name.toLowerCase().startsWith(q))
      || relicItems.find(i => i.name.toLowerCase().includes(q))
      || null;
}

async function onManualInput(idx) {
  const input = getSlotEl(idx).querySelector(".slot-input");
  const match = bestMatch(input.value);

  slotState[idx].item  = match;
  slotState[idx].price = null;
  renderSlot(idx);
  updateBestPick();

  if (!match?.urlName) return;

  const price = await fetchPrice(match.urlName);
  if (slotState[idx].item?.name === match.name) {
    slotState[idx].price = price ?? 0;
    renderSlot(idx);
    updateBestPick();
  }
}

// ── Init ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("btn-close").addEventListener("click", () => window.overlay.close());
  document.addEventListener("keydown", e => { if (e.key === "Escape") window.overlay.close(); });

  // Wire manual-input events on all slots
  document.querySelectorAll(".reward-slot").forEach(slotEl => {
    const idx   = Number(slotEl.dataset.slot);
    const input = slotEl.querySelector(".slot-input");

    input.addEventListener("input", () => {
      clearTimeout(manualTimers[idx]);
      manualTimers[idx] = setTimeout(() => onManualInput(idx), 180);
    });

    input.addEventListener("keydown", e => {
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        // Move to next visible input
        const inputs = [...document.querySelectorAll(".slot-input.visible")];
        const ci = inputs.indexOf(input);
        if (ci >= 0) inputs[(ci + 1) % inputs.length]?.focus();
      }
    });
  });

  // Load relic items for manual-mode autocomplete (background, non-blocking)
  window.overlay.getRelicItems().then(items => { relicItems = items || []; }).catch(() => {});

  // EE.log trigger → show scanning spinner
  window.overlay.onTrigger(showScanning);

  // OCR results arrive → populate slots or show manual mode
  window.overlay.onItems(applyItems);
});
