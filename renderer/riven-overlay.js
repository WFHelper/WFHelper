import {
  canonicalRivenStatName,
  computeRivenStatSimilarity,
  formatRivenListingStatValue,
} from "./riven-similarity.js";

const _side = new URLSearchParams(window.location.search).get("side") || "left";
const _isLeft = _side === "left";

let _rollCount = 0;
let _overlayInteractiveMode = false;
/** Whether this panel currently has real stats displayed (not "Waiting for roll..."). */
let _hasDisplayedStats = false;
/** Buffered enrichment data - rendered when panel gets stats. */
let _pendingBestAttrs = null;
let _pendingListings = null;
let _showAuctions = true;

// Every panel string is rebuilt from this state, so a language change needs no rescan.
let _scanningKey = "overlay.riven.scanning";
let _bannerKey = "overlay.riven.readFailed";
let _renderedStats = [];

const t = window.overlayI18n.t;
function el(id) {
  return document.getElementById(id);
}

let _interactionHotkey = null;
let _interactionViaSettings = false;

function renderInteractionHint() {
  const hint = el("interaction-hint");
  if (!hint) return;
  const label = String(_interactionHotkey || "")
    .replace(/CommandOrControl|Control/g, "Ctrl")
    .replace(/Command/g, "Cmd")
    .replace(/\+/g, " + ");
  const text = _interactionViaSettings
    ? t("overlay.hint.interactViaSettings")
    : label
      ? t("overlay.hint.interact", { hotkey: label })
      : "";
  hint.textContent = text;
  hint.classList.toggle("is-hidden", _overlayInteractiveMode || !text);
}

function setOverlayInteractiveMode(interactive) {
  _overlayInteractiveMode = !!interactive;
  const closeButton = el("btn-close");
  if (closeButton) closeButton.classList.toggle("is-hidden", !_overlayInteractiveMode);
  const rescanButton = el("btn-rescan");
  if (rescanButton)
    rescanButton.classList.toggle("is-hidden", !_overlayInteractiveMode || !_isLeft);
  renderInteractionHint();
  if (!_overlayInteractiveMode) {
    document.documentElement.classList.remove("is-overlay-dragging");
  }
}

/** Map a letter grade string to its CSS class suffix. */
function gradeClass(grade) {
  if (!grade || grade === "?") return "grade-unknown";
  // "A+" -> "grade-Ap", "A-" -> "grade-Am", "B+" -> "grade-Bp", etc.
  const sanitised = String(grade)
    .replace("+", "p")
    .replace("-", "m")
    .replace(/[^A-Za-z]/g, "");
  return "grade-" + (sanitised || "unknown");
}

/** Create a grade badge span. */
function buildGradeBadge(grade, large) {
  const badge = document.createElement("span");
  badge.className = "grade-badge " + gradeClass(grade) + (large ? " grade-large" : "");
  badge.textContent = grade || "?";
  return badge;
}

/** Map roll float (0-1) to a colour for the progress bar. */
function rollBarColor(rollFloat, isCurse) {
  // For curses, lower float = better (stat is less penalising)
  var pct = isCurse ? 1 - rollFloat : rollFloat;
  if (pct >= 0.85) return "var(--ok)";
  if (pct >= 0.6) return "var(--accent)";
  if (pct >= 0.35) return "var(--warn)";
  return "var(--bad)";
}

