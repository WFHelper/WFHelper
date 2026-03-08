"use strict";

/**
 * Electron screen / window capture helpers for reward scanning.
 * Isolates all `require("electron")` calls for desktopCapturer and screen.
 */

const log = require("./logger").withScope("rewardScanner");
const { clampNumber } = require("./rewardScannerUtils");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

const CAPTURE_THUMBNAIL_LIMITS = Object.freeze({
  minWidth: 1920,
  minHeight: 1080,
  maxWidth: 3200,
  maxHeight: 1800,
});

const COMPANION_WINDOW_TOKENS = Object.freeze([
  "warframe companion",
  "warframe-companion",
  "warframe_companion",
  "ocr crop debugger",
  "relic reward",
  "overlay",
  "visual studio code",
  "vscode",
  "github",
  "repository",
  "explorer",
  "file explorer",
]);

const WARFRAME_WINDOW_NAME_PATTERNS = Object.freeze([/^warframe\b/i]);

function sourceName(source) {
  return String(source?.name || "").trim();
}

function isCompanionWindowSource(source) {
  const name = sourceName(source).toLowerCase();
  return COMPANION_WINDOW_TOKENS.some((token) => name.includes(token));
}

function isWarframeWindowSource(source) {
  const name = sourceName(source).toLowerCase();
  if (!name.includes("warframe")) return false;
  if (isCompanionWindowSource(source)) return false;
  return WARFRAME_WINDOW_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function pickWindowSource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const candidates = sources.filter(isWarframeWindowSource);
  if (candidates.length === 0) return null;

  return (
    candidates.find((source) => /^warframe$/i.test(sourceName(source))) ||
    candidates.find((source) => /^warframe\s*[-:|].*$/i.test(sourceName(source))) ||
    candidates[0]
  );
}

function isLikelyWrongWindowName(name) {
  const low = String(name || "").toLowerCase();
  if (!low.includes("warframe")) return true;
  if (isCompanionWindowSource({ name: low })) return true;
  if (low.includes("github") || low.includes("readme") || low.includes("comparison.md"))
    return true;
  if (low.includes("visual studio") || low.includes("code")) return true;
  return false;
}

function pickScreenSource(sources, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const preferredDisplayId =
    options && typeof options.preferredDisplayId === "string" && options.preferredDisplayId.trim()
      ? options.preferredDisplayId.trim()
      : null;

  if (preferredDisplayId) {
    const byPreferredDisplay = sources.find(
      (source) => String(source?.display_id ?? "") === preferredDisplayId,
    );
    if (byPreferredDisplay) return byPreferredDisplay;
  }

  let screenApi;
  try {
    ({ screen: screenApi } = require("electron"));
  } catch {
    return sources[0] || null;
  }

  try {
    const cursor = screenApi.getCursorScreenPoint();
    const display = screenApi.getDisplayNearestPoint(cursor);
    const displayId = String(display?.id ?? "");
    if (displayId) {
      const byCursorDisplay = sources.find(
        (source) => String(source?.display_id ?? "") === displayId,
      );
      if (byCursorDisplay) return byCursorDisplay;
    }
  } catch (err) {
    log.warn("[RewardScanner] pickScreenSource cursor lookup failed:", normalizeErrorMessage(err));
  }

  try {
    const primaryDisplay = screenApi.getPrimaryDisplay();
    const primaryId = String(primaryDisplay?.id ?? "");
    if (primaryId) {
      const byPrimaryDisplay = sources.find(
        (source) => String(source?.display_id ?? "") === primaryId,
      );
      if (byPrimaryDisplay) return byPrimaryDisplay;
    }
  } catch (err) {
    log.warn("[RewardScanner] pickScreenSource primary lookup failed:", normalizeErrorMessage(err));
  }

  return sources[0] || null;
}

