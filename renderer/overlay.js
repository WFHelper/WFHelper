const SLOTS = 4;
const RECOMMENDATION_ROWS = 6;

const slotState = Array.from({ length: SLOTS }, () => ({ item: null, price: null }));

function rarityClass(rarity) {
  const low = String(rarity || "").toLowerCase();
  if (low === "rare") return "r-rare";
  if (low === "uncommon") return "r-uncommon";
  return "r-common";
}

async function fetchPrice(urlName) {
  if (!urlName) return null;

  try {
    const raw = await window.overlay.getPrice(urlName);
    const median = Math.round(Math.abs(Number(raw)));
    if (Number.isFinite(median) && median > 0) {
      return median;
    }
  } catch {
    // ignore IPC/network failure and show N/A in UI
  }

  return null;
}

function slotElement(index) {
  return document.querySelector(`.reward-slot[data-slot="${index}"]`);
}

function plannerGridElement() {
  return document.getElementById("planner-grid");
}

function setHeader(title, sub) {
  const titleEl = document.getElementById("header-title");
  const subEl = document.getElementById("header-sub");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
}

function setScanningText(text) {
  const el = document.getElementById("scanning-text");
  if (el) el.textContent = text;
}

function showBestFooter(show) {
  const footer = document.getElementById("best-footer");
  if (!footer) return;
  footer.classList.toggle("is-hidden", !show);
}

function showScanning() {
  document.getElementById("scanning-state").classList.add("visible");
  document.getElementById("slots-grid").classList.add("is-hidden");
  plannerGridElement().classList.add("is-hidden");
  document.getElementById("error-banner").classList.remove("visible");
}

function hideScanning() {
  document.getElementById("scanning-state").classList.remove("visible");
}

function renderSlot(index) {
  const slotEl = slotElement(index);
  const nameEl = slotEl.querySelector(".slot-name");
  const priceEl = slotEl.querySelector(".slot-price");
  const rarityEl = slotEl.querySelector(".slot-rarity");
  const { item, price } = slotState[index];

  slotEl.classList.remove("has-item", "best-slot", "empty-slot");

  if (!item) {
    slotEl.classList.add("empty-slot");
    nameEl.textContent = "-";
    nameEl.className = "slot-name empty";
    priceEl.textContent = "-";
    priceEl.className = "slot-price muted";
    rarityEl.textContent = "";
    rarityEl.className = "slot-rarity";
    return;
  }

  slotEl.classList.add("has-item");
  nameEl.textContent = item.name;
  nameEl.className = "slot-name";
  rarityEl.textContent = String(item.rarity || "C")
    .charAt(0)
    .toUpperCase();
  rarityEl.className = `slot-rarity ${rarityClass(item.rarity)}`;

  if (price == null) {
    priceEl.textContent = "...";
    priceEl.className = "slot-price muted";
  } else if (price <= 0) {
    priceEl.textContent = "N/A";
    priceEl.className = "slot-price muted";
  } else {
    priceEl.textContent = `${price}p`;
    priceEl.className = "slot-price";
  }
}

function updateBestPick() {
  let bestIndex = -1;
  let bestPrice = -1;

  for (let i = 0; i < SLOTS; i += 1) {
    slotElement(i).classList.remove("best-slot");
    if (slotState[i].item && slotState[i].price != null && slotState[i].price > bestPrice) {
      bestPrice = slotState[i].price;
      bestIndex = i;
    }
  }

  const bestEl = document.getElementById("best-value");
  if (bestIndex >= 0) {
    slotElement(bestIndex).classList.add("best-slot");
    bestEl.textContent = `${slotState[bestIndex].item.name} - ${bestPrice}p`;
  } else {
    bestEl.textContent = "No priced rewards yet";
  }
}

function resetSlots() {
  for (let i = 0; i < SLOTS; i += 1) {
    slotState[i] = { item: null, price: null };
    renderSlot(i);
  }
  updateBestPick();
}

function resetPlannerRows() {
  const container = plannerGridElement();
  container.innerHTML = "";
  for (let i = 0; i < RECOMMENDATION_ROWS; i += 1) {
    const card = document.createElement("div");
    card.className = "plan-card empty";

    const title = document.createElement("div");
    title.className = "plan-title";
    title.textContent = "-";

    const profit = document.createElement("div");
    profit.className = "plan-profit";
    profit.textContent = "E. profits: -";

    card.appendChild(title);
    card.appendChild(profit);
    container.appendChild(card);
  }
}

function showRewardModeScanning() {
  setHeader("◆ Relic Reward", "Detecting...");
  setScanningText("Reading reward screen...");
  showScanning();
  showBestFooter(true);
  resetSlots();
  document.getElementById("best-value").textContent = "Detecting...";
}

function showPlannerModeScanning() {
  setHeader("◆ Relic Planner", "Reading relic selection...");
  setScanningText("Detecting relic era and ranking owned relics...");
  showScanning();
  showBestFooter(false);
  resetPlannerRows();
}

function showDetectionError(message) {
  hideScanning();
  document.getElementById("slots-grid").classList.remove("is-hidden");
  plannerGridElement().classList.add("is-hidden");
  document.getElementById("error-banner").classList.add("visible");
  document.getElementById("error-banner").textContent =
    message ||
    "OCR failed to detect reward items from the current screen. Use Warframe Borderless Windowed mode and set in-game UI scale to 99%.";
  resetSlots();
  setHeader("◆ Relic Reward", "Detection failed");
  document.getElementById("best-value").textContent = "OCR failed";
  showBestFooter(true);
}