function buildStatRow(stat) {
  const row = document.createElement("div");
  row.className = "stat-row" + (stat.positive ? " stat-positive" : " stat-negative");

  // Colored quality dot
  var dot = document.createElement("span");
  dot.className = "stat-dot";
  if (stat.grade && stat.grade !== "?") {
    dot.classList.add(gradeClass(stat.grade));
  }
  row.appendChild(dot);

  const valueEl = document.createElement("span");
  if (stat.multiplier && stat.value != null) {
    valueEl.textContent = "x" + stat.value;
    valueEl.className = "stat-value " + (stat.positive ? "pos" : "neg");
  } else {
    const displayPositive =
      typeof stat.displayPositive === "boolean" ? stat.displayPositive : stat.positive;
    const sign = displayPositive ? "+" : "\u2212";
    if (stat.value != null) {
      valueEl.textContent = sign + stat.value + "%";
    } else {
      valueEl.textContent = sign;
    }
    valueEl.className = "stat-value " + (stat.positive ? "pos" : "neg");
  }

  const nameEl = document.createElement("span");
  nameEl.className = "stat-name";
  nameEl.textContent = stat.name;

  row.appendChild(valueEl);
  row.appendChild(nameEl);

  // Grade letter badge
  if (stat.grade && stat.grade !== "?") {
    const badge = buildGradeBadge(stat.grade);
    badge.classList.add("stat-grade");
    row.appendChild(badge);
  }

  // Roll quality progress bar
  if (stat.rollFloat != null && stat.grade && stat.grade !== "?") {
    var barWrap = document.createElement("div");
    barWrap.className = "roll-bar-wrap";
    var barFill = document.createElement("div");
    barFill.className = "roll-bar-fill";
    var pct = Math.round(Math.max(0, Math.min(1, stat.rollFloat)) * 100);
    barFill.style.width = pct + "%";
    barFill.style.setProperty("--roll-grade-color", rollBarColor(stat.rollFloat, !stat.positive));
    barWrap.appendChild(barFill);
    row.appendChild(barWrap);
  }

  return row;
}

function renderStats(stats) {
  const container = el("stats-container");
  const list = el("stats-list");
  const errorEl = el("error-banner");
  if (!container || !list) return;

  _renderedStats = Array.isArray(stats) ? stats : [];
  list.innerHTML = "";

  if (_renderedStats.length === 0) {
    _hasDisplayedStats = false;
    const empty = document.createElement("div");
    empty.className = "stat-empty";
    empty.textContent = t(
      _isLeft ? "overlay.riven.waitingForScan" : "overlay.riven.waitingForRoll",
    );
    list.appendChild(empty);
    container.classList.remove("is-hidden");
    if (errorEl) errorEl.classList.remove("visible");
    // Hide enrichment sections when no stats
    el("best-attributes").classList.add("is-hidden");
    el("similar-listings").classList.add("is-hidden");
    return;
  }

  _hasDisplayedStats = true;
  if (errorEl) errorEl.classList.remove("visible");
  for (const stat of _renderedStats) {
    list.appendChild(buildStatRow(stat));
  }
  container.classList.remove("is-hidden");

  _currentStats = statsToMatchable(_renderedStats);
  _currentStatNamesLc = _currentStats.map(function (s) {
    return s.name;
  });

  // Flush any buffered enrichment now that we have stats
  if (_pendingBestAttrs) renderBestAttributes(_pendingBestAttrs);
  if (_pendingListings) renderSimilarListings(_pendingListings);
}

function renderErrorBanner() {
  const banner = el("error-banner");
  if (banner) banner.textContent = t(_bannerKey);
}

/** Show the error banner with a reason instead of an endless "Waiting" spinner. */
function showScanError(messageKey) {
  hideScanning();
  _hasDisplayedStats = false;
  _renderedStats = [];
  el("stats-container").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");
  _bannerKey = messageKey;
  renderErrorBanner();
  const banner = el("error-banner");
  if (banner) banner.classList.add("visible");
}

/** State: current stat names (lowercase) for WFM similarity matching. */
let _currentStatNamesLc = [];
/** State: current stats as { name (lowercase), positive } for best-attribute matching. */
let _currentStats = [];

function statsToMatchable(stats) {
  return stats.map(function (s) {
    return { name: (s.name || "").toLowerCase(), positive: s.positive !== false };
  });
}

function renderOverallGrade(attributeGrade) {
  const wrapper = el("overall-grade");
  const badge = el("overall-grade-badge");
  if (!wrapper || !badge) return;

  if (!attributeGrade) {
    wrapper.classList.add("is-hidden");
    return;
  }

  badge.className = "attr-grade-badge attr-grade-" + attributeGrade.toLowerCase();
  badge.textContent = attributeGrade;
  wrapper.classList.remove("is-hidden");
}

