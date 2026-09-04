const SLOTS = 4;
const slotState = Array.from({ length: SLOTS }, () => ({
  item: null,
  price: null,
  setPrice: null,
}));
let overlayInteractiveMode = false;
let rewardGeneration = 0;
// Max wait for slow price lookups before crowning the best-so-far reward.
const BEST_PICK_SETTLE_CAP_MS = 4_000;
const PLATINUM_ICON = "../assets/Platinum.png";
const DUCAT_ICON = "../assets/OrokinDucats.png";

// Every panel string is rebuilt from this state, so a language change needs no rescan.
let scanningKey = "overlay.reward.scanning";
let bestPlaceholderKey = "overlay.reward.detecting";
let bannerMessage = null;
let plannerPayload = null;

const t = window.overlayI18n.t;

function setOverlayInteractiveMode(interactive) {
  overlayInteractiveMode = !!interactive;
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

function rarityLabel(rarity) {
  const low = String(rarity || "").toLowerCase();
  if (low === "rare") return t("overlay.reward.rarity.rare");
  if (low === "uncommon") return t("overlay.reward.rarity.uncommon");
  return t("overlay.reward.rarity.common");
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
      t("common.platinum"),
    );
  }

  if (hasDucats) {
    appendCurrencyValue(
      container,
      "slot-currency-value slot-ducat-value",
      DUCAT_ICON,
      String(Math.floor(ducatCount)),
      t("common.ducats"),
    );
  }
}

