import path from "node:path";

import { BrowserWindow, app, screen } from "electron";

import {
  assertMainRendererSender,
  handleAuthorized,
  registerPopoutWebContents,
  unregisterPopoutWebContents,
} from "./ipcSecurity";
import { POPOUT_OPEN, POPOUT_SET_PINNED } from "../config/shared/ipcChannels";
import { isPopoutView, type PopoutView } from "../config/shared/popoutTypes";
import { createJsonCache } from "../services/jsonCache";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";

const log = withScope("popoutIpc");

interface PopoutWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  pinned: boolean;
}

type PopoutStateFile = Partial<Record<PopoutView, PopoutWindowState>>;

const MIN_SIZE = { width: 720, height: 520 };
const DEFAULT_SIZE: Record<PopoutView, { width: number; height: number }> = {
  world: { width: 1120, height: 840 },
  arbitrations: { width: 1180, height: 840 },
};
const BOUNDS_SAVE_DEBOUNCE_MS = 1000;
const SHOW_DEADLINE_MS = 10_000;

function readSize(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

function reviveState(parsed: unknown): PopoutStateFile | null {
  if (!parsed || typeof parsed !== "object") return null;
  const state: PopoutStateFile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isPopoutView(key) || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const next: PopoutWindowState = {
      width: readSize(entry.width, DEFAULT_SIZE[key].width, MIN_SIZE.width),
      height: readSize(entry.height, DEFAULT_SIZE[key].height, MIN_SIZE.height),
      pinned: entry.pinned === true,
    };
    if (typeof entry.x === "number" && Number.isFinite(entry.x)) next.x = Math.round(entry.x);
    if (typeof entry.y === "number" && Number.isFinite(entry.y)) next.y = Math.round(entry.y);
    state[key] = next;
  }
  return state;
}

const stateCache = createJsonCache<PopoutStateFile>("popout-windows.json", reviveState);
let cachedState: PopoutStateFile | null = null;

function readState(): PopoutStateFile {
  if (!cachedState) cachedState = stateCache.read() ?? {};
  return cachedState;
}

function patchState(view: PopoutView, patch: Partial<PopoutWindowState>): void {
  const state = readState();
  const previous = state[view];
  const next: PopoutWindowState = {
    width: patch.width ?? previous?.width ?? DEFAULT_SIZE[view].width,
    height: patch.height ?? previous?.height ?? DEFAULT_SIZE[view].height,
    pinned: patch.pinned ?? previous?.pinned ?? false,
  };
  const x = patch.x ?? previous?.x;
  const y = patch.y ?? previous?.y;
  if (typeof x === "number") next.x = Math.round(x);
  if (typeof y === "number") next.y = Math.round(y);
  state[view] = next;
  stateCache.write(state);
}

// A saved position can name a monitor that is gone or now smaller, so the
// window is pulled back inside the work area of the display it matches.
function restoreBounds(
  view: PopoutView,
  saved: PopoutWindowState | undefined,
): { x?: number; y?: number; width: number; height: number } {
  const width = saved?.width ?? DEFAULT_SIZE[view].width;
  const height = saved?.height ?? DEFAULT_SIZE[view].height;
  if (typeof saved?.x !== "number" || typeof saved?.y !== "number") return { width, height };

  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width, height }).workArea;
  const clampedWidth = Math.max(MIN_SIZE.width, Math.min(width, area.width));
  const clampedHeight = Math.max(MIN_SIZE.height, Math.min(height, area.height));
  return {
    x: Math.round(
      Math.min(Math.max(saved.x, area.x), Math.max(area.x, area.x + area.width - clampedWidth)),
    ),
    y: Math.round(
      Math.min(Math.max(saved.y, area.y), Math.max(area.y, area.y + area.height - clampedHeight)),
    ),
    width: clampedWidth,
    height: clampedHeight,
  };
}

const popoutWindows = new Map<PopoutView, BrowserWindow>();

function rendererEntryFile(): string {
  return path.join(app.getAppPath(), "renderer", "dist", "index.html");
}

function viewForWindow(target: BrowserWindow | null): PopoutView | null {
  if (!target) return null;
  for (const [view, win] of popoutWindows) {
    if (win === target) return view;
  }
  return null;
}

function saveBounds(view: PopoutView, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const { x, y, width, height } = win.getNormalBounds();
  patchState(view, { x, y, width, height });
}

function openPopout(view: PopoutView): void {
  const existing = popoutWindows.get(view);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }

  const saved = readState()[view];
  const pinned = saved?.pinned === true;
  const entryFile = rendererEntryFile();
  const win = new BrowserWindow({
    ...restoreBounds(view, saved),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: "#060a12",
    icon: path.join(app.getAppPath(), "assets", "logo.ico"),
    alwaysOnTop: pinned,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), ".electron-build", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const webContentsId = win.webContents.id;
  popoutWindows.set(view, win);
  registerPopoutWebContents(webContentsId);

  hardenBrowserWindowNavigation(win, {
    label: `popout:${view}`,
    allowedFilePaths: [entryFile],
    log,
  });

  // ready-to-show can silently never fire on Linux, leaving the window hidden
  // forever, so the load event and a hard deadline show it too.
  let shown = false;
  const show = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  const showTimer = setTimeout(show, SHOW_DEADLINE_MS);
  win.once("ready-to-show", show);
  win.webContents.once("did-finish-load", show);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const queueBoundsSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveBounds(view, win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  };
  win.on("move", queueBoundsSave);
  win.on("resize", queueBoundsSave);
  win.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveBounds(view, win);
  });
  win.on("closed", () => {
    clearTimeout(showTimer);
    unregisterPopoutWebContents(webContentsId);
    if (popoutWindows.get(view) === win) popoutWindows.delete(view);
  });

  // The renderer reads both from its own URL: one bundle, one slim shell.
  const search = pinned ? `popout=${view}&pinned=1` : `popout=${view}`;
  void win.loadFile(entryFile, { search }).catch((err: unknown) => {
    log.error(`Failed to load the ${view} popout renderer:`, err);
    show();
  });
}

type PopoutSenderEvent = { sender?: { id?: number } };

/** Only a window this module created may pin itself; never the main window. */
function assertPopoutSender(event: PopoutSenderEvent, _channel: string): void {
  const senderId = event?.sender?.id;
  if (typeof senderId !== "number") throw new Error("Missing IPC sender event metadata");
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed() && win.webContents.id === senderId) return;
  }
  throw new Error(`Sender webContents id ${senderId} is not a popout window`);
}

export function register(): void {
  handleAuthorized(POPOUT_OPEN, assertMainRendererSender, (_event, view: unknown) => {
    if (!isPopoutView(view)) {
      log.warn(`Ignored popout open for unknown view: ${String(view)}`);
      return { ok: false };
    }
    openPopout(view);
    return { ok: true };
  });

  handleAuthorized(POPOUT_SET_PINNED, assertPopoutSender, (event, pinned: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const view = viewForWindow(win);
    if (!win || !view) return { ok: false };
    const next = pinned === true;
    win.setAlwaysOnTop(next);
    patchState(view, { pinned: next });
    return { ok: true };
  });
}

/** Fans a main-window push out to every open popout renderer. */
export function sendToPopouts(channel: string, ...args: unknown[]): void {
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

export const __test__ = {
  reviveState,
  restoreBounds,
  patchState,
  readState,
  resetForTest(): void {
    cachedState = null;
    popoutWindows.clear();
  },
};