// Grading arrives through a later IPC event, so rebuild the existing stat rows.
function applyGradingToStats(gradingResult) {
  if (!gradingResult) return;
  const { stats, attributeGrade } = gradingResult;

  renderOverallGrade(attributeGrade);

  if (!Array.isArray(stats)) return;

  // Re-render stats with grading info baked in
  const list = el("stats-list");
  const container = el("stats-container");
  if (!list || !container) return;

  _renderedStats = stats;
  list.innerHTML = "";
  for (const stat of stats) {
    list.appendChild(buildStatRow(stat));
  }
  container.classList.remove("is-hidden");

  // Update tracked stats for best-attribute matching
  _currentStats = statsToMatchable(stats);
  _currentStatNamesLc = _currentStats.map(function (s) {
    return s.name;
  });
  refreshBestAttributeHighlights();
}

function onGradingInitial(grading) {
  if (_isLeft) {
    applyGradingToStats(grading);
  }
}

function onGradingRoll(payload) {
  if (!payload) return;
  const side = _isLeft ? payload.left : payload.right;
  applyGradingToStats(side);
}

function fillBestRow(row, names, side, labelKey) {
  if (!Array.isArray(names) || names.length === 0) return;

  const label = document.createElement("span");
  label.className = `best-row-label ${side}`;
  label.textContent = t(labelKey);
  row.appendChild(label);

  for (const name of names) {
    const chip = document.createElement("span");
    chip.className = "best-chip";
    chip.setAttribute("data-stat", name.toLowerCase());
    chip.setAttribute("data-side", side);
    chip.textContent = abbreviateStat(name);
    row.appendChild(chip);
  }
}

function renderBestAttributes(attrs) {
  _pendingBestAttrs = attrs;

  // Don't render if panel has no stats yet (right panel before first roll)
  if (!_hasDisplayedStats) return;

  const wrapper = el("best-attributes");
  if (!wrapper || !attrs) return;

  const posRow = el("best-pos");
  const negRow = el("best-neg");
  if (!posRow || !negRow) return;

  posRow.innerHTML = "";
  negRow.innerHTML = "";
  fillBestRow(posRow, attrs.positives, "pos", "overlay.riven.bestPositives");
  fillBestRow(negRow, attrs.negatives, "neg", "overlay.riven.bestNegatives");

  wrapper.classList.remove("is-hidden");
  refreshBestAttributeHighlights();
}

// Keyed and valued in English: the scan, the grading tables and the WFM search
// all speak these stat names, so a translated chip could not be matched back.
var STAT_ABBREVIATIONS = {
  "critical chance": "CritCh",
  "critical damage": "CritDmg",
  multishot: "Multi",
  damage: "Dmg",
  "melee damage": "Dmg",
  "status chance": "Status",
  "attack speed": "AtkSpd",
  electricity: "Elec",
  toxin: "Toxin",
  heat: "Heat",
  cold: "Cold",
  range: "Range",
  zoom: "Zoom",
  "ammo maximum": "Ammo",
  "weapon recoil": "Recoil",
  "projectile speed": "ProjSpd",
  "finisher damage": "Finisher",
  "heavy attack efficiency": "HvyAtk",
  "combo duration": "Combo",
  "slide attack": "Slide",
  "reload speed": "Reload",
  "fire rate": "FireRate",
};

/** Abbreviate long stat names for compact chip display. */
function abbreviateStat(name) {
  return STAT_ABBREVIATIONS[name.toLowerCase()] || name;
}

// Match sign and canonical name so a Damage roll cannot highlight Critical Damage.
function refreshBestAttributeHighlights() {
  var chips = document.querySelectorAll(".best-chip");
  for (var i = 0; i < chips.length; i++) {
    var chipStat = canonicalRivenStatName(chips[i].getAttribute("data-stat"));
    var wantPositive = chips[i].getAttribute("data-side") !== "neg";
    var matched = _currentStats.some(function (s) {
      return s.positive === wantPositive && canonicalRivenStatName(s.name) === chipStat;
    });
    chips[i].classList.toggle("matched", matched);
  }
}