function partTooltip(part) {
  const name = part.name || t("overlay.reward.partFallback");
  const counts = `${formatCount(part.ownedCount)}/${formatCount(part.requiredCount)}`;
  const building = part.building === true ? ` ${t("overlay.reward.partInFoundry")}` : "";
  const reward = part.isReward ? ` ${t("overlay.reward.partIsReward")}` : "";
  return `${name}: ${counts}${building}${reward}`;
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
    const building = part.building === true;
    const chip = document.createElement("span");
    chip.className = `slot-set-part ${ok ? "owned" : "missing"}${building ? " building" : ""}${
      part.isReward ? " is-reward" : ""
    }`;
    chip.title = partTooltip(part);

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

function renderScanningText() {
  const el = document.getElementById("scanning-text");
  if (el) el.textContent = t(scanningKey);
}

function setScanningText(key) {
  scanningKey = key;
  renderScanningText();
}

function renderErrorBanner() {
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  banner.textContent = bannerMessage ? t(bannerMessage.key, bannerMessage.params) : "";
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
  const playerEl = slotEl.querySelector(".slot-player");
  const nameEl = slotEl.querySelector(".slot-name");
  const priceEl = slotEl.querySelector(".slot-price");
  const rarityEl = slotEl.querySelector(".slot-rarity");
  const metaEl = slotEl.querySelector(".slot-meta");
  const { item, price, setPrice } = slotState[index];

  slotEl.classList.remove("has-item", "best-slot", "empty-slot");
  if (playerEl) playerEl.textContent = t("overlay.reward.slot", { index: index + 1 });
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
  rarityEl.textContent = rarityLabel(item.rarity);
  rarityEl.className = `slot-rarity ${rarityClass(item.rarity)}`;

  renderSlotValues(priceEl, price, item.ducats);

  const partRequired = Number(item.partRequiredCount);
  if (Number.isFinite(partRequired) && partRequired > 0) {
    appendMetaChip(
      metaEl,
      t("overlay.reward.ownedParts", {
        owned: formatCount(item.partOwnedCount),
        required: formatCount(partRequired),
      }),
      "owned",
    );
  }

  // Only present when the reward builds into masterable equipment.
  if (item.mastered === true) appendMetaChip(metaEl, t("common.mastered"), "mastered");
  else if (item.mastered === false) appendMetaChip(metaEl, t("common.notMastered"), "unmastered");

  if (item.building) appendMetaChip(metaEl, t("overlay.reward.inFoundry"), "building");

  const setRequired = Number(item.setRequiredCount);
  if (Number.isFinite(setRequired) && setRequired > 0) {
    appendMetaChip(
      metaEl,
      t("overlay.reward.setParts", {
        owned: formatCount(item.setOwnedCount),
        required: formatCount(setRequired),
      }),
      "set",
    );
  }

  if (item.setUrlName) {
    const value = setPrice == null ? "..." : setPrice > 0 ? `${setPrice}p` : "N/A";
    appendMetaChip(metaEl, t("overlay.reward.setPrice", { value }), "set-price");
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
      t("common.platinum"),
    );
  } else {
    bestEl.textContent = t(bestPlaceholderKey);
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
  plannerPayload = null;
  const container = plannerGridElement();
  container.innerHTML = "";
}

function showRewardModeScanning() {
  document.body.classList.remove("planner-mode");
  rewardGeneration += 1;
  setScanningText("overlay.reward.scanning");
  showScanning();
  showBestFooter(true);
  bannerMessage = null;
  renderErrorBanner();
  bestPlaceholderKey = "overlay.reward.detecting";
  resetSlots();
}

function plannerHintElement() {
  return document.getElementById("planner-hint");
}

let plannerHintWanted = false;

function showPlannerHint(show) {
  plannerHintWanted = show;
  renderPlannerHint();
}

let dragHintInfo = { hotkey: null, dismissed: true };

function prettyHotkey(hotkey) {
  return String(hotkey || "")
    .replace(/CommandOrControl|Control/g, "Ctrl")
    .replace(/Command/g, "Cmd")
    .replace(/\+/g, " + ");
}

/* Label follows the live interaction hotkey; stays hidden while unbound. */
function renderPlannerHint() {
  const hint = plannerHintElement();
  if (!hint) return;
  const label = prettyHotkey(dragHintInfo.hotkey);
  hint.textContent = label ? t("overlay.hint.interactPanel", { hotkey: label }) : "";
  hint.classList.toggle("is-hidden", !plannerHintWanted || !label);
}

/* Header chip teaching the move mechanic; gone once the user has ever moved an overlay. */
function updateDragHint() {
  const hint = document.getElementById("drag-hint");
  if (!hint) return;
  const hotkeyLabel = prettyHotkey(dragHintInfo.hotkey);

  let text = "";
  if (!dragHintInfo.dismissed) {
    text = overlayInteractiveMode
      ? t("overlay.hint.dragToMove")
      : hotkeyLabel
        ? t("overlay.hint.unlockThenDrag", { hotkey: hotkeyLabel })
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
  document.body.classList.add("planner-mode");
  rewardGeneration += 1;
  setScanningText("overlay.planner.scanning");
  showScanning();
  showBestFooter(false);
  showPlannerHint(false);
  bannerMessage = null;
  renderErrorBanner();
  resetPlannerRows();
}

function showDetectionError(messageKey) {
  hideScanning();
  document.getElementById("slots-grid").classList.remove("is-hidden");
  plannerGridElement().classList.add("is-hidden");
  document.getElementById("error-banner").classList.add("visible");
  bannerMessage = { key: messageKey || "overlay.reward.ocrFailed" };
  renderErrorBanner();
  bestPlaceholderKey = "overlay.reward.ocrFailedShort";
  resetSlots();
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

function plannerRows() {
  return Array.isArray(plannerPayload?.rows) ? plannerPayload.rows.filter(Boolean) : [];
}

function renderPlannerCards() {
  const container = plannerGridElement();
  container.innerHTML = "";

  const rows = plannerRows();
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

    const vaultTag = document.createElement("span");
    vaultTag.className = `plan-vault-tag ${row.vaulted ? "vaulted" : "unvaulted"}`;
    vaultTag.textContent = row.vaulted ? t("common.vaulted") : t("common.unvaulted");
    title.appendChild(vaultTag);

    const profit = document.createElement("div");
    profit.className = "plan-profit";

    const label = document.createElement("span");
    label.className = "plan-profit-label";
    label.textContent = t("overlay.planner.expectedProfits");

    profit.appendChild(label);
    appendCurrencyValue(
      profit,
      "plan-currency-value plan-profit-plat",
      PLATINUM_ICON,
      formatProfit(platEv),
      t("overlay.planner.expectedPlatinum"),
    );
    appendCurrencyValue(
      profit,
      "plan-currency-value plan-profit-ducat",
      DUCAT_ICON,
      formatProfit(ducatEv),
      t("overlay.planner.expectedDucats"),
    );

    card.appendChild(title);
    card.appendChild(profit);
    container.appendChild(card);
  }
}

function plannerBannerMessage(payload, era, rows) {
  if (rows.length > 0) return null;
  if (payload?.ocrUnavailable) return { key: "overlay.reward.ocrUnavailable" };
  if (era) return { key: "overlay.planner.noRecommendations" };
  return {
    key: "overlay.planner.eraUnknown",
    params: {
      elapsed: Math.round(Math.max(0, Number(payload?.detection?.elapsedMs || 0))),
      confidence: Number(payload?.detection?.confidence || 0).toFixed(2),
    },
  };
}

function renderPlannerRows(payload) {
  plannerPayload = payload;
  const era = String(payload?.era || "").trim();
  const rows = plannerRows();

  hideScanning();
  document.getElementById("slots-grid").classList.add("is-hidden");
  plannerGridElement().classList.remove("is-hidden");
  const errorBanner = document.getElementById("error-banner");
  bannerMessage = plannerBannerMessage(payload, era, rows);
  errorBanner.classList.toggle("visible", rows.length === 0);
  errorBanner.classList.toggle("info", rows.length === 0 && !era);
  renderErrorBanner();

  showBestFooter(false);
  showPlannerHint(!overlayInteractiveMode);

  renderPlannerCards();
}

async function applyRewardItems(payload) {
  const generation = ++rewardGeneration;
  const receivedAt = performance.now();
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  const failureReason = !Array.isArray(payload) && payload ? payload.failureReason || null : null;
  const detectedItems = rawItems.filter(Boolean).slice(0, SLOTS);

  if (detectedItems.length === 0) {
    showDetectionError(
      failureReason === "ocr-unavailable" ? "overlay.reward.ocrUnavailable" : undefined,
    );
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
  bannerMessage = null;
  renderErrorBanner();
  showBestFooter(true);

  bestPlaceholderKey = "overlay.reward.noPricedRewards";
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

  // A rAF callback still runs before the frame is painted, so the timeout task
  // queued from it is the first moment the cards are actually on screen. Info
  // level keeps a healthy paint out of the WARN lines main.log keeps for faults.
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (generation !== rewardGeneration) return;
      console.info(
        `[Overlay] ${placements.length} reward(s) painted ${Math.round(performance.now() - receivedAt)}ms after receipt`,
      );
    }, 0);
  });

  // Delay crowning until prices settle to avoid a hopping highlight. The cap
  // still crowns the best known item when one lookup stalls.
  const crownCap = setTimeout(() => {
    if (generation === rewardGeneration) updateBestPick();
  }, BEST_PICK_SETTLE_CAP_MS);

  await Promise.all(
    placements.map(async ({ item, slot }) => {
      if (!item?.urlName) {
        slotState[slot].price = 0;
        const setPrice = item?.setUrlName ? await fetchPrice(item.setUrlName) : 0;
        if (generation !== rewardGeneration) return;
        slotState[slot].setPrice = setPrice;
        renderSlot(slot);
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
    }),
  );

  clearTimeout(crownCap);
  if (generation !== rewardGeneration) return;
  updateBestPick();
  console.info(
    `[Overlay] prices settled ${Math.round(performance.now() - receivedAt)}ms after receipt`,
  );
}

