const SLOTS = 4;
const OCR_UNAVAILABLE_MESSAGE =
  "Windows OCR is not installed on this PC, so screen scanning cannot work. " +
  "In Windows Settings > Time & Language > Language, install your language's " +
  "features (or add English), then restart WFHelper.";
const slotState = Array.from({ length: SLOTS }, () => ({
  item: null,
  price: null,
  setPrice: null,
}));
let overlayInteractiveMode = false;
let rewardGeneration = 0;
const PLATINUM_ICON = "../assets/Platinum.png";
const DUCAT_ICON = "../assets/OrokinDucats.png";

function setOverlayInteractiveMode(interactive) {
  overlayInteractiveMode = !!interactive;
  document.documentElement.classList.toggle("is-overlay-interactive", overlayInteractiveMode);
  const closeButton = document.getElementById("btn-close");
  if (!closeButton) return;
  closeButton.classList.toggle("is-hidden", !overlayInteractiveMode);
  if (!overlayInteractiveMode) {
    document.documentElement.classList.remove("is-overlay-dragging");
  }
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

function formatCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? String(Math.floor(count)) : "0";
}

function appendMetaChip(container, text, tone) {
  if (!text) return;
  const chip = document.createElement("span");
  chip.className = `slot-meta-chip ${tone || ""}`.trim();
  chip.textContent = text;
  container.appendChild(chip);
}

function appendCurrencyValue(container, className, iconSrc, value, label) {
  const wrapper = document.createElement("span");
  wrapper.className = className;
  wrapper.title = label;

  const icon = document.createElement("img");
  icon.src = iconSrc;
  icon.alt = "";
  wrapper.appendChild(icon);

  const text = document.createElement("span");
  text.textContent = value;
  wrapper.appendChild(text);

  container.appendChild(wrapper);
}

function renderSlotValues(container, price, ducats) {
  container.innerHTML = "";
  container.className = "slot-price slot-values";

  const hasPrice = Number.isFinite(Number(price)) && Number(price) > 0;
  const ducatCount = Number(ducats);
  const hasDucats = Number.isFinite(ducatCount) && ducatCount > 0;

  if (!hasPrice && !hasDucats) {
    container.textContent = price == null ? "..." : "N/A";
    container.classList.add("muted");
    return;
  }

  if (hasPrice) {
    appendCurrencyValue(
      container,
      "slot-currency-value slot-plat-value",
      PLATINUM_ICON,
      String(Math.round(Number(price))),
      "Platinum",
    );
  }

  if (hasDucats) {
    appendCurrencyValue(
      container,
      "slot-currency-value slot-ducat-value",
      DUCAT_ICON,
      String(Math.floor(ducatCount)),
      "Ducats",
    );
  }
}

function appendSetParts(container, parts) {
  const visibleParts = Array.isArray(parts) ? parts.filter(Boolean).slice(0, 6) : [];
  if (visibleParts.length === 0) return;

  const row = document.createElement("div");
  row.className = "slot-set-parts";

  for (const part of visibleParts) {
    const required = Number(part.requiredCount);
    const owned = Number(part.ownedCount);
    const ok =
      Number.isFinite(required) && required > 0 && Number.isFinite(owned) && owned >= required;
    const chip = document.createElement("span");
    chip.className = `slot-set-part ${ok ? "owned" : "missing"}`;
    chip.title = `${part.name || "Part"}: ${formatCount(part.ownedCount)}/${formatCount(part.requiredCount)}`;

    if (part.imageUrl) {
      const img = document.createElement("img");
      img.src = part.imageUrl;
      img.alt = "";
      chip.appendChild(img);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "slot-set-part-fallback";
      fallback.textContent = String(part.name || "?")
        .charAt(0)
        .toUpperCase();
      chip.appendChild(fallback);
    }

    const count = document.createElement("span");
    count.className = "slot-set-part-count";
    count.textContent = `${formatCount(part.ownedCount)}/${formatCount(part.requiredCount)}`;
    chip.appendChild(count);
    row.appendChild(chip);
  }

  container.appendChild(row);
}