function renderSimilarListings(listings) {
  _pendingListings = listings;

  // Don't render if panel has no stats yet (right panel before first roll)
  if (!_hasDisplayedStats) return;

  var wrapper = el("similar-listings");
  var list = el("similar-list");
  if (!wrapper || !list) return;

  list.innerHTML = "";

  if (!Array.isArray(listings) || listings.length === 0) {
    wrapper.classList.add("is-hidden");
    return;
  }

  // Main sends the first 30 search results plus the cheapest direct sales among the rest.
  const shownListings = (
    _showAuctions ? listings : listings.filter((listing) => listing.isDirectSell !== false)
  ).slice(0, 30);
  if (shownListings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "listing-empty";
    empty.textContent = t("rivens.detail.noSimilarFound");
    list.appendChild(empty);
    wrapper.classList.remove("is-hidden");
    return;
  }

  var myStats = _currentStatNamesLc.slice();
  var enriched = [];
  for (var i = 0; i < shownListings.length; i++) {
    var sim = computeRivenStatSimilarity(myStats, shownListings[i].stats);
    enriched.push({ item: shownListings[i], pct: sim.pct, matchedNames: sim.matchedNames });
  }
  enriched.sort(function (a, b) {
    return b.pct - a.pct;
  });

  for (var k = 0; k < enriched.length; k++) {
    var item = enriched[k].item;
    var pct = enriched[k].pct;
    var matchedNames = enriched[k].matchedNames;

    var card = document.createElement("div");
    card.className = "listing-card";
    if (item.id) {
      card.setAttribute("data-auction-id", item.id);
      card.style.cursor = "pointer";
      card.addEventListener(
        "click",
        (function (aid) {
          return function () {
            window.rivenOverlay.openAuction(aid);
          };
        })(item.id),
      );
    }

    var simEl = document.createElement("div");
    simEl.className = "listing-similarity";
    if (pct >= 75) simEl.classList.add("sim-high");
    else if (pct >= 40) simEl.classList.add("sim-medium");
    else simEl.classList.add("sim-low");
    simEl.textContent = t("overlay.riven.matchPercent", { percent: pct });
    card.appendChild(simEl);

    var topRow = document.createElement("div");
    topRow.className = "listing-card-top";

    var priceEl = document.createElement("span");
    priceEl.className = "listing-price";
    var price = item.buyoutPrice || item.startingPrice || item.platinum || 0;
    const priceValue = document.createElement("span");
    priceValue.className = "listing-price-value";
    priceValue.textContent = String(price);
    const priceUnit = document.createElement("span");
    priceUnit.className = "listing-price-unit";
    priceUnit.textContent = "p";
    priceEl.append(priceValue, priceUnit);
    topRow.appendChild(priceEl);

    var rerollsEl = document.createElement("span");
    rerollsEl.className = "listing-rerolls";
    rerollsEl.textContent = t("overlay.riven.rolls", { count: item.rerolls || 0 });
    topRow.appendChild(rerollsEl);

    card.appendChild(topRow);

    // Stat lines (vertical, one per line) - cross out non-matching stats
    if (Array.isArray(item.stats)) {
      var statsCol = document.createElement("div");
      statsCol.className = "listing-stats-col";
      for (var j = 0; j < item.stats.length; j++) {
        var s = item.stats[j];
        var sname = (s.name || "").toLowerCase();
        var isMatch = matchedNames.has(sname);
        var line = document.createElement("div");
        line.className = "listing-stat-line " + (s.positive ? "pos" : "neg");
        if (!isMatch) line.classList.add("crossed");
        const statValue = document.createElement("span");
        statValue.className = "listing-stat-value";
        statValue.textContent = formatRivenListingStatValue(s);
        const statName = document.createElement("span");
        statName.className = "listing-stat-name";
        statName.textContent = abbreviateStat(s.name);
        line.append(statValue, statName);
        statsCol.appendChild(line);
      }
      card.appendChild(statsCol);
    }

    list.appendChild(card);
  }

  wrapper.classList.remove("is-hidden");
}

function setShowAuctions(shown) {
  _showAuctions = shown;
  const toggle = el("btn-similar-auctions");
  if (toggle) {
    toggle.classList.toggle("active", shown);
    toggle.setAttribute("aria-pressed", String(shown));
  }
  if (_pendingListings) renderSimilarListings(_pendingListings);
}

function renderScanningText() {
  const text = el("scanning-text");
  if (text) text.textContent = t(_scanningKey);
}

function setScanningText(key) {
  _scanningKey = key;
  renderScanningText();
}

function showScanning() {
  el("scanning-state").classList.add("visible");
  el("stats-container").classList.add("is-hidden");
  el("error-banner").classList.remove("visible");
}

function hideScanning() {
  el("scanning-state").classList.remove("visible");
}

