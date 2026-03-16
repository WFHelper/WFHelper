// ── Determine which side this window represents ─────────────────────────────
// Passed via URL search param: riven-overlay.html?side=left or ?side=right

const _side = new URLSearchParams(window.location.search).get("side") || "left";
const _isLeft = _side === "left";

// ── State ────────────────────────────────────────────────────────────────────

let _rollCount = 0;
let _overlayInteractiveMode = false;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(id) {
  return document.getElementById(id);
}

function setOverlayInteractiveMode(interactive) {
  _overlayInteractiveMode = !!interactive;
  const closeButton = el("btn-close");
  if (closeButton) closeButton.classList.toggle("is-hidden", !_overlayInteractiveMode);
  const hint = el("interaction-hint");
  if (hint) hint.classList.toggle("is-hidden", _overlayInteractiveMode);
}

// ── Theme ────────────────────────────────────────────────────────────────────

function applyThemeVars(rawVars) {
  if (!rawVars || typeof rawVars !== "object") return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(rawVars)) {
    if (!key.startsWith("--")) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    root.style.setProperty(key, value.trim());
  }
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
      "--bg-deep": colors.bgDeep,
      "--bg-base": colors.bgBase,
      "--bg-surface": colors.bgSurface,
      "--bg-raised": colors.bgRaised,
      "--bg-hover": colors.bgHover,
      "--accent": colors.accent,
      "--accent-dim": colors.accentDim,
      "--accent-bright": colors.accentBright,
      "--text-primary": colors.textPrimary,
      "--text-secondary": colors.textSecondary,
      "--text-muted": colors.textMuted,
      "--success": colors.success,
      "--warning": colors.warning,
      "--danger": colors.danger,
      "--info": colors.info,
      "--border": colors.border,
      "--border-strong": colors.borderStrong,
      "--font-display": '"Rajdhani", sans-serif',
      "--font-body": '"Barlow", sans-serif',
    };

    const glow = hexToAccentGlow(colors.accent);
    if (glow) map["--accent-glow"] = glow;

    if (fontSizes && typeof fontSizes === "object") {
      if (typeof fontSizes.headingSize === "number" && Number.isFinite(fontSizes.headingSize))
        map["--font-heading-size"] = `${fontSizes.headingSize}rem`;
      if (typeof fontSizes.bodySize === "number" && Number.isFinite(fontSizes.bodySize))
        map["--font-body-size"] = `${fontSizes.bodySize}rem`;
      if (typeof fontSizes.smallSize === "number" && Number.isFinite(fontSizes.smallSize))
        map["--font-small-size"] = `${fontSizes.smallSize}rem`;
    }

    applyThemeVars(map);
  } catch {
    // ignore malformed local storage
  }
}

// ── Grading helpers ──────────────────────────────────────────────────────────

/** Map a letter grade string to its CSS class suffix. */
function gradeClass(grade) {
  if (!grade || grade === "?") return "grade-unknown";
  // "A+" → "grade-Ap", "A-" → "grade-Am", "B+" → "grade-Bp", etc.
  const sanitised = String(grade).replace("+", "p").replace("-", "m").replace(/[^A-Za-z]/g, "");
  return "grade-" + (sanitised || "unknown");
}

/** Create a grade badge span. */
function buildGradeBadge(grade, large) {
  const badge = document.createElement("span");
  badge.className = "grade-badge " + gradeClass(grade) + (large ? " grade-large" : "");
  badge.textContent = grade || "?";
  return badge;
}

// ── Stat rendering ──────────────────────────────────────────────────────────

