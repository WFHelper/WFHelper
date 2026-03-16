import path from "node:path";
import { fileURLToPath } from "node:url";

import ctx from "./context";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope } from "../services/logger";

const runtimeRequire = createRuntimeRequire(__dirname, 1);
const log = withScope("ipcSecurity");

const { normalizeErrorMessage } = runtimeRequire<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const MAIN_RENDERER_SUFFIX = path.normalize(path.join("renderer", "dist", "index.html"));
const OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "overlay.html"));
const RIVEN_OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "riven-overlay.html"));
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
  const rewardWindow = ctx.overlayWindow
    ? {
        isDestroyed: () => ctx.overlayWindow?.isDestroyed() ?? true,
        webContents: { id: ctx.overlayWindow.webContents.id },
      }
    : null;

  const plannerWindow = (
    ctx as typeof ctx & { plannerOverlayWindow?: import("electron").BrowserWindow | null }
  ).plannerOverlayWindow
    ? {
        isDestroyed: () =>
          (
            ctx as typeof ctx & { plannerOverlayWindow?: import("electron").BrowserWindow | null }
          ).plannerOverlayWindow?.isDestroyed() ?? true,
        webContents: {
          id: (
            (ctx as typeof ctx & { plannerOverlayWindow?: import("electron").BrowserWindow | null })
              .plannerOverlayWindow as import("electron").BrowserWindow
          ).webContents.id,
        },
      }
    : null;

  const rivenLeftWindow = ctx.rivenOverlayLeftWindow
    ? {
        isDestroyed: () => ctx.rivenOverlayLeftWindow?.isDestroyed() ?? true,
        webContents: { id: ctx.rivenOverlayLeftWindow.webContents.id },
      }
    : null;

  const rivenRightWindow = ctx.rivenOverlayRightWindow
    ? {
        isDestroyed: () => ctx.rivenOverlayRightWindow?.isDestroyed() ?? true,
        webContents: { id: ctx.rivenOverlayRightWindow.webContents.id },
      }
    : null;

  try {
    assertWindowSender(event, rewardWindow, OVERLAY_RENDERER_SUFFIX);
    return;
  } catch {
    // fallback to planner window check
  }

  try {
    assertWindowSender(event, plannerWindow, OVERLAY_RENDERER_SUFFIX);
    return;
  } catch {
    // fallback to riven window check
  }

  try {
    assertWindowSender(event, rivenLeftWindow, RIVEN_OVERLAY_RENDERER_SUFFIX);
    return;
  } catch {
    // try right riven window
  }

  assertWindowSender(event, rivenRightWindow, RIVEN_OVERLAY_RENDERER_SUFFIX);
}

function assertRivenOverlayRendererSender(event: IpcEventLike, _channel: string): void {
  const leftWin = ctx.rivenOverlayLeftWindow
    ? {
        isDestroyed: () => ctx.rivenOverlayLeftWindow?.isDestroyed() ?? true,
        webContents: { id: ctx.rivenOverlayLeftWindow.webContents.id },
      }
    : null;

  const rightWin = ctx.rivenOverlayRightWindow
    ? {
        isDestroyed: () => ctx.rivenOverlayRightWindow?.isDestroyed() ?? true,
        webContents: { id: ctx.rivenOverlayRightWindow.webContents.id },
      }
    : null;

  // Accept either riven window as a valid sender
  try {
    assertWindowSender(event, leftWin, RIVEN_OVERLAY_RENDERER_SUFFIX);
    return;
  } catch {
    // try right window
  }
  assertWindowSender(event, rightWin, RIVEN_OVERLAY_RENDERER_SUFFIX);
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
    log.warn(`[Security] Blocked IPC "${channel}": ${normalizeErrorMessage(err)}`);
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
    log.warn(`[Security] Blocked IPC "${channel}": ${normalizeErrorMessage(err)}`);
    return false;
  }
}

export {
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertRivenOverlayRendererSender,
  assertCropDebugRendererSender,
  assertAuthorizedSender,
  isAuthorizedSender,
};

export const __test__ = {
  MAIN_RENDERER_SUFFIX,
  OVERLAY_RENDERER_SUFFIX,
  RIVEN_OVERLAY_RENDERER_SUFFIX,
  CROP_DEBUG_RENDERER_SUFFIX,
  getSenderUrl,
  senderHasAllowedFileSuffix,
  normalizePathForCompare,
};