/* Rebuilds every string this panel writes from JS, for a live language change. */
function renderDynamicText() {
  renderScanningText();
  renderErrorBanner();
  for (let i = 0; i < SLOTS; i += 1) renderSlot(i);
  updateBestPick();
  renderPlannerCards();
  renderPlannerHint();
  updateDragHint();
}

function startOverlay() {
  resetSlots();
  resetPlannerRows();
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "planner") {
    showPlannerModeScanning();
  } else {
    showRewardModeScanning();
  }
  setOverlayInteractiveMode(false);
  window.overlay.ready();
}

document.addEventListener("DOMContentLoaded", () => {
  let bootstrapped = false;
  const finishBootstrap = (loaded) => {
    if (!loaded || bootstrapped) return;
    bootstrapped = true;
    startOverlay();
  };
  window.overlayTheme.bootstrapOverlayTheme(() => window.overlay.getThemeVars());

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
  window.overlay.onMessages((messages) => finishBootstrap(window.overlayI18n.apply(messages)));
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
      renderPlannerHint();
    })
    .catch(() => {
      // hint is optional; stay hidden on failure
    });

  window.overlayI18n.onApply(renderDynamicText);
  // Scan results only flow after ready(), so the first paint is already localized.
  void window.overlayI18n.load(() => window.overlay.getMessages()).then(finishBootstrap);
});