function buildStatRow(stat) {
  const row = document.createElement("div");
  row.className = "stat-row";

  const valueEl = document.createElement("span");
  if (stat.multiplier && stat.value != null) {
    // x-multiplier format: "x0.62" instead of "+0.62%"
    valueEl.textContent = "x" + stat.value;
    valueEl.className = "stat-value pos";
  } else {
    const sign = stat.positive ? "+" : "\u2212";
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

  // Grade badge (if grading data is present on the stat)
  if (stat.grade) {
    const badge = buildGradeBadge(stat.grade);
    badge.classList.add("stat-grade");
    row.appendChild(badge);
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
    const empty = document.createElement("div");
    empty.className = "stat-empty";
    empty.textContent = _isLeft ? "Waiting for scan\u2026" : "Waiting for roll\u2026";
    list.appendChild(empty);
    container.classList.remove("is-hidden");
    if (errorEl) errorEl.classList.remove("visible");
    return;
  }

  if (errorEl) errorEl.classList.remove("visible");
  for (const stat of stats) {
    list.appendChild(buildStatRow(stat));
  }
  container.classList.remove("is-hidden");
}

// ── IPC event handlers ───────────────────────────────────────────────────────

// ── Grading display ──────────────────────────────────────────────────────────

/** State: current stat names (lowercase) for best-attribute matching. */
let _currentStatNamesLc = [];

function renderOverallGrade(gradeStr) {
  const wrapper = el("overall-grade");
  const badge = el("overall-grade-badge");
  if (!wrapper || !badge) return;

  if (!gradeStr || gradeStr === "?") {
    wrapper.classList.add("is-hidden");
    return;
  }

  badge.className = "grade-badge grade-large " + gradeClass(gradeStr);
  badge.textContent = gradeStr;
  wrapper.classList.remove("is-hidden");
}

/**
 * Apply grading data to already-rendered stat rows.
 * Grading data arrives AFTER stats are rendered (separate IPC event),
 * so we overlay grade badges onto existing rows.
 */
function applyGradingToStats(gradingResult) {
  if (!gradingResult) return;
  const { stats, overallGrade } = gradingResult;

  renderOverallGrade(overallGrade);

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
  _currentStatNamesLc = stats.map(function (s) { return (s.name || "").toLowerCase(); });
  refreshBestAttributeHighlights();
}

/**
 * Handle initial grading (single panel — current stats).
 */
function onGradingInitial(grading) {
  if (_isLeft) {
    applyGradingToStats(grading);
  }
}

/**
 * Handle roll grading (both panels — left=current, right=new roll).
 */
function onGradingRoll(payload) {
  if (!payload) return;
  const side = _isLeft ? payload.left : payload.right;
  applyGradingToStats(side);
}

// ── Best attributes display ──────────────────────────────────────────────────

let _bestAttributesData = null;

function renderBestAttributes(attrs) {
  _bestAttributesData = attrs;
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

/** Abbreviate long stat names for compact chip display. */
function abbreviateStat(name) {
  var abbrevs = {
    "critical chance": "CritCh",
    "critical damage": "CritDmg",
    "multishot": "Multi",
    "damage": "Dmg",
    "melee damage": "Dmg",
    "status chance": "Status",
    "attack speed": "AtkSpd",
    "electricity": "Elec",
    "toxin": "Toxin",
    "heat": "Heat",
    "cold": "Cold",
    "range": "Range",
    "zoom": "Zoom",
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
  return abbrevs[name.toLowerCase()] || name;
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

// ── Similar listings display ─────────────────────────────────────────────────

function renderSimilarListings(listings) {
  var wrapper = el("similar-listings");
  var list = el("similar-list");
  if (!wrapper || !list) return;

  list.innerHTML = "";

  if (!Array.isArray(listings) || listings.length === 0) {
    wrapper.classList.add("is-hidden");
    return;
  }

  for (var i = 0; i < listings.length; i++) {
    var item = listings[i];
    var row = document.createElement("div");
    row.className = "listing-row";

    // Price
    var priceEl = document.createElement("span");
    priceEl.className = "listing-price";
    var price = item.buyoutPrice || item.startingPrice || item.platinum || 0;
    priceEl.textContent = price + "p";
    row.appendChild(priceEl);

    // Stats summary (abbreviated)
    var statsEl = document.createElement("span");
    statsEl.className = "listing-stats";
    if (Array.isArray(item.stats)) {
      var parts = [];
      for (var j = 0; j < item.stats.length; j++) {
        var s = item.stats[j];
        var sign = s.positive ? "+" : "\u2212";
        parts.push(sign + Math.round(s.value) + "% " + abbreviateStat(s.name));
      }
      statsEl.textContent = parts.join("  ");
    }
    row.appendChild(statsEl);

    // Rerolls
    var rerollsEl = document.createElement("span");
    rerollsEl.className = "listing-rerolls";
    rerollsEl.textContent = (item.rerolls || 0) + "r";
    row.appendChild(rerollsEl);

    list.appendChild(row);
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
  if (_isLeft) {
    renderStats(stats);
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
    // No stats detected for this side — show error
    el("stats-container").classList.add("is-hidden");
    el("error-banner").classList.add("visible");
  }
}

function onChoiceMade(side) {
  // Show a visual indicator of which choice was made
  const panel = el("panel");
  if (!panel) return;

  if (side === "left" && _isLeft) {
    // User kept old (this panel) — highlight briefly
    panel.style.borderColor = "var(--ok)";
    setTimeout(() => { panel.style.borderColor = ""; }, 2000);
  } else if (side === "right" && !_isLeft) {
    // User took new roll (this panel) — highlight briefly
    panel.style.borderColor = "var(--ok)";
    setTimeout(() => { panel.style.borderColor = ""; }, 2000);
  }

  // After a choice the game returns to single-card view.
  // Reset the right (new roll) panel back to "Waiting for roll…"
  // Use a short delay only when the right panel has a highlight to let it show
  // briefly; otherwise reset immediately so stale roll data doesn't linger.
  if (!_isLeft) {
    const delay = (side === "right") ? 2000 : 0;
    setTimeout(() => {
      renderStats([]); // shows "Waiting for roll…"
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
  el("overall-grade").classList.add("is-hidden");
  el("best-attributes").classList.add("is-hidden");
  el("similar-listings").classList.add("is-hidden");
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Configure panel appearance based on side
  const panel = el("panel");
  const labelEl = el("panel-label");

  if (_isLeft) {
    if (labelEl) labelEl.textContent = "CURRENT";
  } else {
    if (panel) panel.classList.add("is-new");
    if (labelEl) labelEl.textContent = "NEW ROLL";
  }

  // Theme: local storage fallback first, then IPC
  loadThemeFromStorageFallback();
  void window.rivenOverlay
    .getThemeVars()
    .then((vars) => applyThemeVars(vars))
    .catch(() => {
      // best effort, storage fallback already applied
    });

  // Close button + keyboard
  el("btn-close").addEventListener("click", () => window.rivenOverlay.close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.rivenOverlay.close();
    }
  });

  // Start in passive mode (close button hidden, hint shown)
  setOverlayInteractiveMode(false);

  // Show initial waiting state
  renderStats([]);

  // Register IPC listeners
  window.rivenOverlay.onThemeVars((vars) => applyThemeVars(vars));
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

  // Grading + enrichment listeners
  window.rivenOverlay.onGradingInitial((grading) => onGradingInitial(grading));
  window.rivenOverlay.onGradingRoll((payload) => onGradingRoll(payload));
  window.rivenOverlay.onBestAttributes((attrs) => renderBestAttributes(attrs));
  window.rivenOverlay.onSimilarListings((listings) => renderSimilarListings(listings));
});
