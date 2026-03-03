const log = require('./logger').withScope('rewardScanner');
"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = require('../config/runtime/overlaySettings');

const OCR_SCRIPT = path.join(__dirname, '..', 'scripts', 'ocr.ps1');
const TEMP_IMAGE = path.join(os.tmpdir(), 'wf-companion-reward-ocr.png');

const OCR_ENGINE_AUTO = 'auto';
const OCR_ENGINE_WINDOWS = 'windows';
const OCR_ENGINE_POWERSHELL = 'powershell';
const OCR_ENGINE_TESSERACT = 'tesseract';
const OCR_ENGINE_ENV = String(process.env.WF_OCR_ENGINE || OCR_ENGINE_AUTO).trim().toLowerCase();
const TESSERACT_LANGUAGE = 'eng';

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

const DEFAULT_SCAN_SETTINGS = OVERLAY_SETTINGS_DEFAULTS;

let relicItems = [];
let sortedItems = [];
let scanSettings = sanitizeSettings(DEFAULT_SCAN_SETTINGS);

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

function normalizeOcrEngine(value, fallback = OCR_ENGINE_WINDOWS) {
  const v = String(value || '').trim().toLowerCase();
  if (v === OCR_ENGINE_WINDOWS || v === OCR_ENGINE_POWERSHELL) return OCR_ENGINE_WINDOWS;
  if (v === OCR_ENGINE_TESSERACT) return OCR_ENGINE_TESSERACT;
  if (v === OCR_ENGINE_AUTO) return OCR_ENGINE_AUTO;
  return fallback;
}

function sanitizeSettings(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const preset = typeof candidate.cropPreset === 'string' ? candidate.cropPreset.trim().toLowerCase() : '';

  let cropTopRatio = clampNumber(
    candidate.cropTopRatio,
    OVERLAY_SETTINGS_LIMITS.cropTopRatioMin,
    OVERLAY_SETTINGS_LIMITS.cropTopRatioMax,
    DEFAULT_SCAN_SETTINGS.cropTopRatio,
  );
  let cropHeightRatio = clampNumber(
    candidate.cropHeightRatio,
    OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin,
    OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax,
    DEFAULT_SCAN_SETTINGS.cropHeightRatio,
  );

  const minHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin;
  if ((cropTopRatio + cropHeightRatio) > 1.0) {
    cropHeightRatio = Math.max(minHeight, 1.0 - cropTopRatio);
  }
  if ((cropTopRatio + cropHeightRatio) > 1.0) {
    cropTopRatio = Math.max(0, 1.0 - cropHeightRatio);
  }

  return {
    cropPreset: preset === 'custom' || CROP_PRESETS[preset]
      ? preset
      : DEFAULT_SCAN_SETTINGS.cropPreset,
    cropTopRatio,
    cropHeightRatio,
    ocrEngine: normalizeOcrEngine(candidate.ocrEngine, DEFAULT_SCAN_SETTINGS.ocrEngine),
    ocrPasses: Math.floor(clampNumber(
      candidate.ocrPasses,
      OVERLAY_SETTINGS_LIMITS.ocrPassesMin,
      OVERLAY_SETTINGS_LIMITS.ocrPassesMax,
      DEFAULT_SCAN_SETTINGS.ocrPasses,
    )),
    matchThreshold: clampNumber(
      candidate.matchThreshold,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMin,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMax,
      DEFAULT_SCAN_SETTINGS.matchThreshold,
    ),
    ocrTimeoutMs: Math.floor(clampNumber(
      candidate.ocrTimeoutMs,
      OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin,
      OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax,
      DEFAULT_SCAN_SETTINGS.ocrTimeoutMs,
    )),
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
    ({ desktopCapturer } = require('electron'));
  } catch {
    log.warn('[RewardScanner] electron.desktopCapturer unavailable');
    return null;
  }

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    log.warn('[RewardScanner] getSources(window) failed:', err.message);
    sources = [];
  }

  const wfWindow = sources.find((s) => /warframe/i.test(s.name) && !/companion/i.test(s.name));
  if (wfWindow) return wfWindow.thumbnail;

  try {
    const screens = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (screens.length > 0) return screens[0].thumbnail;
  } catch (err) {
    log.warn('[RewardScanner] getSources(screen) failed:', err.message);
  }

  return null;
}

async function captureDebugFrame() {
  const screenshot = await captureScreen();
  if (!screenshot) return null;
  const size = screenshot.getSize();
  return {
    imageDataUrl: screenshot.toDataURL(),
    width: size.width,
    height: size.height,
  };
}

function cropRewardBand(nativeImage, band) {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const maxHeightRatio = Math.max(0.05, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.05, maxHeightRatio, 0.36);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

function getRequestedOcrEngine() {
  const envEngine = normalizeOcrEngine(OCR_ENGINE_ENV, OCR_ENGINE_AUTO);
  if (envEngine !== OCR_ENGINE_AUTO) return envEngine;
  return normalizeOcrEngine(scanSettings.ocrEngine, OCR_ENGINE_WINDOWS);
}

function timeoutWrap(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function runPowerShellOCR(imagePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', OCR_SCRIPT, imagePath],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`PowerShell OCR failed: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`));
          return;
        }
        resolve(stdout || '');
      }
    );
  });
}