function plannerGridElement() {
  return document.getElementById("planner-grid");
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
  const metaEl = slotEl.querySelector(".slot-meta");
  const { item, price, setPrice } = slotState[index];

  slotEl.classList.remove("has-item", "best-slot", "empty-slot");
  metaEl.innerHTML = "";

  if (!item) {
    slotEl.classList.add("empty-slot");
    nameEl.textContent = "-";
    nameEl.className = "slot-name empty";
    priceEl.textContent = "-";
    priceEl.className = "slot-price slot-values muted";
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

  renderSlotValues(priceEl, price, item.ducats);

  const partRequired = Number(item.partRequiredCount);
  if (Number.isFinite(partRequired) && partRequired > 0) {
    appendMetaChip(
      metaEl,
      `Own ${formatCount(item.partOwnedCount)}/${formatCount(partRequired)}`,
      "owned",
    );
  }

  const setRequired = Number(item.setRequiredCount);
  if (Number.isFinite(setRequired) && setRequired > 0) {
    appendMetaChip(
      metaEl,
      `Set ${formatCount(item.setOwnedCount)}/${formatCount(setRequired)}`,
      "set",
    );
  }

  if (item.setUrlName) {
    const setText = setPrice == null ? "Set ..." : setPrice > 0 ? `Set ${setPrice}p` : "Set N/A";
    appendMetaChip(metaEl, setText, "set-price");
  }

  appendSetParts(metaEl, item.setParts);
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
  bestEl.innerHTML = "";
  if (bestIndex >= 0) {
    slotElement(bestIndex).classList.add("best-slot");
    const name = document.createElement("span");
    name.textContent = `${slotState[bestIndex].item.name} - `;
    bestEl.appendChild(name);
    appendCurrencyValue(
      bestEl,
      "footer-currency-value footer-plat-value",
      PLATINUM_ICON,
      String(bestPrice),
      "Platinum",
    );
  } else {
    bestEl.textContent = "No priced rewards yet";
  }
}

function resetSlots() {
  for (let i = 0; i < SLOTS; i += 1) {
    slotState[i] = { item: null, price: null, setPrice: null };
    renderSlot(i);
  }
  updateBestPick();
}

function resetPlannerRows() {
  const container = plannerGridElement();
  container.innerHTML = "";
}

function showRewardModeScanning() {
  rewardGeneration += 1;
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

let dragHintInfo = { hotkey: null, dismissed: true };

function prettyHotkey(hotkey) {
  return String(hotkey || "")
    .replace(/CommandOrControl|Control/g, "Ctrl")
    .replace(/Command/g, "Cmd")
    .replace(/\+/g, " + ");
}

/* Header chip teaching the move mechanic; gone once the user has ever moved an overlay. */
function updateDragHint() {
  const hint = document.getElementById("drag-hint");
  if (!hint) return;
  const hotkeyLabel = prettyHotkey(dragHintInfo.hotkey);

  let text = "";
  if (!dragHintInfo.dismissed) {
    text = overlayInteractiveMode
      ? "drag to move (position saves)"
      : hotkeyLabel
        ? `${hotkeyLabel}, then drag to move`
        : "";
  }

  hint.textContent = text;
  hint.classList.toggle("is-hidden", !text);
}

function markOverlayMoved() {
  if (dragHintInfo.dismissed) return;
  dragHintInfo.dismissed = true;
  updateDragHint();
}

function showPlannerModeScanning() {
  rewardGeneration += 1;
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
  document.getElementById("best-value").textContent = "OCR failed";
  showBestFooter(true);
}

function formatProfit(value) {
  if (value == null || value === "") return "-";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "-";
  return numberValue.toFixed(1);
}

function finiteMetric(value) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function renderPlannerRows(payload) {
  const era = String(payload?.era || "").trim();
  const confidence = Number(payload?.detection?.confidence || 0);
  const detectionElapsedMs = Number(payload?.detection?.elapsedMs || 0);
  const rows = Array.isArray(payload?.rows) ? payload.rows.filter(Boolean) : [];

  hideScanning();
  document.getElementById("slots-grid").classList.add("is-hidden");
  plannerGridElement().classList.remove("is-hidden");
  const errorBanner = document.getElementById("error-banner");
  const emptyMessage = payload?.ocrUnavailable
    ? OCR_UNAVAILABLE_MESSAGE
    : era
      ? "No owned relic recommendations found for the detected era."
      : `Could not detect relic era yet (OCR ${Math.round(Math.max(0, detectionElapsedMs))}ms, confidence ${confidence.toFixed(2)}).`;
  errorBanner.classList.toggle("visible", rows.length === 0);
  errorBanner.classList.toggle("info", rows.length === 0 && !era);
  errorBanner.textContent = rows.length === 0 ? emptyMessage : "";

  showBestFooter(false);
  showPlannerHint(!overlayInteractiveMode);

  const container = plannerGridElement();
  container.innerHTML = "";

  const bestPlat = Math.max(...rows.map((row) => finiteMetric(row?.platEv) ?? -1), -1);

  for (const row of rows) {
    if (!row) continue;
    const card = document.createElement("div");
    card.className = "plan-card";

    const platEv = finiteMetric(row.platEv);
    const ducatEv = finiteMetric(row.ducatEv);
    if (platEv != null && platEv === bestPlat && bestPlat >= 0) {
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

    profit.appendChild(label);
    appendCurrencyValue(
      profit,
      "plan-currency-value plan-profit-plat",
      PLATINUM_ICON,
      formatProfit(platEv),
      "Expected platinum",
    );
    appendCurrencyValue(
      profit,
      "plan-currency-value plan-profit-ducat",
      DUCAT_ICON,
      formatProfit(ducatEv),
      "Expected ducats",
    );

    card.appendChild(title);
    card.appendChild(profit);
    container.appendChild(card);
  }
}

async function applyRewardItems(payload) {
  const generation = ++rewardGeneration;
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  const failureReason = !Array.isArray(payload) && payload ? payload.failureReason || null : null;
  const detectedItems = rawItems.filter(Boolean).slice(0, SLOTS);

  if (detectedItems.length === 0) {
    showDetectionError(failureReason === "ocr-unavailable" ? OCR_UNAVAILABLE_MESSAGE : undefined);
    return;
  }

  // Slot scans stamp each item with its on-screen slot; honor that so a missed
  // middle card leaves a gap instead of shifting later items into wrong slots.
  const hasSlotIndexes =
    detectedItems.every(
      (item) => Number.isInteger(item?.slotIndex) && item.slotIndex >= 0 && item.slotIndex < SLOTS,
    ) && new Set(detectedItems.map((item) => item.slotIndex)).size === detectedItems.length;
  const placements = detectedItems.map((item, order) => ({
    item,
    slot: hasSlotIndexes ? item.slotIndex : order,
  }));

  hideScanning();
  document.getElementById("slots-grid").classList.remove("is-hidden");
  plannerGridElement().classList.add("is-hidden");
  document.getElementById("error-banner").classList.remove("visible");
  showBestFooter(true);

  for (let i = 0; i < SLOTS; i += 1) {
    slotState[i].item = null;
    slotState[i].price = null;
    slotState[i].setPrice = null;
  }
  for (const { item, slot } of placements) {
    slotState[slot].item = item;
  }
  for (let i = 0; i < SLOTS; i += 1) {
    renderSlot(i);
  }

  updateBestPick();

  await Promise.all(
    placements.map(async ({ item, slot }) => {
      if (!item?.urlName) {
        slotState[slot].price = 0;
        const setPrice = item?.setUrlName ? await fetchPrice(item.setUrlName) : 0;
        if (generation !== rewardGeneration) return;
        slotState[slot].setPrice = setPrice;
        renderSlot(slot);
        updateBestPick();
        return;
      }

      const [price, setPrice] = await Promise.all([
        fetchPrice(item.urlName),
        fetchPrice(item.setUrlName),
      ]);
      if (generation !== rewardGeneration) return;
      slotState[slot].price = price ?? 0;
      slotState[slot].setPrice = setPrice ?? 0;
      renderSlot(slot);
      updateBestPick();
    }),
  );
}

document.addEventListener("DOMContentLoaded", () => {
  window.overlayTheme.loadThemeFromStorageFallback();
  void window.overlay
    .getThemeVars()
    .then((vars) => {
      window.overlayTheme.applyThemeVars(vars);
    })
    .catch(() => {
      // best effort, storage fallback already applied
    });

  document.getElementById("btn-close").addEventListener("click", () => window.overlay.close());
  window.installOverlayDrag({
    isInteractive: () => overlayInteractiveMode,
    moveBy: (dx, dy) => {
      window.overlay.moveBy(dx, dy);
      markOverlayMoved();
    },
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.overlay.close();
    }
  });

  resetSlots();
  resetPlannerRows();
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "planner") {
    showPlannerModeScanning();
  } else {
    showRewardModeScanning();
  }
  setOverlayInteractiveMode(false);

  window.overlay.onTrigger(showRewardModeScanning);
  window.overlay.onPlannerTrigger(showPlannerModeScanning);
  window.overlay.onItems((items) => {
    void applyRewardItems(items);
  });
  window.overlay.onRecommendations((payload) => {
    renderPlannerRows(payload);
    showPlannerHint(!overlayInteractiveMode);
  });
  window.overlay.onThemeVars((vars) => {
    window.overlayTheme.applyThemeVars(vars);
  });
  window.overlay.onInteractionMode((payload) => {
    setOverlayInteractiveMode(Boolean(payload?.interactive));
    showPlannerHint(
      !overlayInteractiveMode && !plannerGridElement().classList.contains("is-hidden"),
    );
    updateDragHint();
  });
  window.overlay
    .getDragHint()
    .then((info) => {
      dragHintInfo = {
        hotkey: info && typeof info.hotkey === "string" ? info.hotkey : null,
        dismissed: !info || info.dismissed !== false,
      };
      updateDragHint();
    })
    .catch(() => {
      // hint is optional; stay hidden on failure
    });
  window.overlay.ready();
});
