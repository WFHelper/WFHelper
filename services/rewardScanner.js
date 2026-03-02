const log = require('./logger').withScope('rewardScanner');
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const OCR_SCRIPT = path.join(__dirname, "..", "scripts", "ocr.ps1");
const TEMP_IMAGE = path.join(os.tmpdir(), "wf-companion-reward-ocr.png");

const CROP_PRESETS = {
  balanced: [
    { top: 0.38, height: 0.36 },
    { top: 0.36, height: 0.40 },
    { top: 0.40, height: 0.34 },
  ],
  tight: [
    { top: 0.42, height: 0.30 },
    { top: 0.40, height: 0.32 },
    { top: 0.44, height: 0.28 },
  ],
  wide: [
    { top: 0.34, height: 0.44 },
    { top: 0.32, height: 0.46 },
    { top: 0.36, height: 0.42 },
  ],
};

const DEFAULT_SCAN_SETTINGS = Object.freeze({
  cropPreset: "balanced",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15000,
});

let relicItems = [];
let sortedItems = [];
let scanSettings = { ...DEFAULT_SCAN_SETTINGS };

function setRelicItems(items) {
  relicItems = Array.isArray(items) ? items : [];
  sortedItems = [...relicItems].sort((a, b) => b.name.length - a.name.length);
  log.log(`[RewardScanner] Item list updated: ${relicItems.length} items`);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeSettings(raw) {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const preset = typeof candidate.cropPreset === "string" ? candidate.cropPreset.trim().toLowerCase() : "";
  return {
    cropPreset: CROP_PRESETS[preset] ? preset : DEFAULT_SCAN_SETTINGS.cropPreset,
    ocrPasses: Math.floor(clampNumber(candidate.ocrPasses, 1, 6, DEFAULT_SCAN_SETTINGS.ocrPasses)),
    matchThreshold: clampNumber(candidate.matchThreshold, 0.55, 0.95, DEFAULT_SCAN_SETTINGS.matchThreshold),
    ocrTimeoutMs: Math.floor(clampNumber(candidate.ocrTimeoutMs, 4000, 30000, DEFAULT_SCAN_SETTINGS.ocrTimeoutMs)),
  };
}

function setSettings(nextSettings) {
  scanSettings = sanitizeSettings({ ...scanSettings, ...(nextSettings || {}) });
  return getSettings();
}

function getSettings() {
  return { ...scanSettings };
}

async function captureScreen() {
  let desktopCapturer;
  try {
    ({ desktopCapturer } = require("electron"));
  } catch {
    log.warn("[RewardScanner] electron.desktopCapturer unavailable");
    return null;
  }

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    log.warn("[RewardScanner] getSources(window) failed:", err.message);
    sources = [];
  }

  const wfWindow = sources.find((s) => /warframe/i.test(s.name) && !/companion/i.test(s.name));
  if (wfWindow) return wfWindow.thumbnail;

  try {
    const screens = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (screens.length > 0) return screens[0].thumbnail;
  } catch (err) {
    log.warn("[RewardScanner] getSources(screen) failed:", err.message);
  }

  return null;
}

function cropRewardBand(nativeImage, band) {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const heightRatio = clampNumber(band?.height, 0.05, 1.0 - topRatio, 0.36);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

function runOCR(imagePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", OCR_SCRIPT, imagePath],
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`OCR process failed: ${err.message}${stderr ? ` | ${stderr.trim()}` : ""}`));
          return;
        }
        resolve(stdout || "");
      }
    );
  });
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function buildWordSet(text) {
  return new Set(
    text
      .split(" ")
      .map((w) => w.trim())
      .filter((w) => w.length > 2)
  );
}

