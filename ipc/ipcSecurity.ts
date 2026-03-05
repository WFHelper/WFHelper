import path from "node:path";
import { fileURLToPath } from "node:url";

import ctx from "./context";
import { createRuntimeRequire } from "./runtimeRequire";

const runtimeRequire = createRuntimeRequire(__dirname, 1);
const log = runtimeRequire<{
  withScope: (scope: string) => { warn: (...args: unknown[]) => void };
}>("services/logger").withScope("ipcSecurity");

const MAIN_RENDERER_SUFFIX = path.normalize(path.join("renderer", "dist", "index.html"));
const OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "overlay.html"));
const CROP_DEBUG_RENDERER_SUFFIX = path.normalize(path.join("renderer", "crop-debug.html"));

type IpcEventLike = {
  sender?: {
    id?: number;
    getURL?: () => string;
  };
  senderFrame?: {
    url?: string;
  };
};

function normalizePathForCompare(filePath: unknown): string {
  return path
    .normalize(String(filePath || ""))
    .replace(/\\+/g, "/")
    .toLowerCase();
}

function getSenderUrl(event: IpcEventLike): string {
  if (event?.senderFrame?.url) return String(event.senderFrame.url);
  if (typeof event?.sender?.getURL === "function") return String(event.sender.getURL() || "");
  return "";
}

function senderHasAllowedFileSuffix(event: IpcEventLike, requiredSuffix: string): boolean {
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

function assertWindowSender(
  event: IpcEventLike,
  browserWindow: {
    isDestroyed: () => boolean;
    webContents: { id: number };
  } | null,
  requiredSuffix: string,
): void {
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

function assertMainRendererSender(event: IpcEventLike, _channel: string): void {
  assertWindowSender(
    event,
    ctx.mainWindow
      ? {
          isDestroyed: () => ctx.mainWindow?.isDestroyed() ?? true,
          webContents: { id: ctx.mainWindow.webContents.id },
        }
      : null,
    MAIN_RENDERER_SUFFIX,
  );
}

function assertOverlayRendererSender(event: IpcEventLike, _channel: string): void {
  assertWindowSender(
    event,
    ctx.overlayWindow
      ? {
          isDestroyed: () => ctx.overlayWindow?.isDestroyed() ?? true,
          webContents: { id: ctx.overlayWindow.webContents.id },
        }
      : null,
    OVERLAY_RENDERER_SUFFIX,
  );
}

function assertCropDebugRendererSender(event: IpcEventLike, _channel: string): void {
  assertWindowSender(
    event,
    ctx.cropDebugWindow
      ? {
          isDestroyed: () => ctx.cropDebugWindow?.isDestroyed() ?? true,
          webContents: { id: ctx.cropDebugWindow.webContents.id },
        }
      : null,
    CROP_DEBUG_RENDERER_SUFFIX,
  );
}

type AssertSenderFn = (event: IpcEventLike, channel: string) => void;

function assertAuthorizedSender(
  assertFn: AssertSenderFn,
  event: IpcEventLike,
  channel: string,
): void {
  try {
    assertFn(event, channel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[Security] Blocked IPC "${channel}": ${message}`);
    const wrapped = new Error("Unauthorized IPC sender");
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

function isAuthorizedSender(
  assertFn: AssertSenderFn,
  event: IpcEventLike,
  channel: string,
): boolean {
  try {
    assertFn(event, channel);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[Security] Blocked IPC "${channel}": ${message}`);
    return false;
  }
}

export {
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertCropDebugRendererSender,
  assertAuthorizedSender,
  isAuthorizedSender,
};

export const __test__ = {
  MAIN_RENDERER_SUFFIX,
  OVERLAY_RENDERER_SUFFIX,
  CROP_DEBUG_RENDERER_SUFFIX,
  getSenderUrl,
  senderHasAllowedFileSuffix,
  normalizePathForCompare,
};
