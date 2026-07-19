import { computeRivenStatSimilarity } from "./riven-similarity.js";

const _side = new URLSearchParams(window.location.search).get("side") || "left";
const _isLeft = _side === "left";

let _rollCount = 0;
let _overlayInteractiveMode = false;
/** Whether this panel currently has real stats displayed (not "Waiting for roll..."). */
let _hasDisplayedStats = false;
/** Buffered enrichment data - rendered when panel gets stats. */
let _pendingBestAttrs = null;
let _pendingListings = null;

function el(id) {
  return document.getElementById(id);
}

function setOverlayInteractiveMode(interactive) {
  _overlayInteractiveMode = !!interactive;
  document.documentElement.classList.toggle("is-overlay-interactive", _overlayInteractiveMode);
  const closeButton = el("btn-close");
  if (closeButton) closeButton.classList.toggle("is-hidden", !_overlayInteractiveMode);
  const hint = el("interaction-hint");
  if (hint) hint.classList.toggle("is-hidden", _overlayInteractiveMode);
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
    barFill.style.background = rollBarColor(stat.rollFloat, !stat.positive);
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

  list.innerHTML = "";

  if (!Array.isArray(stats) || stats.length === 0) {
    _hasDisplayedStats = false;
    const empty = document.createElement("div");
    empty.className = "stat-empty";
    empty.textContent = _isLeft ? "Waiting for scan\u2026" : "Waiting for roll\u2026";
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
  for (const stat of stats) {
    list.appendChild(buildStatRow(stat));
  }
  container.classList.remove("is-hidden");

  // Flush any buffered enrichment now that we have stats
  if (_pendingBestAttrs) renderBestAttributes(_pendingBestAttrs);
  if (_pendingListings) renderSimilarListings(_pendingListings);
}

/** Show the error banner with a reason instead of an endless "Waiting" spinner. */
function showScanError(message) {
  hideScanning();
  _hasDisplayedStats = false;
  const banner = el("error-banner");
  el("stats-container").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");
  if (banner) {
    if (message) banner.textContent = message;
    banner.classList.add("visible");
  }
}

/** State: current stat names (lowercase) for best-attribute matching. */
let _currentStatNamesLc = [];

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

/**
 * Apply grading data to already-rendered stat rows.
 * Grading data arrives AFTER stats are rendered (separate IPC event),
 * so we overlay grade badges onto existing rows.
 */
function applyGradingToStats(gradingResult) {
  if (!gradingResult) return;
  const { stats, attributeGrade } = gradingResult;

  renderOverallGrade(attributeGrade);

  if (!Array.isArray(stats)) return;

  // Re-render stats with grading info baked in
  const list = el("stats-list");
  const container = el("stats-container");
  if (!list || !container) return;

  list.innerHTML = "";
  for (const stat of stats) {
    list.appendChild(buildStatRow(stat));
  }
  container.classList.remove("is-hidden");

  // Update tracked stat names for best-attribute matching
  _currentStatNamesLc = stats.map(function (s) {
    return (s.name || "").toLowerCase();
  });
  refreshBestAttributeHighlights();
}

/**
 * Handle initial grading (single panel - current stats).
 */
function onGradingInitial(grading) {
  if (_isLeft) {
    applyGradingToStats(grading);
  }
}

/**
 * Handle roll grading (both panels - left=current, right=new roll).
 */
function onGradingRoll(payload) {
  if (!payload) return;
  const side = _isLeft ? payload.left : payload.right;
  applyGradingToStats(side);
}

let _bestAttributesData = null;

function renderBestAttributes(attrs) {
  _bestAttributesData = attrs;
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

  // Positive row
  if (Array.isArray(attrs.positives) && attrs.positives.length > 0) {
    var label = document.createElement("span");
    label.className = "best-row-label pos";
    label.textContent = "BEST";
    posRow.appendChild(label);

    for (var i = 0; i < attrs.positives.length; i++) {
      var chip = document.createElement("span");
      chip.className = "best-chip";
      chip.setAttribute("data-stat", attrs.positives[i].toLowerCase());
      chip.textContent = abbreviateStat(attrs.positives[i]);
      posRow.appendChild(chip);
    }
  }

  // Negative row
  if (Array.isArray(attrs.negatives) && attrs.negatives.length > 0) {
    var negLabel = document.createElement("span");
    negLabel.className = "best-row-label neg";
    negLabel.textContent = "NEG";
    negRow.appendChild(negLabel);

    for (var j = 0; j < attrs.negatives.length; j++) {
      var negChip = document.createElement("span");
      negChip.className = "best-chip";
      negChip.setAttribute("data-stat", attrs.negatives[j].toLowerCase());
      negChip.textContent = abbreviateStat(attrs.negatives[j]);
      negRow.appendChild(negChip);
    }
  }

  wrapper.classList.remove("is-hidden");
  refreshBestAttributeHighlights();
}

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

/** Highlight best-attribute chips that match currently displayed stats. */
function refreshBestAttributeHighlights() {
  var chips = document.querySelectorAll(".best-chip");
  for (var i = 0; i < chips.length; i++) {
    var chipStat = (chips[i].getAttribute("data-stat") || "").toLowerCase();
    var matched = _currentStatNamesLc.some(function (n) {
      return n === chipStat || n.indexOf(chipStat) !== -1 || chipStat.indexOf(n) !== -1;
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

  var myStats = _currentStatNamesLc.slice();
  var enriched = [];
  for (var i = 0; i < listings.length; i++) {
    var sim = computeRivenStatSimilarity(myStats, listings[i].stats);
    enriched.push({ item: listings[i], pct: sim.pct, matchedNames: sim.matchedNames });
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
    simEl.textContent = pct + "% match";
    card.appendChild(simEl);

    var topRow = document.createElement("div");
    topRow.className = "listing-card-top";

    var priceEl = document.createElement("span");
    priceEl.className = "listing-price";
    var price = item.buyoutPrice || item.startingPrice || item.platinum || 0;
    priceEl.textContent = price + "p";
    topRow.appendChild(priceEl);

    var rerollsEl = document.createElement("span");
    rerollsEl.className = "listing-rerolls";
    rerollsEl.textContent = (item.rerolls || 0) + " rolls";
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
        var sign = s.positive ? "+" : "\u2212";
        line.textContent = sign + Math.round(s.value) + "% " + abbreviateStat(s.name);
        statsCol.appendChild(line);
      }
      card.appendChild(statsCol);
    }

    list.appendChild(card);
  }

  wrapper.classList.remove("is-hidden");
}

function showScanning() {
  el("scanning-state").classList.add("visible");
  el("stats-container").classList.add("is-hidden");
  el("error-banner").classList.remove("visible");
}

function hideScanning() {
  el("scanning-state").classList.remove("visible");
}

function onSessionStart(weapon) {
  _rollCount = 0;
  _currentStatNamesLc = [];
  _bestAttributesData = null;
  _hasDisplayedStats = false;
  _pendingBestAttrs = null;
  _pendingListings = null;

  el("weapon-name").textContent = weapon || "\u2014";

  const rollBadge = el("roll-badge");
  if (rollBadge) rollBadge.textContent = "Roll 0";

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
    el("scanning-text").textContent = "Scanning current stats\u2026";
  } else {
    renderStats([]); // shows "Waiting for roll..."
  }
}

function onInitialStats(stats) {
  hideScanning();
  // Only the left (current) panel uses initial stats
  if (!_isLeft) return;
  if (Array.isArray(stats) && stats.length > 0) {
    renderStats(stats);
  } else {
    // Scan ran but read nothing - tell the user why instead of sitting on
    // "Waiting for scan...". The usual cause is Warframe in windowed mode.
    showScanError(
      "Couldn't read the riven. Set Warframe to Fullscreen or Borderless (not Windowed).",
    );
  }
}

function onScanning() {
  showScanning();
  el("scanning-text").textContent = "Scanning riven stats\u2026";
}

function onRollResult(payload) {
  const { rollCount, left, right } = payload || {};

  _rollCount = Number(rollCount) || _rollCount + 1;

  const rollBadge = el("roll-badge");
  if (rollBadge) rollBadge.textContent = "Roll " + _rollCount;

  hideScanning();

  // Each window displays only its side's data
  const stats = _isLeft ? left : right;
  const hasStats = Array.isArray(stats) && stats.length > 0;

  if (hasStats) {
    renderStats(stats);
  } else {
    showScanError(
      "Couldn't read the new roll. Set Warframe to Fullscreen or Borderless (not Windowed).",
    );
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

  // After a choice the game returns to single-card view.
  // Reset the right (new roll) panel back to "Waiting for roll..."
  // Use a short delay only when the right panel has a highlight to let it show
  // briefly; otherwise reset immediately so stale roll data doesn't linger.
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
    el("scanning-text").textContent = "Scanning current stats\u2026";
  }
}

function onSessionEnd() {
  hideScanning();
  _currentStatNamesLc = [];
  _bestAttributesData = null;
  _hasDisplayedStats = false;
  _pendingBestAttrs = null;
  _pendingListings = null;
  el("overall-grade").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  const panel = el("panel");
  const labelEl = el("panel-label");

  if (_isLeft) {
    if (labelEl) labelEl.textContent = "CURRENT";
  } else {
    if (panel) panel.classList.add("is-new");
    if (labelEl) labelEl.textContent = "NEW ROLL";
  }

  window.overlayTheme.loadThemeFromStorageFallback();
  void window.rivenOverlay
    .getThemeVars()
    .then((vars) => window.overlayTheme.applyThemeVars(vars))
    .catch(() => {
      // best effort, storage fallback already applied
    });

  el("btn-close").addEventListener("click", () => window.rivenOverlay.close());
  window.installOverlayDrag({
    isInteractive: () => _overlayInteractiveMode,
    moveBy: (dx, dy) => window.rivenOverlay.moveBy(dx, dy),
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.rivenOverlay.close();
    }
  });

  setOverlayInteractiveMode(false);
  renderStats([]);
  window.rivenOverlay.onThemeVars((vars) => window.overlayTheme.applyThemeVars(vars));
  window.rivenOverlay.onSessionStart((weapon) => onSessionStart(weapon));
  window.rivenOverlay.onInitialStats((stats) => onInitialStats(stats));
  window.rivenOverlay.onScanning(() => onScanning());
  window.rivenOverlay.onRollResult((payload) => onRollResult(payload));
  window.rivenOverlay.onChoiceMade((side) => onChoiceMade(side));
  window.rivenOverlay.onSessionEnd(() => onSessionEnd());
  window.rivenOverlay.onWeaponUpdate((weapon) => {
    el("weapon-name").textContent = weapon || "\u2014";
  });
  window.rivenOverlay.onInteractionMode((payload) => {
    setOverlayInteractiveMode(Boolean(payload?.interactive));
  });

  window.rivenOverlay.onGradingInitial((grading) => onGradingInitial(grading));
  window.rivenOverlay.onGradingRoll((payload) => onGradingRoll(payload));
  window.rivenOverlay.onBestAttributes((attrs) => renderBestAttributes(attrs));
  window.rivenOverlay.onSimilarListings((listings) => renderSimilarListings(listings));
});