function formatProfit(value, suffix) {
  if (!Number.isFinite(Number(value))) return `-${suffix}`;
  return `${Number(value).toFixed(1)}${suffix}`;
}

function renderPlannerRows(payload) {
  const era = String(payload?.era || "").trim();
  const rows = Array.isArray(payload?.rows) ? payload.rows.slice(0, RECOMMENDATION_ROWS) : [];

  hideScanning();
  document.getElementById("slots-grid").classList.add("is-hidden");
  plannerGridElement().classList.remove("is-hidden");
  const emptyMessage = era
    ? "No owned relic recommendations found for the detected era."
    : "Could not detect relic era from relic tile text. Use Warframe Borderless Windowed mode and set in-game UI scale to 99%.";
  document.getElementById("error-banner").classList.toggle("visible", rows.length === 0);
  document.getElementById("error-banner").textContent =
    rows.length === 0 ? emptyMessage : "OCR failed to detect reward items from the current screen.";

  const eraLabel = era ? `${era.charAt(0).toUpperCase()}${era.slice(1)} era` : "Owned relics";
  setHeader("◆ Relic Planner", `${eraLabel} recommendations`);
  showBestFooter(false);

  const container = plannerGridElement();
  container.innerHTML = "";

  const bestPlat = Math.max(...rows.map((row) => Number(row?.platEv || -1)), -1);

  for (let i = 0; i < RECOMMENDATION_ROWS; i += 1) {
    const row = rows[i] || null;
    const card = document.createElement("div");
    card.className = "plan-card";

    const title = document.createElement("div");
    title.className = "plan-title";

    const profit = document.createElement("div");
    profit.className = "plan-profit";

    if (!row) {
      card.classList.add("empty");
      title.textContent = "-";
      profit.textContent = "E. profits: -";
    } else {
      const platEv = Number(row.platEv);
      const ducatEv = Number(row.ducatEv);
      if (Number.isFinite(platEv) && platEv === bestPlat && bestPlat >= 0) {
        card.classList.add("best");
      }

      title.textContent = String(row.label || row.relicName || "-");

      const label = document.createElement("span");
      label.className = "plan-profit-label";
      label.textContent = "E. profits:";

      const plat = document.createElement("span");
      plat.className = "plan-profit-plat";
      plat.textContent = `${formatProfit(platEv, "p")} ◉`;

      const ducat = document.createElement("span");
      ducat.className = "plan-profit-ducat";
      ducat.textContent = `${formatProfit(ducatEv, "d")} ❦`;

      profit.appendChild(label);
      profit.appendChild(plat);
      profit.appendChild(ducat);
    }

    card.appendChild(title);
    card.appendChild(profit);
    container.appendChild(card);
  }
}

async function applyRewardItems(items) {
  const detectedItems = Array.isArray(items) ? items.filter(Boolean).slice(0, SLOTS) : [];

  if (detectedItems.length === 0) {
    showDetectionError();
    return;
  }

  hideScanning();
  document.getElementById("slots-grid").classList.remove("is-hidden");
  plannerGridElement().classList.add("is-hidden");
  document.getElementById("error-banner").classList.remove("visible");
  setHeader("◆ Relic Reward", `${detectedItems.length} item(s) found`);
  showBestFooter(true);

  for (let i = 0; i < SLOTS; i += 1) {
    const item = detectedItems[i] || null;
    slotState[i].item = item;
    slotState[i].price = null;
    renderSlot(i);
  }

  updateBestPick();

  await Promise.all(
    detectedItems.map(async (item, index) => {
      if (!item?.urlName) {
        slotState[index].price = 0;
        renderSlot(index);
        updateBestPick();
        return;
      }

      const price = await fetchPrice(item.urlName);
      slotState[index].price = price ?? 0;
      renderSlot(index);
      updateBestPick();
    }),
  );
}

function applyThemeVars(rawVars) {
  if (!rawVars || typeof rawVars !== "object") return;
  const vars = rawVars;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith("--")) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    root.style.setProperty(key, value.trim());
  }
}

function loadThemeFromStorageFallback() {
  try {
    const raw = localStorage.getItem("wf_theme_settings");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const colors = parsed?.colors;
    if (!colors || typeof colors !== "object") return;

    const map = {
      "--bg-deep": colors.bgDeep,
      "--bg-base": colors.bgBase,
      "--bg-surface": colors.bgSurface,
      "--bg-raised": colors.bgRaised,
      "--accent": colors.accent,
      "--accent-dim": colors.accentDim,
      "--accent-bright": colors.accentBright,
      "--text-primary": colors.textPrimary,
      "--text-secondary": colors.textSecondary,
      "--text-muted": colors.textMuted,
      "--border": colors.border,
      "--border-strong": colors.borderStrong,
    };

    applyThemeVars(map);
  } catch {
    // ignore malformed local storage
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadThemeFromStorageFallback();

  document.getElementById("btn-close").addEventListener("click", () => window.overlay.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.overlay.close();
    }
  });

  resetSlots();
  resetPlannerRows();
  showRewardModeScanning();

  window.overlay.onTrigger(showRewardModeScanning);
  window.overlay.onPlannerTrigger(showPlannerModeScanning);
  window.overlay.onItems((items) => {
    void applyRewardItems(items);
  });
  window.overlay.onRecommendations((payload) => {
    renderPlannerRows(payload);
  });
  window.overlay.onThemeVars((vars) => {
    applyThemeVars(vars);
  });
});
