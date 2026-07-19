let _runId = null;

function el(id) {
  return document.getElementById(id);
}

function formatDuration(totalSeconds) {
  const duration = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function missionLabel(data) {
  if (data.missionType === "defense") return "Defense";
  if (data.missionType === "interception") return "Interception";
  const raw = typeof data.missionTypeRaw === "string" ? data.missionTypeRaw : "";
  return raw
    ? raw
        .replace(/^MT_/, "")
        .toLowerCase()
        .replace(/(^|_)\w/g, (c) => c.replace("_", " ").toUpperCase())
    : "Arbitration";
}

function renderSummary(data) {
  if (!data || typeof data !== "object") return;
  _runId = typeof data.id === "string" ? data.id : null;

  el("run-node").textContent = data.node || "Unknown node";
  el("run-meta").textContent =
    `${missionLabel(data)} · ${formatDuration(data.durationSec)} · ${Number(data.rotations) || 0} rotations`;

  const mean = Number(data.expectedVitusMean);
  const std = Number(data.expectedVitusStd);
  const vitusEl = el("kpi-vitus");
  vitusEl.textContent = "";
  vitusEl.appendChild(document.createTextNode(Number.isFinite(mean) ? mean.toFixed(1) : "-"));
  if (Number.isFinite(std) && std > 0) {
    const sub = document.createElement("span");
    sub.className = "kpi-sub";
    sub.textContent = ` ±${std.toFixed(1)}`;
    vitusEl.appendChild(sub);
  }

  el("kpi-drones").textContent = (Number(data.drones) || 0).toLocaleString();
  el("kpi-kills").textContent = (Number(data.totalEnemies) || 0).toLocaleString();

  const pct = Number(data.pctTimeAt15Plus);
  el("kpi-saturation").textContent = Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "-";
}

document.addEventListener("DOMContentLoaded", () => {
  window.overlayTheme.loadThemeFromStorageFallback();
  void window.arbiSummary
    .getThemeVars()
    .then(window.overlayTheme.applyThemeVars)
    .catch(() => {
      // best effort, storage fallback already applied
    });

  el("btn-close").addEventListener("click", () => window.arbiSummary.close());
  el("btn-details").addEventListener("click", () => {
    if (_runId) window.arbiSummary.openDetails(_runId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.arbiSummary.close();
  });

  window.installOverlayDrag({
    isInteractive: () => true,
    moveBy: (dx, dy) => window.arbiSummary.moveBy(dx, dy),
  });

  window.arbiSummary.onData(renderSummary);
  window.arbiSummary.onThemeVars(window.overlayTheme.applyThemeVars);
  window.arbiSummary.ready();
});
