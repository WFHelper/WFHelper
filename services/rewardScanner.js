"use strict";

const log = require('./logger').withScope('rewardScanner');

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

const CAPTURE_THUMBNAIL = Object.freeze({ width: 1920, height: 1080 });
const COMPANION_WINDOW_TOKENS = Object.freeze([
  'warframe companion',
  'ocr crop debugger',
  'relic reward',
  'overlay',
]);

const MAX_REWARD_SLOTS = 4;
const EXACT_MATCH_SKIP_OVERLAP_COUNT = 3;
const MIN_MATCHED_WORDS_FOR_OVERLAP = 2;
const OVERLAP_CONFIDENCE_FLOOR = 0.86;

const UI_READY_DEFAULT_TIMEOUT_MS = 2_200;
const UI_READY_DEFAULT_POLL_MS = 120;
const UI_READY_DEFAULT_REQUIRED_HITS = 2;
const UI_READY_DEFAULT_SCORE_THRESHOLD = 0.58;
const UI_READY_MIN_PEAK_COUNT = 3;
const UI_READY_MIN_TEXTURE_SCORE = 0.18;

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

function sourceName(source) {
  return String(source?.name || '').trim();
}

function isCompanionWindowSource(source) {
  const name = sourceName(source).toLowerCase();
  return COMPANION_WINDOW_TOKENS.some(token => name.includes(token));
}

function isWarframeWindowSource(source) {
  const name = sourceName(source).toLowerCase();
  return name.includes('warframe') && !isCompanionWindowSource(source);
}

function pickWindowSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return sources.find(isWarframeWindowSource) || null;
}

function pickScreenSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  let screenApi;
  try {
    ({ screen: screenApi } = require('electron'));
  } catch {
    return sources[0] || null;
  }

  try {
    const cursor = screenApi.getCursorScreenPoint();
    const display = screenApi.getDisplayNearestPoint(cursor);
    const displayId = String(display?.id ?? '');
    if (displayId) {
      const byCursorDisplay = sources.find(source => String(source?.display_id ?? '') === displayId);
      if (byCursorDisplay) return byCursorDisplay;
    }
  } catch (err) {
    log.warn('[RewardScanner] pickScreenSource cursor lookup failed:', err.message);
  }

  try {
    const primaryDisplay = screenApi.getPrimaryDisplay();
    const primaryId = String(primaryDisplay?.id ?? '');
    if (primaryId) {
      const byPrimaryDisplay = sources.find(source => String(source?.display_id ?? '') === primaryId);
      if (byPrimaryDisplay) return byPrimaryDisplay;
    }
  } catch (err) {
    log.warn('[RewardScanner] pickScreenSource primary lookup failed:', err.message);
  }

  return sources[0] || null;
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
      thumbnailSize: CAPTURE_THUMBNAIL,
      fetchWindowIcons: false,
    });
  } catch (err) {
    log.warn('[RewardScanner] getSources(window) failed:', err.message);
    sources = [];
  }

  const wfWindow = pickWindowSource(sources);
  if (wfWindow && wfWindow.thumbnail && !wfWindow.thumbnail.isEmpty()) {
    return {
      image: wfWindow.thumbnail,
      sourceType: 'window',
      sourceName: sourceName(wfWindow),
      sourceId: String(wfWindow.id || ''),
      sourceDisplayId: String(wfWindow.display_id || ''),
    };
  }

  try {
    const screens = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: CAPTURE_THUMBNAIL,
    });

    const pickedScreen = pickScreenSource(screens);
    if (pickedScreen && pickedScreen.thumbnail && !pickedScreen.thumbnail.isEmpty()) {
      return {
        image: pickedScreen.thumbnail,
        sourceType: 'screen',
        sourceName: sourceName(pickedScreen),
        sourceId: String(pickedScreen.id || ''),
        sourceDisplayId: String(pickedScreen.display_id || ''),
      };
    }
  } catch (err) {
    log.warn('[RewardScanner] getSources(screen) failed:', err.message);
  }

  return null;
}