function renderRollBadge() {
  const rollBadge = el("roll-badge");
  if (rollBadge) rollBadge.textContent = t("overlay.riven.roll", { count: _rollCount });
}

function renderPanelLabel() {
  const labelEl = el("panel-label");
  if (labelEl) labelEl.textContent = t(_isLeft ? "overlay.riven.current" : "overlay.riven.newRoll");
}

function onSessionStart(weapon) {
  _rollCount = 0;
  _currentStatNamesLc = [];
  _currentStats = [];
  _hasDisplayedStats = false;
  _pendingBestAttrs = null;
  _pendingListings = null;

  el("weapon-name").textContent = weapon || "\u2014";
  setWeaponWarningVisible(false);

  renderRollBadge();

  // Reset stats
  el("stats-container").classList.add("is-hidden");
  el("error-banner").classList.remove("visible");

  // Reset grading + enrichment sections
  el("overall-grade").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");

  // Left panel: show scanning spinner for initial card scan
  // Right panel: show "waiting for roll" placeholder
  if (_isLeft) {
    showScanning();
    setScanningText("overlay.riven.scanningCurrent");
  } else {
    renderStats([]); // shows "Waiting for roll..."
  }
}

function onInitialStats(stats, lowConfidence) {
  hideScanning();
  // Only the left (current) panel uses initial stats
  if (!_isLeft) return;
  if (Array.isArray(stats) && stats.length > 0) {
    renderStats(stats);
  } else {
    showScanError(
      lowConfidence === true ? "overlay.riven.textTooSmall" : "overlay.riven.readFailed",
    );
  }
}

function onScanning() {
  showScanning();
  setScanningText("overlay.riven.scanningRoll");
}

function onRollResult(payload) {
  const { rollCount, left, right } = payload || {};

  _rollCount = Number(rollCount) || _rollCount + 1;

  renderRollBadge();

  hideScanning();

  // Each window displays only its side's data
  const stats = _isLeft ? left : right;
  const hasStats = Array.isArray(stats) && stats.length > 0;

  if (hasStats) {
    renderStats(stats);
  } else {
    showScanError("overlay.riven.rollReadFailed");
  }
}

function onChoiceMade(side) {
  // Show a visual indicator of which choice was made
  const panel = el("panel");
  if (!panel) return;

  if (side === "left" && _isLeft) {
    // User kept old (this panel) - highlight briefly
    panel.style.borderColor = "var(--ok)";
    setTimeout(() => {
      panel.style.borderColor = "";
    }, 2000);
  } else if (side === "right" && !_isLeft) {
    // User took new roll (this panel) - highlight briefly
    panel.style.borderColor = "var(--ok)";
    setTimeout(() => {
      panel.style.borderColor = "";
    }, 2000);
  }

  // Preserve a chosen right-side highlight briefly; otherwise clear stale roll
  // data as soon as the game returns to one card.
  if (!_isLeft) {
    const delay = side === "right" ? 2000 : 0;
    setTimeout(() => {
      renderStats([]); // shows "Waiting for roll..."
    }, delay);
  }

  // Left panel: show scanning spinner while the re-scan runs so the user gets
  // immediate feedback that the overlay is updating.
  if (_isLeft) {
    showScanning();
    setScanningText("overlay.riven.scanningCurrent");
  }
}

function setWeaponWarningVisible(visible) {
  const warning = el("weapon-warning");
  if (warning) warning.classList.toggle("is-hidden", !visible);
}

/* Manual rescan after a FITS IN variant switch: fresh values are coming for
   the current card, and the old roll panel's numbers no longer apply. */
function onRescan() {
  setWeaponWarningVisible(false);
  if (_isLeft) {
    showScanning();
    setScanningText("overlay.riven.rescanning");
  } else {
    el("overall-grade").classList.add("is-hidden");
    renderStats([]); // shows "Waiting for roll..."
  }
}

function onSessionEnd() {
  hideScanning();
  _currentStatNamesLc = [];
  _currentStats = [];
  _hasDisplayedStats = false;
  _pendingBestAttrs = null;
  _pendingListings = null;
  el("overall-grade").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");
}

