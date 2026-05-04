import path from "node:path";
import { fileURLToPath } from "node:url";

import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import ctx from "./context";
import { withScope } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("ipcSecurity");

const MAIN_RENDERER_SUFFIX = path.normalize(path.join("renderer", "dist", "index.html"));
const OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "overlay.html"));
const RIVEN_OVERLAY_RENDERER_SUFFIX = path.normalize(path.join("renderer", "riven-overlay.html"));
const TRADE_NOTIFICATION_RENDERER_SUFFIX = path.normalize(
  path.join("renderer", "trade-notification.html"),
);

type IpcEventLike = {
  sender?: {
    id?: number;
    getURL?: () => string;
  };
  senderFrame?: {
    url?: string;
  };
};

type BrowserWindowCandidate = {
  win: import("electron").BrowserWindow | null;
  suffix: string;
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

function assertCandidateWindowSender(event: IpcEventLike, candidate: BrowserWindowCandidate): void {
  const win = candidate.win;
  assertWindowSender(
    event,
    win
      ? {
          isDestroyed: () => win?.isDestroyed() ?? true,
          webContents: { id: win.webContents.id },
        }
      : null,
    candidate.suffix,
  );
}

function assertAnyCandidateWindowSender(
  event: IpcEventLike,
  candidates: BrowserWindowCandidate[],
  options: { fallbackMessage?: string; throwLastError?: boolean } = {},
): void {
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      assertCandidateWindowSender(event, candidate);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  if (options.throwLastError && lastError instanceof Error) throw lastError;
  throw new Error(options.fallbackMessage || "No matching BrowserWindow for sender");
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
  const candidates: BrowserWindowCandidate[] = [
    { win: ctx.overlayWindow, suffix: OVERLAY_RENDERER_SUFFIX },
    { win: ctx.plannerOverlayWindow, suffix: OVERLAY_RENDERER_SUFFIX },
    { win: ctx.rivenOverlayLeftWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
    { win: ctx.rivenOverlayRightWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
  ];
  assertAnyCandidateWindowSender(event, candidates, {
    fallbackMessage: "No matching overlay window for sender",
  });
}

function assertTradeNotificationSender(event: IpcEventLike, _channel: string): void {
  assertWindowSender(
    event,
    ctx.tradeNotificationWindow
      ? {
          isDestroyed: () => ctx.tradeNotificationWindow?.isDestroyed() ?? true,
          webContents: { id: ctx.tradeNotificationWindow.webContents.id },
        }
      : null,
    TRADE_NOTIFICATION_RENDERER_SUFFIX,
  );
}

function assertRivenOverlayRendererSender(event: IpcEventLike, _channel: string): void {
  assertAnyCandidateWindowSender(
    event,
    [
      { win: ctx.rivenOverlayLeftWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
      { win: ctx.rivenOverlayRightWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
    ],
    { throwLastError: true },
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

/**
 * Register an `ipcMain.handle` handler that first asserts the sender is
 * authorized. Rejects with "Unauthorized IPC sender" when the guard fails,
 * so the renderer's invoke() promise rejects. Keeps the channel name
 * single-sourced so a copy-pasted handler can't drift.
 */
function handleAuthorized<Args extends unknown[], R>(
  channel: string,
  assertFn: AssertSenderFn,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertAuthorizedSender(assertFn, event as never, channel);
    return handler(event, ...(args as Args));
  });
}

/**
 * Register an `ipcMain.on` handler that silently drops messages from
 * unauthorized senders (logged at warn level). Fire-and-forget counterpart
 * to `handleAuthorized`.
 */
function onAuthorized<Args extends unknown[]>(
  channel: string,
  assertFn: AssertSenderFn,
  handler: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isAuthorizedSender(assertFn, event as never, channel)) return;
    handler(event, ...(args as Args));
  });
}

export {
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertRivenOverlayRendererSender,
  assertTradeNotificationSender,
  assertAuthorizedSender,
  isAuthorizedSender,
  handleAuthorized,
  onAuthorized,
};

const __test__ = {
  MAIN_RENDERER_SUFFIX,
  OVERLAY_RENDERER_SUFFIX,
  RIVEN_OVERLAY_RENDERER_SUFFIX,
  TRADE_NOTIFICATION_RENDERER_SUFFIX,
  getSenderUrl,
  senderHasAllowedFileSuffix,
  normalizePathForCompare,
};