async function captureDebugFrame() {
  const screenshot = await captureScreen();
  if (!screenshot) return null;
  const size = screenshot.image.getSize();

  const sourceLabel = screenshot.sourceType === 'window'
    ? `window: ${screenshot.sourceName || screenshot.sourceId || 'unknown'}`
    : `screen: ${screenshot.sourceName || screenshot.sourceDisplayId || screenshot.sourceId || 'unknown'}`;

  log.log(`[RewardScanner] Debug capture source -> ${sourceLabel}`);

  return {
    imageDataUrl: screenshot.image.toDataURL(),
    width: size.width,
    height: size.height,
    sourceLabel,
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
    return { items: [], score: 0, matches: [], exactCount: 0 };
  }

  const words = buildWordSet(text);
  const found = [];
  const usedNames = new Set();
  const overlapThreshold = Math.max(Number(threshold) || 0, OVERLAP_CONFIDENCE_FLOOR);

  for (const item of sortedItems) {
    if (found.length >= MAX_REWARD_SLOTS) break;
    const normalizedName = norm(item.name);
    if (!normalizedName || usedNames.has(normalizedName)) continue;

    const idx = text.indexOf(normalizedName);
    if (idx >= 0) {
      found.push({ item, pos: idx, confidence: 1, mode: 'exact' });
      usedNames.add(normalizedName);
    }
  }

  const exactCount = found.length;
  const shouldRunOverlapPass = exactCount < EXACT_MATCH_SKIP_OVERLAP_COUNT && found.length < MAX_REWARD_SLOTS;

  if (shouldRunOverlapPass) {
    for (const item of sortedItems) {
      if (found.length >= MAX_REWARD_SLOTS) break;
      const normalizedName = norm(item.name);
      if (!normalizedName || usedNames.has(normalizedName)) continue;

      const itemWords = normalizedName.split(' ').filter((w) => w.length > 2);
      if (itemWords.length === 0) continue;

      const matchedWords = itemWords.filter((w) => words.has(w)).length;
      if (matchedWords < MIN_MATCHED_WORDS_FOR_OVERLAP) continue;

      const ratio = matchedWords / itemWords.length;
      if (ratio < overlapThreshold) continue;

      const firstWord = itemWords.find((w) => words.has(w)) || '';
      const pos = firstWord ? text.indexOf(firstWord) : text.length;

      found.push({ item, pos, confidence: ratio, mode: 'overlap' });
      usedNames.add(normalizedName);
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const exactMatches = found.filter((m) => m.mode === 'exact').length;
  const confidenceSum = found.reduce((sum, m) => sum + m.confidence, 0);
  const coverageBoost = Math.min(MAX_REWARD_SLOTS, found.length) * 0.6;
  const exactBoost = exactMatches * 0.35;

  return {
    items: found.map((m) => ({ ...m.item, confidence: Number(m.confidence.toFixed(3)) })),
    score: confidenceSum + coverageBoost + exactBoost,
    matches: found,
    exactCount,
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

function clamp01(value) {
  return clampNumber(value, 0, 1, 0);
}

function getPrimaryBand() {
  const [band] = getBandsForPasses(scanSettings.cropPreset, 1);
  if (band && Number.isFinite(band.top) && Number.isFinite(band.height)) {
    return band;
  }
  return {
    top: scanSettings.cropTopRatio,
    height: scanSettings.cropHeightRatio,
  };
}

function luminanceFromBgr(blue, green, red) {
  return ((77 * red) + (150 * green) + (29 * blue)) >> 8;
}

function computeMeanAndStd(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, std: 0 };
  }

  let sum = 0;
  for (const value of values) {
    sum += value;
  }

  const mean = sum / values.length;
  let varianceSum = 0;
  for (const value of values) {
    const diff = value - mean;
    varianceSum += diff * diff;
  }

  const variance = varianceSum / values.length;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
  };
}

function analyzeRewardBandReadiness(nativeImage, band = getPrimaryBand()) {
  if (!nativeImage || typeof nativeImage.getSize !== 'function') {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  let cropped;
  try {
    cropped = cropRewardBand(nativeImage, band);
  } catch {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  const { width, height } = cropped.getSize();
  if (width < 40 || height < 24) {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  const bitmap = cropped.toBitmap();
  const stepX = Math.max(1, Math.floor(width / 420));
  const stepY = Math.max(1, Math.floor(height / 120));
  const sampleCols = Math.max(1, Math.floor(width / stepX));

  const energies = new Array(sampleCols).fill(0);

  for (let column = 0; column < sampleCols; column += 1) {
    const x = Math.min(width - 1, column * stepX);
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 0; y < height; y += stepY) {
      const idx = ((y * width) + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const lum = luminanceFromBgr(blue, green, red);

      sum += lum;
      sumSq += lum * lum;
      count += 1;
    }

    const mean = sum / Math.max(1, count);
    const variance = Math.max(0, (sumSq / Math.max(1, count)) - (mean * mean));
    energies[column] = variance;
  }

  const smoothed = energies.map((value, index) => {
    const prev = index > 0 ? energies[index - 1] : value;
    const next = index < (energies.length - 1) ? energies[index + 1] : value;
    return (prev + value + next) / 3;
  });

  const stats = computeMeanAndStd(smoothed);
  const threshold = stats.mean + (stats.std * 0.35);
  const minSegmentWidth = Math.max(3, Math.floor(sampleCols * 0.06));

  let peakCount = 0;
  let coverageCols = 0;
  let runLength = 0;

  for (let i = 0; i < smoothed.length; i += 1) {
    if (smoothed[i] > threshold) {
      runLength += 1;
      continue;
    }

    if (runLength >= minSegmentWidth) {
      peakCount += 1;
      coverageCols += runLength;
    }
    runLength = 0;
  }

  if (runLength >= minSegmentWidth) {
    peakCount += 1;
    coverageCols += runLength;
  }

  const peakScore = clamp01((peakCount - 2) / 2);
  const textureScore = clamp01((stats.std - 90) / 230);
  const coverageScore = clamp01((coverageCols / Math.max(1, sampleCols)) / 0.7);
  const score = (peakScore * 0.55) + (textureScore * 0.30) + (coverageScore * 0.15);

  const ready = peakCount >= UI_READY_MIN_PEAK_COUNT
    && textureScore >= UI_READY_MIN_TEXTURE_SCORE
    && score >= UI_READY_DEFAULT_SCORE_THRESHOLD;

  return {
    ready,
    score: Number(score.toFixed(3)),
    peakCount,
    textureScore: Number(textureScore.toFixed(3)),
    coverageScore: Number(coverageScore.toFixed(3)),
    bandTopRatio: round4(band?.top, 0),
    bandHeightRatio: round4(band?.height, 0),
    bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRewardUiReady(options = {}) {
  const timeoutMs = Math.floor(clampNumber(options.timeoutMs, 200, 8_000, UI_READY_DEFAULT_TIMEOUT_MS));
  const pollMs = Math.floor(clampNumber(options.pollMs, 60, 500, UI_READY_DEFAULT_POLL_MS));
  const requiredHits = Math.floor(clampNumber(options.requiredHits, 1, 4, UI_READY_DEFAULT_REQUIRED_HITS));
  const scoreThreshold = clampNumber(options.scoreThreshold, 0.35, 0.95, UI_READY_DEFAULT_SCORE_THRESHOLD);

  const band = options.band && Number.isFinite(options.band.top) && Number.isFinite(options.band.height)
    ? options.band
    : getPrimaryBand();

  const startedAt = Date.now();
  let attempts = 0;
  let consecutiveHits = 0;
  let best = null;

  while ((Date.now() - startedAt) < timeoutMs) {
    attempts += 1;

    const screenshot = await captureScreen();
    if (!screenshot || !screenshot.image) {
      consecutiveHits = 0;
      await sleep(pollMs);
      continue;
    }

    const readiness = analyzeRewardBandReadiness(screenshot.image, band);
    const sample = {
      ...readiness,
      sourceType: screenshot.sourceType || null,
      sourceDisplayId: screenshot.sourceDisplayId || null,
      sourceName: screenshot.sourceName || null,
      attempt: attempts,
    };

    if (!best || sample.score > best.score) {
      best = sample;
    }

    const hit = sample.peakCount >= UI_READY_MIN_PEAK_COUNT
      && sample.textureScore >= UI_READY_MIN_TEXTURE_SCORE
      && sample.score >= scoreThreshold;

    consecutiveHits = hit ? (consecutiveHits + 1) : 0;

    if (consecutiveHits >= requiredHits) {
      return {
        ready: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        threshold: scoreThreshold,
        best: sample,
      };
    }

    await sleep(pollMs);
  }

  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    threshold: scoreThreshold,
    best,
  };
}

function round4(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Number(n.toFixed(4));
}

function medianNumber(values, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return fallback;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function buildConsensusSelection(passResults) {
  const successful = passResults.filter((result) => result.items.length > 0);
  if (successful.length === 0) return null;

  if (successful.length === 1) {
    return {
      items: successful[0].items.slice(0, MAX_REWARD_SLOTS),
      selectedPass: successful[0],
      strategy: 'single-pass',
      targetCount: successful[0].items.length,
    };
  }

  const estimatedCount = Math.max(
    1,
    Math.min(
      MAX_REWARD_SLOTS,
      Math.round(medianNumber(successful.map((result) => result.items.length), successful[0].items.length)),
    ),
  );

  const votes = new Map();

  for (const result of successful) {
    const scoreWeight = Math.max(0.1, result.score);
    for (const match of result.matches) {
      const key = match.item.name;
      const existing = votes.get(key) || {
        item: match.item,
        hits: 0,
        weightedScore: 0,
        bestConfidence: 0,
        avgPosAccumulator: 0,
        avgPosCount: 0,
      };

      existing.hits += 1;
      existing.weightedScore += scoreWeight * Math.max(0.1, Number(match.confidence) || 0);
      existing.bestConfidence = Math.max(existing.bestConfidence, Number(match.confidence) || 0);

      if (Number.isFinite(match.pos) && match.pos >= 0) {
        existing.avgPosAccumulator += match.pos;
        existing.avgPosCount += 1;
      }

      votes.set(key, existing);
    }
  }

  const ranked = [...votes.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.bestConfidence !== a.bestConfidence) return b.bestConfidence - a.bestConfidence;
    return a.item.name.localeCompare(b.item.name);
  });

  const selectedWithPos = ranked
    .slice(0, estimatedCount)
    .map((entry) => {
      const avgPos = entry.avgPosCount > 0
        ? entry.avgPosAccumulator / entry.avgPosCount
        : Number.MAX_SAFE_INTEGER;
      return {
        avgPos,
        item: {
          ...entry.item,
          confidence: Number(entry.bestConfidence.toFixed(3)),
        },
      };
    })
    .sort((a, b) => a.avgPos - b.avgPos);

  const chosenItems = selectedWithPos.map((entry) => entry.item);

  const selectedPass = [...successful].sort((a, b) => {
    const aDelta = Math.abs(a.items.length - estimatedCount);
    const bDelta = Math.abs(b.items.length - estimatedCount);
    if (aDelta !== bDelta) return aDelta - bDelta;
    return b.score - a.score;
  })[0];

  return {
    items: chosenItems,
    selectedPass,
    strategy: 'consensus',
    targetCount: estimatedCount,
  };
}

function buildScanMeta({ screenshot, selectedPass, passCount, strategy, elapsedMs, hadOcrSuccess }) {
  const captureSize = screenshot?.image?.getSize?.() || { width: 0, height: 0 };
  const band = selectedPass?.band || null;
  const top = band ? round4(band.top, 0) : null;
  const height = band ? round4(band.height, 0) : null;
  const bottom = (top != null && height != null) ? round4(top + height, null) : null;

  return {
    sourceType: screenshot?.sourceType || null,
    sourceName: screenshot?.sourceName || null,
    sourceId: screenshot?.sourceId || null,
    sourceDisplayId: screenshot?.sourceDisplayId || null,
    captureWidth: captureSize.width,
    captureHeight: captureSize.height,
    passIndex: selectedPass?.passIndex ?? null,
    passCount,
    score: Number.isFinite(selectedPass?.score) ? Number(selectedPass.score.toFixed(3)) : null,
    strategy: strategy || 'none',
    hadOcrSuccess: !!hadOcrSuccess,
    bandTopRatio: top,
    bandHeightRatio: height,
    bandBottomRatio: bottom,
    elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
  };
}

async function scanRewardsDetailed() {
  if (sortedItems.length === 0) {
    log.warn('[RewardScanner] No relic items loaded - call setRelicItems() first');
    return null;
  }

  const scanStartedAt = Date.now();

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

  log.log(
    '[RewardScanner] Scan capture source -> ' +
    `${screenshot.sourceType}: ${screenshot.sourceName || screenshot.sourceId || 'unknown'} ` +
    `(display:${screenshot.sourceDisplayId || 'n/a'})`
  );

  const threshold = scanSettings.matchThreshold;
  const bands = getBandsForPasses(scanSettings.cropPreset, scanSettings.ocrPasses);

  let hadOcrSuccess = false;
  const passResults = [];
  let bestPass = null;

  for (let i = 0; i < bands.length; i += 1) {
    let cropped;
    try {
      cropped = cropRewardBand(screenshot.image, bands[i]);
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
    const passResult = {
      ...matched,
      passIndex: i + 1,
      band: bands[i],
      text: ocrText,
    };

    passResults.push(passResult);

    if (!bestPass || passResult.score > bestPass.score) {
      bestPass = passResult;
    }

    if (passResult.items.length === MAX_REWARD_SLOTS && passResult.exactCount === MAX_REWARD_SLOTS) {
      break;
    }
  }

  if (!hadOcrSuccess) {
    return null;
  }

  const consensus = buildConsensusSelection(passResults);
  const selectedPass = consensus?.selectedPass || bestPass || passResults[0] || null;
  const items = (consensus?.items || selectedPass?.items || []).slice(0, MAX_REWARD_SLOTS);

  if (items.length > 0) {
    log.log(
      `[RewardScanner] Detected (${consensus?.strategy || 'best-pass'} pass ${selectedPass?.passIndex ?? '?'}, ` +
      `score ${Number(selectedPass?.score || 0).toFixed(2)}):`,
      items.map((item) => item.name).join(' | ')
    );
  } else {
    const textPreview = selectedPass?.text
      ? selectedPass.text.slice(0, 240).replace(/\s+/g, ' ')
      : '';
    if (textPreview) {
      log.log('[RewardScanner] No items matched OCR text:', textPreview);
    } else {
      log.log('[RewardScanner] No items matched OCR text');
    }
  }

  const meta = buildScanMeta({
    screenshot,
    selectedPass,
    passCount: bands.length,
    strategy: consensus?.strategy || 'best-pass',
    elapsedMs: Date.now() - scanStartedAt,
    hadOcrSuccess,
  });

  return {
    items,
    meta,
  };
}

async function scanRewards() {
  const detailed = await scanRewardsDetailed();
  if (!detailed) return null;
  return detailed.items;
}

module.exports = {
  DEFAULT_SCAN_SETTINGS,
  setRelicItems,
  setSettings,
  getSettings,
  captureDebugFrame,
  scanRewards,
  scanRewardsDetailed,
  waitForRewardUiReady,
};