function getCaptureThumbnailSize() {
  let screenApi;
  try {
    ({ screen: screenApi } = require("electron"));
  } catch {
    return {
      width: CAPTURE_THUMBNAIL_LIMITS.minWidth,
      height: CAPTURE_THUMBNAIL_LIMITS.minHeight,
    };
  }

  try {
    const primary = screenApi.getPrimaryDisplay();
    const width = clampNumber(
      primary?.size?.width || 0,
      CAPTURE_THUMBNAIL_LIMITS.minWidth,
      CAPTURE_THUMBNAIL_LIMITS.maxWidth,
      CAPTURE_THUMBNAIL_LIMITS.minWidth,
    );
    const height = clampNumber(
      primary?.size?.height || 0,
      CAPTURE_THUMBNAIL_LIMITS.minHeight,
      CAPTURE_THUMBNAIL_LIMITS.maxHeight,
      CAPTURE_THUMBNAIL_LIMITS.minHeight,
    );

    return {
      width: Math.floor(width),
      height: Math.floor(height),
    };
  } catch {
    return {
      width: CAPTURE_THUMBNAIL_LIMITS.minWidth,
      height: CAPTURE_THUMBNAIL_LIMITS.minHeight,
    };
  }
}

async function captureScreen(options = {}) {
  let desktopCapturer;
  try {
    ({ desktopCapturer } = require("electron"));
  } catch {
    log.warn("[RewardScanner] electron.desktopCapturer unavailable");
    return null;
  }

  let sources;
  const thumbnailSize = getCaptureThumbnailSize();
  try {
    sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize,
      fetchWindowIcons: false,
    });
  } catch (err) {
    log.warn("[RewardScanner] getSources(window) failed:", normalizeErrorMessage(err));
    sources = [];
  }

  const wfWindow = pickWindowSource(sources);
  const skipWindowCapture =
    options && options.preferScreenCapture === true
      ? true
      : isLikelyWrongWindowName(sourceName(wfWindow || null));
  if (!skipWindowCapture && wfWindow && wfWindow.thumbnail && !wfWindow.thumbnail.isEmpty()) {
    return {
      image: wfWindow.thumbnail,
      sourceType: "window",
      sourceName: sourceName(wfWindow),
      sourceId: String(wfWindow.id || ""),
      sourceDisplayId: String(wfWindow.display_id || ""),
    };
  }

  try {
    const screens = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
    });

    const pickedScreen = pickScreenSource(screens, options);
    if (pickedScreen && pickedScreen.thumbnail && !pickedScreen.thumbnail.isEmpty()) {
      return {
        image: pickedScreen.thumbnail,
        sourceType: "screen",
        sourceName: sourceName(pickedScreen),
        sourceId: String(pickedScreen.id || ""),
        sourceDisplayId: String(pickedScreen.display_id || ""),
      };
    }
  } catch (err) {
    log.warn("[RewardScanner] getSources(screen) failed:", normalizeErrorMessage(err));
  }

  return null;
}

async function captureDebugFrame(options = {}) {
  const screenshot = await captureScreen(options);
  if (!screenshot) return null;
  const size = screenshot.image.getSize();

  const sourceLabel =
    screenshot.sourceType === "window"
      ? `window: ${screenshot.sourceName || screenshot.sourceId || "unknown"}`
      : `screen: ${screenshot.sourceName || screenshot.sourceDisplayId || screenshot.sourceId || "unknown"}`;

  log.log(`[RewardScanner] Debug capture source -> ${sourceLabel}`);

  return {
    imageDataUrl: screenshot.image.toDataURL(),
    width: size.width,
    height: size.height,
    sourceLabel,
  };
}

async function captureSourceMeta(options = {}) {
  const screenshot = await captureScreen(options);
  if (!screenshot) return null;

  return {
    sourceType: screenshot.sourceType || null,
    sourceName: screenshot.sourceName || null,
    sourceId: screenshot.sourceId || null,
    sourceDisplayId: screenshot.sourceDisplayId || null,
  };
}

module.exports = {
  sourceName,
  isCompanionWindowSource,
  isWarframeWindowSource,
  pickWindowSource,
  pickScreenSource,
  getCaptureThumbnailSize,
  captureScreen,
  captureDebugFrame,
  captureSourceMeta,
  CAPTURE_THUMBNAIL_LIMITS,
};