/* Rebuilds every string this panel writes from JS, for a live language change. */
function renderDynamicText() {
  if (layoutPreviewState) {
    renderLayoutPreview(layoutPreviewState);
    return;
  }
  renderPanelLabel();
  renderRollBadge();
  renderScanningText();
  renderErrorBanner();
  renderInteractionHint();
  // The banner replaces the stat list, so re-rendering stats would resurrect it.
  const banner = el("error-banner");
  if (banner && banner.classList.contains("visible")) return;
  renderStats(_renderedStats);
}

let layoutEditor = null;
let layoutPreviewState = null;

function tagRivenLayoutFields() {
  const tag = (selector, field, root = document) => {
    const target = root.querySelector(selector);
    if (target) target.dataset.rewardField = field;
  };
  for (const [selector, field] of Object.entries({
    "#panel-label": "panelLabel",
    "#weapon-name": "weaponName",
    "#roll-badge": "rollBadge",
    "#btn-rescan": "rescanButton",
    "#btn-close": "closeButton",
    "#overall-grade-badge": "overallGrade",
    ".scan-spinner": "scanSpinner",
    "#scanning-text": "scanText",
    "#error-banner": "errorText",
    "#weapon-warning": "weaponWarning",
    ".stat-empty": "emptyText",
    "#interaction-hint": "interactionHint",
    "#best-pos .best-row-label": "bestPositiveLabel",
    "#best-neg .best-row-label": "bestNegativeLabel",
    "#similar-title": "listingsLabel",
  }))
    tag(selector, field);
  document.querySelectorAll(".stat-row").forEach((row, index) => {
    for (const [selector, role] of Object.entries({
      ".stat-dot": "Dot",
      ".stat-value": "Value",
      ".stat-name": "Name",
      ".stat-grade": "Grade",
      ".roll-bar-wrap": "Track",
    }))
      tag(selector, `stat${index}${role}`, row);
    const dot = row.querySelector(".stat-dot");
    if (dot) dot.dataset.layoutTint = "background";
  });
  for (const [selector, field] of [
    ["#best-pos .best-chip", "bestPositiveChip"],
    ["#best-neg .best-chip", "bestNegativeChip"],
  ]) {
    document.querySelectorAll(selector).forEach((element) => {
      element.dataset.rewardField = field;
    });
  }
  document.querySelectorAll(".listing-card").forEach((card) => {
    tag(".listing-similarity", "listingMatch", card);
    tag(".listing-price-value", "listingPlatinum", card);
    tag(".listing-price-unit", "listingPlatinumUnit", card);
    tag(".listing-rerolls", "listingRolls", card);
    card.querySelectorAll(".listing-stat-line").forEach((line, index) => {
      tag(".listing-stat-value", `listingStat${index}Value`, line);
      tag(".listing-stat-name", `listingStat${index}Name`, line);
    });
  });
}

function renderLayoutPreview(state) {
  layoutPreviewState = state;
  onSessionStart("Rubico");
  hideScanning();
  _rollCount = state.previewVariant === "unrolled" ? 0 : 12;
  renderRollBadge();
  setOverlayInteractiveMode(true);
  el("btn-rescan").classList.remove("is-hidden");
  _interactionHotkey = "Ctrl+O";
  renderInteractionHint();
  el("interaction-hint").classList.remove("is-hidden");
  if (state.previewVariant === "scanning") {
    showScanning();
    return;
  }
  if (state.previewVariant === "error") {
    showScanError("overlay.riven.readFailed");
    setWeaponWarningVisible(true);
    return;
  }
  if (state.previewVariant === "waiting") {
    renderStats([]);
    return;
  }
  const stats = [
    { name: "Critical Chance", value: 153.4, positive: true, grade: "A", rollFloat: 0.82 },
    { name: "Critical Damage", value: 120.6, positive: true, grade: "S", rollFloat: 0.98 },
    { name: "Multishot", value: 84.3, positive: true, grade: "B+", rollFloat: 0.64 },
    { name: "Zoom", value: 40.2, positive: false, grade: "A-", rollFloat: 0.21 },
  ];
  renderStats(state.previewVariant === "unrolled" ? [stats[0], stats[1], stats[3]] : stats);
  renderOverallGrade("Great");
  renderBestAttributes({
    positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage"],
    negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil"],
  });
  if (state.previewVariant !== "noListings") {
    renderSimilarListings(
      [0, 1, 2, 3, 4, 5].map((index) => ({
        platinum: 400 + index * 75,
        rerolls: index * 3,
        stats: stats.map((stat) => ({
          ...stat,
          value: (stat.positive ? 1 : -1) * (stat.value + index),
        })),
      })),
    );
  }
}