function matchItemsDetailed(ocrText, threshold) {
  const text = norm(ocrText);
  if (!text) {
    return { items: [], score: 0, matches: [] };
  }

  const words = buildWordSet(text);
  const found = [];
  const usedNames = new Set();

  for (const item of sortedItems) {
    if (found.length >= 4) break;
    const normalizedName = norm(item.name);
    if (!normalizedName || usedNames.has(normalizedName)) continue;
    const idx = text.indexOf(normalizedName);
    if (idx >= 0) {
      found.push({
        item,
        pos: idx,
        confidence: 1,
        mode: "exact",
      });
      usedNames.add(normalizedName);
    }
  }

  if (found.length < 4) {
    for (const item of sortedItems) {
      if (found.length >= 4) break;
      const normalizedName = norm(item.name);
      if (!normalizedName || usedNames.has(normalizedName)) continue;
      const itemWords = normalizedName.split(" ").filter((w) => w.length > 2);
      if (itemWords.length === 0) continue;

      const matchedWords = itemWords.filter((w) => words.has(w)).length;
      const ratio = matchedWords / itemWords.length;
      if (ratio >= threshold) {
        const firstWord = itemWords.find((w) => words.has(w)) || "";
        const pos = firstWord ? text.indexOf(firstWord) : text.length;
        found.push({
          item,
          pos,
          confidence: ratio,
          mode: "overlap",
        });
        usedNames.add(normalizedName);
      }
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const exactCount = found.filter((m) => m.mode === "exact").length;
  const confidenceSum = found.reduce((sum, m) => sum + m.confidence, 0);
  const coverageBoost = Math.min(4, found.length) * 0.6;
  const exactBoost = exactCount * 0.35;
  const score = confidenceSum + coverageBoost + exactBoost;

  return {
    items: found.map((m) => ({ ...m.item, confidence: Number(m.confidence.toFixed(3)) })),
    score,
    matches: found,
  };
}

function getBandsForPasses(presetName, passes) {
  const preset = CROP_PRESETS[presetName] || CROP_PRESETS.balanced;
  const bands = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

async function scanRewards() {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  let screenshot;
  try {
    screenshot = await captureScreen();
  } catch (err) {
    log.error("[RewardScanner] captureScreen error:", err.message);
    return null;
  }
  if (!screenshot) {
    log.warn("[RewardScanner] Could not capture screen");
    return null;
  }

  const threshold = scanSettings.matchThreshold;
  const bands = getBandsForPasses(scanSettings.cropPreset, scanSettings.ocrPasses);

  let best = { items: [], score: -1, passIndex: -1, text: "" };
  let hadOcrSuccess = false;

  for (let i = 0; i < bands.length; i += 1) {
    let cropped;
    try {
      cropped = cropRewardBand(screenshot, bands[i]);
      fs.writeFileSync(TEMP_IMAGE, cropped.toPNG());
    } catch (err) {
      log.error(`[RewardScanner] crop/write failed on pass ${i + 1}:`, err.message);
      continue;
    }

    let ocrText = "";
    try {
      ocrText = await runOCR(TEMP_IMAGE, scanSettings.ocrTimeoutMs);
      hadOcrSuccess = true;
    } catch (err) {
      log.error(`[RewardScanner] OCR failed on pass ${i + 1}:`, err.message);
      continue;
    }

    const matched = matchItemsDetailed(ocrText, threshold);
    if (matched.score > best.score) {
      best = { ...matched, passIndex: i + 1, text: ocrText };
    }

    if (matched.items.length === 4 && matched.matches.every((m) => m.mode === "exact")) {
      break;
    }
  }

  if (!hadOcrSuccess) return null;

  if (best.items.length > 0) {
    log.log(
      `[RewardScanner] Detected (pass ${best.passIndex}, score ${best.score.toFixed(2)}):`,
      best.items.map((i) => i.name).join(" | ")
    );
    return best.items.slice(0, 4);
  }

  if (best.text) {
    log.log("[RewardScanner] No items matched OCR text:", best.text.slice(0, 240).replace(/\s+/g, " "));
  } else {
    log.log("[RewardScanner] No items matched OCR text");
  }
  return [];
}

module.exports = {
  DEFAULT_SCAN_SETTINGS,
  setRelicItems,
  setSettings,
  getSettings,
  scanRewards,
};
