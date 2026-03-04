"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

function normalizePathForCompare(filePath) {
  return path
    .normalize(String(filePath || ""))
    .replace(/\\+/g, "/")
    .toLowerCase();
}

function normalizeAllowedFiles(files) {
  return new Set((Array.isArray(files) ? files : []).map(normalizePathForCompare));
}

function isAllowedFileNavigation(url, allowedFiles) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;

    const filePath = normalizePathForCompare(fileURLToPath(parsed));
    return allowedFiles.has(filePath);
  } catch {
    return false;
  }
}

function hardenBrowserWindowNavigation(browserWindow, options = {}) {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const label = String(options.label || "window");
  const allowedFiles = normalizeAllowedFiles(options.allowedFilePaths || []);
  const logger = options.log;

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[Security] Blocked ${label} window.open to: ${url}`);
    }
    return { action: "deny" };
  });

  const blockUnexpectedNavigation = (event, url) => {
    if (!isAllowedFileNavigation(url, allowedFiles)) {
      event.preventDefault();
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[Security] Blocked ${label} navigation to: ${url}`);
      }
    }
  };

  browserWindow.webContents.on("will-navigate", blockUnexpectedNavigation);

  browserWindow.webContents.on("will-frame-navigate", (event, details) => {
    const targetUrl =
      details && typeof details === "object" && typeof details.url === "string" ? details.url : "";
    blockUnexpectedNavigation(event, targetUrl);
  });

  browserWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[Security] Blocked ${label} webview attach attempt`);
    }
  });
}

module.exports = {
  hardenBrowserWindowNavigation,
  __test__: {
    normalizePathForCompare,
    normalizeAllowedFiles,
    isAllowedFileNavigation,
  },
};
