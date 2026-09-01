import { fileURLToPath } from "node:url";

import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import ctx from "./context";
import { withScope } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizePathForCompare } from "../config/shared/pathCompare";

const log = withScope("ipcSecurity");

const MAIN_RENDERER_SUFFIX = normalizePathForCompare("renderer/dist/index.html");
const OVERLAY_RENDERER_SUFFIX = normalizePathForCompare("renderer/overlay.html");
const RIVEN_OVERLAY_RENDERER_SUFFIX = normalizePathForCompare("renderer/riven-overlay.html");
const TRADE_NOTIFICATION_RENDERER_SUFFIX = normalizePathForCompare(
  "renderer/trade-notification.html",
);
const ARBI_SUMMARY_RENDERER_SUFFIX = normalizePathForCompare("renderer/arbi-overlay.html");

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

// Popout windows load the same renderer bundle through the same preload, so
// they share the main window's trust level. Only ids of windows popoutIpc
// created itself get in, and the file-suffix check still has to pass.
const popoutWebContentsIds = new Set<number>();

function registerPopoutWebContents(webContentsId: number): void {
  popoutWebContentsIds.add(webContentsId);
}

function unregisterPopoutWebContents(webContentsId: number): void {
  popoutWebContentsIds.delete(webContentsId);
}

function assertMainRendererSender(event: IpcEventLike, _channel: string): void {
  const senderId = event?.sender?.id;
  if (typeof senderId === "number" && popoutWebContentsIds.has(senderId)) {
    if (senderHasAllowedFileSuffix(event, MAIN_RENDERER_SUFFIX)) return;
    throw new Error(`Unexpected sender URL: ${getSenderUrl(event) || "<empty>"}`);
  }

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

function overlayWindowCandidates(): BrowserWindowCandidate[] {
  return [
    { win: ctx.overlayWindow, suffix: OVERLAY_RENDERER_SUFFIX },
    { win: ctx.plannerOverlayWindow, suffix: OVERLAY_RENDERER_SUFFIX },
    { win: ctx.rivenOverlayLeftWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
    { win: ctx.rivenOverlayRightWindow, suffix: RIVEN_OVERLAY_RENDERER_SUFFIX },
    { win: ctx.arbiSummaryWindow, suffix: ARBI_SUMMARY_RENDERER_SUFFIX },
  ];
}

function assertOverlayRendererSender(event: IpcEventLike, _channel: string): void {
  assertAnyCandidateWindowSender(event, overlayWindowCandidates(), {
    fallbackMessage: "No matching overlay window for sender",
  });
}

// The trade toast reads the same message catalogue, but it has no drag, close
// or scan surface, so it is only added to the guard for that one channel.
function assertLocalizedOverlaySender(event: IpcEventLike, _channel: string): void {
  const candidates = overlayWindowCandidates();
  candidates.push({ win: ctx.tradeNotificationWindow, suffix: TRADE_NOTIFICATION_RENDERER_SUFFIX });
  assertAnyCandidateWindowSender(event, candidates, {
    fallbackMessage: "No matching overlay window for sender",
  });
}

function assertArbiSummarySender(event: IpcEventLike, _channel: string): void {
  assertWindowSender(
    event,
    ctx.arbiSummaryWindow
      ? {
          isDestroyed: () => ctx.arbiSummaryWindow?.isDestroyed() ?? true,
          webContents: { id: ctx.arbiSummaryWindow.webContents.id },
        }
      : null,
    ARBI_SUMMARY_RENDERER_SUFFIX,
  );
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

// Reject unauthorized invokes so renderer promises fail instead of silently hanging.
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

/** Drops unauthorized fire-and-forget messages after logging a warning. */
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
  registerPopoutWebContents,
  unregisterPopoutWebContents,
  assertOverlayRendererSender,
  assertLocalizedOverlaySender,
  assertRivenOverlayRendererSender,
  assertTradeNotificationSender,
  assertArbiSummarySender,
  assertAuthorizedSender,
  isAuthorizedSender,
  handleAuthorized,
  onAuthorized,
};
