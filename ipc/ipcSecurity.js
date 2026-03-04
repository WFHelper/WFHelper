"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const log = require("../services/logger").withScope("ipcSecurity");
const ctx = require("./context");

const MAIN_RENDERER_SUFFIX = path.normalize(path.join("renderer", "dist", "index.html"));
const OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "overlay.html"));
const CROP_DEBUG_RENDERER_SUFFIX = path.normalize(path.join("renderer", "crop-debug.html"));

function normalizePathForCompare(filePath) {
  return path
    .normalize(String(filePath || ""))
    .replace(/\\+/g, "/")
    .toLowerCase();
}

function getSenderUrl(event) {
  if (event?.senderFrame?.url) return String(event.senderFrame.url);
  if (typeof event?.sender?.getURL === "function") return String(event.sender.getURL() || "");
  return "";
}

function senderHasAllowedFileSuffix(event, requiredSuffix) {
  const senderUrl = getSenderUrl(event);
  if (!senderUrl) return false;

  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol !== "file:") return false;
    const senderPath = normalizePathForCompare(fileURLToPath(parsed));
    return senderPath.endsWith(normalizePathForCompare(requiredSuffix));
  } catch {
    return false;
  }
}

function assertWindowSender(event, browserWindow, channel, requiredSuffix) {
  if (!event || !event.sender) {
    throw new Error("Missing IPC sender event metadata");
  }
  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error("Target BrowserWindow is unavailable");
  }

  if (event.sender.id !== browserWindow.webContents.id) {
    throw new Error(`Unexpected sender webContents id ${event.sender.id}`);
  }

  if (!senderHasAllowedFileSuffix(event, requiredSuffix)) {
    throw new Error(`Unexpected sender URL: ${getSenderUrl(event) || "<empty>"}`);
  }
}

function assertMainRendererSender(event, channel) {
  assertWindowSender(event, ctx.mainWindow, channel, MAIN_RENDERER_SUFFIX);
}

function assertOverlayRendererSender(event, channel) {
  assertWindowSender(event, ctx.overlayWindow, channel, OVERLAY_RENDERER_SUFFIX);
}

function assertCropDebugRendererSender(event, channel) {
  assertWindowSender(event, ctx.cropDebugWindow, channel, CROP_DEBUG_RENDERER_SUFFIX);
}

function assertAuthorizedSender(assertFn, event, channel) {
  try {
    assertFn(event, channel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[Security] Blocked IPC "${channel}": ${message}`);
    throw new Error("Unauthorized IPC sender");
  }
}

function isAuthorizedSender(assertFn, event, channel) {
  try {
    assertFn(event, channel);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[Security] Blocked IPC "${channel}": ${message}`);
    return false;
  }
}

module.exports = {
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertCropDebugRendererSender,
  assertAuthorizedSender,
  isAuthorizedSender,
  __test__: {
    MAIN_RENDERER_SUFFIX,
    OVERLAY_RENDERER_SUFFIX,
    CROP_DEBUG_RENDERER_SUFFIX,
    getSenderUrl,
    senderHasAllowedFileSuffix,
    normalizePathForCompare,
  },
};
