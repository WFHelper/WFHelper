const SLOTS = 4;
const slotState = Array.from({ length: SLOTS }, () => ({ item: null, price: null }));
let overlayInteractiveMode = false;

function setOverlayInteractiveMode(interactive) {
  overlayInteractiveMode = !!interactive;
  const closeButton = document.getElementById("btn-close");
  if (!closeButton) return;
  closeButton.classList.toggle("is-hidden", !overlayInteractiveMode);
}

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
}

function showRewardModeScanning() {
  setHeader("◆ Relic Reward", "Detecting...");
  setScanningText("Reading reward screen...");
  showScanning();
  showBestFooter(true);
  resetSlots();
  document.getElementById("best-value").textContent = "Detecting...";
}

function plannerHintElement() {
  return document.getElementById("planner-hint");
}

function showPlannerHint(show) {
  const hint = plannerHintElement();
  if (!hint) return;
  hint.classList.toggle("is-hidden", !show);
}

function showPlannerModeScanning() {
  setHeader("◆ Relic Planner", "Reading relic selection...");
  setScanningText("Detecting relic era and ranking owned relics...");
  showScanning();
  showBestFooter(false);
  showPlannerHint(false);
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
  const confidence = Number(payload?.detection?.confidence || 0);
  const detectionElapsedMs = Number(payload?.detection?.elapsedMs || 0);
  const totalOwnedCount = Number(payload?.totalOwnedCount || 0);
  const rows = Array.isArray(payload?.rows) ? payload.rows.filter(Boolean) : [];

  hideScanning();
  document.getElementById("slots-grid").classList.add("is-hidden");
  plannerGridElement().classList.remove("is-hidden");
  const errorBanner = document.getElementById("error-banner");
  const emptyMessage = era
    ? "No owned relic recommendations found for the detected era."
    : `Could not detect relic era yet (OCR ${Math.round(Math.max(0, detectionElapsedMs))}ms, confidence ${confidence.toFixed(2)}).`;
  errorBanner.classList.toggle("visible", rows.length === 0);
  errorBanner.classList.toggle("info", rows.length === 0 && !era);
  errorBanner.textContent = rows.length === 0 ? emptyMessage : "";

  const countLabel = totalOwnedCount > 0 ? `${totalOwnedCount}` : "";
  const eraLabel = era ? `${era.charAt(0).toUpperCase()}${era.slice(1)} era` : "";
  setHeader(countLabel || "", eraLabel ? `${eraLabel} recommendations` : "Recommended relics");
  showBestFooter(false);
  showPlannerHint(!overlayInteractiveMode);

  const container = plannerGridElement();
  container.innerHTML = "";

  const bestPlat = Math.max(...rows.map((row) => Number(row?.platEv || -1)), -1);

  for (const row of rows) {
    if (!row) continue;
    const card = document.createElement("div");
    card.className = "plan-card";

    const platEv = Number(row.platEv);
    const ducatEv = Number(row.ducatEv);
    if (Number.isFinite(platEv) && platEv === bestPlat && bestPlat >= 0) {
      card.classList.add("best");
    }

    const title = document.createElement("div");
    title.className = "plan-title";
    title.textContent = String(row.label || row.relicName || "-");

    const profit = document.createElement("div");
    profit.className = "plan-profit";

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

const SAFE_COLOR_FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|oklch)\(\s*[-+0-9.%\s,/]+\)$/i;
const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function safeThemeColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96 || /[;{}]/.test(trimmed)) return null;
  return SAFE_HEX_COLOR_RE.test(trimmed) || SAFE_COLOR_FUNCTION_RE.test(trimmed) ? trimmed : null;
}

function setThemeColor(map, key, value) {
  const color = safeThemeColor(value);
  if (color) map[key] = color;
}

function hexToAccentGlow(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
  if (!match) return null;
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  if (![r, g, b].every(Number.isFinite)) return null;
  return `rgba(${r}, ${g}, ${b}, 0.15)`;
}

function loadThemeFromStorageFallback() {
  try {
    const raw = localStorage.getItem("wf_theme_settings");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const colors = parsed?.colors;
    const fontSizes = parsed?.fontSizes;
    if (!colors || typeof colors !== "object") return;

    const map = {
      "--font-display": '"Rajdhani", sans-serif',
      "--font-body": '"Barlow", sans-serif',
    };

    setThemeColor(map, "--bg-deep", colors.bgDeep);
    setThemeColor(map, "--bg-base", colors.bgBase);
    setThemeColor(map, "--bg-surface", colors.bgSurface);
    setThemeColor(map, "--bg-raised", colors.bgRaised);
    setThemeColor(map, "--bg-hover", colors.bgHover);
    setThemeColor(map, "--accent", colors.accent);
    setThemeColor(map, "--accent-dim", colors.accentDim);
    setThemeColor(map, "--accent-bright", colors.accentBright);
    setThemeColor(map, "--text-primary", colors.textPrimary);
    setThemeColor(map, "--text-secondary", colors.textSecondary);
    setThemeColor(map, "--text-muted", colors.textMuted);
    setThemeColor(map, "--success", colors.success);
    setThemeColor(map, "--warning", colors.warning);
    setThemeColor(map, "--danger", colors.danger);
    setThemeColor(map, "--info", colors.info);
    setThemeColor(map, "--border", colors.border);
    setThemeColor(map, "--border-strong", colors.borderStrong);

    const glow = hexToAccentGlow(colors.accent);
    if (glow) {
      map["--accent-glow"] = glow;
    }

    if (fontSizes && typeof fontSizes === "object") {
      if (typeof fontSizes.headingSize === "number" && Number.isFinite(fontSizes.headingSize)) {
        map["--font-heading-size"] = `${fontSizes.headingSize}rem`;
      }
      if (typeof fontSizes.bodySize === "number" && Number.isFinite(fontSizes.bodySize)) {
        map["--font-body-size"] = `${fontSizes.bodySize}rem`;
      }
      if (typeof fontSizes.smallSize === "number" && Number.isFinite(fontSizes.smallSize)) {
        map["--font-small-size"] = `${fontSizes.smallSize}rem`;
      }
    }

    applyThemeVars(map);
  } catch {
    // ignore malformed local storage
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadThemeFromStorageFallback();
  void window.overlay
    .getThemeVars()
    .then((vars) => {
      applyThemeVars(vars);
    })
    .catch(() => {
      // best effort, storage fallback already applied
    });

  document.getElementById("btn-close").addEventListener("click", () => window.overlay.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.overlay.close();
    }
  });

  resetSlots();
  resetPlannerRows();
  showRewardModeScanning();
  setOverlayInteractiveMode(false);

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
  window.overlay.onInteractionMode((payload) => {
    setOverlayInteractiveMode(Boolean(payload?.interactive));
    showPlannerHint(
      !overlayInteractiveMode && !plannerGridElement().classList.contains("is-hidden"),
    );
  });
});