function startOverlay() {
  const panel = el("panel");
  if (!_isLeft && panel) panel.classList.add("is-new");
  renderPanelLabel();
  renderRollBadge();
  renderScanningText();
  renderErrorBanner();
  setOverlayInteractiveMode(false);
  renderStats([]);
}

document.addEventListener("DOMContentLoaded", () => {
  let bootstrapped = false;
  const finishBootstrap = (loaded) => {
    if (!loaded || bootstrapped) return;
    bootstrapped = true;
    startOverlay();
    layoutEditor = window.installOverlayLayout({
      defaultFieldStyle: window.overlayLayoutApi.defaultFieldStyle,
      tagFields: tagRivenLayoutFields,
      boundsFor: (element) => element.closest(".listing-card"),
      renderPreview: renderLayoutPreview,
      resetPreview: () => {
        layoutPreviewState = null;
        startOverlay();
      },
    });
    window.rivenOverlay.ready();
  };
  window.overlayTheme.bootstrapOverlayTheme(
    () => window.rivenOverlay.getThemeVars(),
    _isLeft ? "rivenLeft" : "rivenRight",
  );

  el("btn-close").addEventListener("click", () => window.rivenOverlay.close());
  el("btn-rescan").addEventListener("click", () => window.rivenOverlay.requestRescan());
  el("btn-similar-auctions").addEventListener("click", () => {
    window.rivenOverlay.setSimilarAuctions(!_showAuctions).catch(() => {
      // a failed save leaves the saved value on screen
    });
  });
  window.installOverlayDrag({
    isInteractive: () => _overlayInteractiveMode && !layoutEditor?.isEditing(),
    moveBy: (dx, dy) => window.rivenOverlay.moveBy(dx, dy),
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.rivenOverlay.close();
    }
  });

  window.rivenOverlay.onThemeVars((vars) => window.overlayTheme.applyThemeVars(vars));
  window.rivenOverlay.onMessages((messages) => finishBootstrap(window.overlayI18n.apply(messages)));
  window.rivenOverlay.onSessionStart((weapon) => onSessionStart(weapon));
  window.rivenOverlay.onInitialStats((stats, lowConfidence) =>
    onInitialStats(stats, lowConfidence),
  );
  window.rivenOverlay.onScanning(() => onScanning());
  window.rivenOverlay.onRollResult((payload) => onRollResult(payload));
  window.rivenOverlay.onChoiceMade((side) => onChoiceMade(side));
  window.rivenOverlay.onRescan(() => onRescan());
  window.rivenOverlay.onSessionEnd(() => onSessionEnd());
  window.rivenOverlay.onWeaponUpdate((weapon) => {
    el("weapon-name").textContent = weapon || "\u2014";
    if (weapon) setWeaponWarningVisible(false);
  });
  window.rivenOverlay.onWeaponMissing(() => {
    if (_isLeft) setWeaponWarningVisible(true);
  });
  window.rivenOverlay.onInteractionMode((payload) => {
    setOverlayInteractiveMode(Boolean(payload?.interactive));
  });
  Promise.resolve(window.rivenOverlay.getDragHint?.())
    .then((info) => {
      _interactionHotkey = info && typeof info.hotkey === "string" ? info.hotkey : null;
      _interactionViaSettings = info?.viaSettings === true;
      renderInteractionHint();
    })
    .catch(() => {
      // hint is optional; stay hidden on failure
    });

  window.rivenOverlay.onGradingInitial((grading) => onGradingInitial(grading));
  window.rivenOverlay.onGradingRoll((payload) => onGradingRoll(payload));
  window.rivenOverlay.onBestAttributes((attrs) => renderBestAttributes(attrs));
  window.rivenOverlay.onSimilarListings((listings) => renderSimilarListings(listings));
  window.rivenOverlay.onSimilarAuctions((shown) => setShowAuctions(shown));

  window.overlayI18n.onApply(renderDynamicText);
  void window.overlayI18n.load(() => window.rivenOverlay.getMessages()).then(finishBootstrap);
});
