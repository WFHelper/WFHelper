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

  el("weapon-name").textContent = weapon || "\u2014";

  const rollBadge = el("roll-badge");
  if (rollBadge) rollBadge.textContent = "Roll 0";

  // Reset stats
  el("stats-container").classList.add("is-hidden");
  el("error-banner").classList.remove("visible");

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
});