async function runTesseractOCR(imagePath, timeoutMs) {
  let tesseract;
  try {
    tesseract = require('tesseract.js');
  } catch (error) {
    throw new Error(`Tesseract OCR unavailable: ${error.message}`);
  }

  const recognizePromise = tesseract.recognize(imagePath, TESSERACT_LANGUAGE, {
    logger: () => {},
  });

  const result = await timeoutWrap(recognizePromise, timeoutMs, 'Tesseract OCR');
  return result?.data?.text || '';
}

async function runOCR(imagePath, timeoutMs) {
  const engine = getRequestedOcrEngine();

  if (engine === OCR_ENGINE_WINDOWS) {
    if (process.platform !== 'win32') {
      log.warn('[RewardScanner] Windows OCR selected on non-Windows platform. Falling back to Tesseract.');
      return runTesseractOCR(imagePath, timeoutMs);
    }
    return runPowerShellOCR(imagePath, timeoutMs);
  }

  if (engine === OCR_ENGINE_TESSERACT) {
    return runTesseractOCR(imagePath, timeoutMs);
  }

  // Auto mode: PowerShell first on Windows, then Tesseract fallback.
  let powerShellError = null;
  if (process.platform === 'win32') {
    try {
      return await runPowerShellOCR(imagePath, timeoutMs);
    } catch (error) {
      powerShellError = error;
      log.warn('[RewardScanner] PowerShell OCR failed in auto mode, falling back:', error.message);
    }
  }

  try {
    return await runTesseractOCR(imagePath, timeoutMs);
  } catch (error) {
    if (powerShellError) {
      throw new Error(`OCR failed (Windows + Tesseract): ${powerShellError.message} | ${error.message}`);
    }
    throw error;
  }
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildWordSet(text) {
  return new Set(
    text
      .split(' ')
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
        mode: 'exact',
      });
      usedNames.add(normalizedName);
    }
  }

  if (found.length < 4) {
    for (const item of sortedItems) {
      if (found.length >= 4) break;
      const normalizedName = norm(item.name);
      if (!normalizedName || usedNames.has(normalizedName)) continue;
      const itemWords = normalizedName.split(' ').filter((w) => w.length > 2);
      if (itemWords.length === 0) continue;

      const matchedWords = itemWords.filter((w) => words.has(w)).length;
      const ratio = matchedWords / itemWords.length;
      if (ratio >= threshold) {
        const firstWord = itemWords.find((w) => words.has(w)) || '';
        const pos = firstWord ? text.indexOf(firstWord) : text.length;
        found.push({
          item,
          pos,
          confidence: ratio,
          mode: 'overlap',
        });
        usedNames.add(normalizedName);
      }
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const exactCount = found.filter((m) => m.mode === 'exact').length;
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
  if (presetName === 'custom') {
    const customTop = clampNumber(
      scanSettings.cropTopRatio,
      OVERLAY_SETTINGS_LIMITS.cropTopRatioMin,
      OVERLAY_SETTINGS_LIMITS.cropTopRatioMax,
      DEFAULT_SCAN_SETTINGS.cropTopRatio,
    );
    const customHeight = clampNumber(
      scanSettings.cropHeightRatio,
      OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin,
      OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax,
      DEFAULT_SCAN_SETTINGS.cropHeightRatio,
    );

    const bands = [];
    const center = Math.floor(passes / 2);
    for (let i = 0; i < passes; i += 1) {
      const shift = (i - center) * 0.01;
      const shiftedTop = clampNumber(
        customTop + shift,
        0,
        Math.max(0, 1.0 - customHeight),
        customTop,
      );
      bands.push({ top: shiftedTop, height: customHeight });
    }
    return bands;
  }

  const preset = CROP_PRESETS[presetName] || CROP_PRESETS.balanced;
  const bands = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

async function scanRewards() {
  if (sortedItems.length === 0) {
    log.warn('[RewardScanner] No relic items loaded - call setRelicItems() first');
    return null;
  }

  let screenshot;
  try {
    screenshot = await captureScreen();
  } catch (err) {
    log.error('[RewardScanner] captureScreen error:', err.message);
    return null;
  }
  if (!screenshot) {
    log.warn('[RewardScanner] Could not capture screen');
    return null;
  }

  const threshold = scanSettings.matchThreshold;
  const bands = getBandsForPasses(scanSettings.cropPreset, scanSettings.ocrPasses);

  let best = { items: [], score: -1, passIndex: -1, text: '' };
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

    let ocrText;
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

    if (matched.items.length === 4 && matched.matches.every((m) => m.mode === 'exact')) {
      break;
    }
  }

  if (!hadOcrSuccess) return null;

  if (best.items.length > 0) {
    log.log(
      `[RewardScanner] Detected (pass ${best.passIndex}, score ${best.score.toFixed(2)}):`,
      best.items.map((i) => i.name).join(' | ')
    );
    return best.items.slice(0, 4);
  }

  if (best.text) {
    log.log('[RewardScanner] No items matched OCR text:', best.text.slice(0, 240).replace(/\s+/g, ' '));
  } else {
    log.log('[RewardScanner] No items matched OCR text');
  }
  return [];
}

module.exports = {
  DEFAULT_SCAN_SETTINGS,
  setRelicItems,
  setSettings,
  getSettings,
  captureDebugFrame,
  scanRewards,
};