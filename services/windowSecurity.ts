import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";

import { normalizePathForCompare } from "../config/shared/pathCompare";

interface SecurityLogger {
  warn: (...args: unknown[]) => void;
}

interface HardenOptions {
  label?: string;
  allowedFilePaths?: string[];
  log?: SecurityLogger;
}

function normalizeAllowedFiles(files: unknown): Set<string> {
  return new Set((Array.isArray(files) ? files : []).map(normalizePathForCompare));
}

function isAllowedFileNavigation(url: string | unknown, allowedFiles: Set<string>): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url as string);
    if (parsed.protocol !== "file:") return false;

    const filePath = normalizePathForCompare(fileURLToPath(parsed));
    return allowedFiles.has(filePath);
  } catch {
    return false;
  }
}

export function hardenBrowserWindowNavigation(
  browserWindow: BrowserWindow,
  options: HardenOptions = {},
): void {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  const label = String(options.label || "window");
  const allowedFiles = normalizeAllowedFiles(options.allowedFilePaths || []);
  const logger = options.log;

  browserWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    logger?.warn(`[Security] Blocked ${label} window.open to: ${url}`);
    return { action: "deny" as const };
  });

  const blockUnexpectedNavigation = (event: { preventDefault: () => void }, url: unknown): void => {
    if (!isAllowedFileNavigation(url, allowedFiles)) {
      event.preventDefault();
      logger?.warn(`[Security] Blocked ${label} navigation to: ${url}`);
    }
  };

  /* eslint-disable @typescript-eslint/no-explicit-any -- Electron event listener overloads */
  browserWindow.webContents.on("will-navigate", blockUnexpectedNavigation as any);

  browserWindow.webContents.on("will-frame-navigate", ((
    event: Electron.Event,
    details: Record<string, unknown>,
  ) => {
    const targetUrl =
      details && typeof details === "object" && typeof details.url === "string" ? details.url : "";
    blockUnexpectedNavigation(event, targetUrl);
  }) as any);

  browserWindow.webContents.on("will-attach-webview", ((event: Electron.Event) => {
    event.preventDefault();
    logger?.warn(`[Security] Blocked ${label} webview attach attempt`);
  }) as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export const __test__ = {
  normalizeAllowedFiles,
  isAllowedFileNavigation,
};
