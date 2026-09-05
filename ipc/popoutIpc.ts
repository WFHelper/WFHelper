import path from "node:path";

import { BrowserWindow, app, screen } from "electron";

import ctx from "./context";
import {
  assertMainRendererSender,
  handleAuthorized,
  registerPopoutWebContents,
  unregisterPopoutWebContents,
} from "./ipcSecurity";
import {
  POPOUT_CLOSE,
  POPOUT_CLOSE_ALL,
  POPOUT_LIST,
  POPOUT_OPEN,
  POPOUT_SET_PINNED,
  POPOUT_STATE_CHANGED,
} from "../config/shared/ipcChannels";
import {
  parsePopoutBounds,
  parsePopoutTarget,
  parsePopoutTargetKey,
  popoutTargetKey,
  type PopoutOpenOptions,
  type PopoutTarget,
  type PopoutView,
  type PopoutWindowInfo,
} from "../config/shared/popoutTypes";
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

type PopoutStateFile = Record<string, PopoutWindowState>;

const VIEW_MIN_SIZE = { width: 720, height: 520 };
// A single section is usually a card, so it may shrink far below a whole view.
const SECTION_MIN_SIZE = { width: 360, height: 280 };
const VIEW_DEFAULT_SIZE: Record<PopoutView, { width: number; height: number }> = {
  world: { width: 1120, height: 840 },
  arbitrations: { width: 1180, height: 840 },
};
const SECTION_DEFAULT_SIZE = { width: 640, height: 560 };
const BOUNDS_SAVE_DEBOUNCE_MS = 1000;
const SHOW_DEADLINE_MS = 10_000;

function minSizeFor(target: PopoutTarget): { width: number; height: number } {
  return target.kind === "view" ? VIEW_MIN_SIZE : SECTION_MIN_SIZE;
}

function defaultSizeFor(target: PopoutTarget): { width: number; height: number } {
  return target.kind === "view" ? VIEW_DEFAULT_SIZE[target.view] : SECTION_DEFAULT_SIZE;
}

function readSize(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

function reviveState(parsed: unknown): PopoutStateFile | null {
  if (!parsed || typeof parsed !== "object") return null;
  const state: PopoutStateFile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const target = parsePopoutTargetKey(key);
    if (!target || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const min = minSizeFor(target);
    const size = defaultSizeFor(target);
    const next: PopoutWindowState = {
      width: readSize(entry.width, size.width, min.width),
      height: readSize(entry.height, size.height, min.height),
      pinned: entry.pinned === true,
    };
    if (typeof entry.x === "number" && Number.isFinite(entry.x)) next.x = Math.round(entry.x);
    if (typeof entry.y === "number" && Number.isFinite(entry.y)) next.y = Math.round(entry.y);
    state[popoutTargetKey(target)] = next;
  }
  return state;
}

const stateCache = createJsonCache<PopoutStateFile>("popout-windows.json", reviveState);
let cachedState: PopoutStateFile | null = null;

function readState(): PopoutStateFile {
  if (!cachedState) cachedState = stateCache.read() ?? {};
  return cachedState;
}

function patchState(target: PopoutTarget, patch: Partial<PopoutWindowState>): void {
  const state = readState();
  const key = popoutTargetKey(target);
  const previous = state[key];
  const size = defaultSizeFor(target);
  const next: PopoutWindowState = {
    width: patch.width ?? previous?.width ?? size.width,
    height: patch.height ?? previous?.height ?? size.height,
    pinned: patch.pinned ?? previous?.pinned ?? false,
  };
  const x = patch.x ?? previous?.x;
  const y = patch.y ?? previous?.y;
  if (typeof x === "number") next.x = Math.round(x);
  if (typeof y === "number") next.y = Math.round(y);
  state[key] = next;
  stateCache.write(state);
}

// A saved position can name a monitor that is gone or now smaller, so the
// window is pulled back inside the work area of the display it matches.
function restoreBounds(
  target: PopoutTarget,
  saved: PopoutWindowState | undefined,
): { x?: number; y?: number; width: number; height: number } {
  const size = defaultSizeFor(target);
  const min = minSizeFor(target);
  const width = saved?.width ?? size.width;
  const height = saved?.height ?? size.height;
  if (typeof saved?.x !== "number" || typeof saved?.y !== "number") return { width, height };

  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width, height }).workArea;
  const clampedWidth = Math.max(min.width, Math.min(width, area.width));
  const clampedHeight = Math.max(min.height, Math.min(height, area.height));
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

const popoutWindows = new Map<string, BrowserWindow>();

function rendererEntryFile(): string {
  return path.join(app.getAppPath(), "renderer", "dist", "index.html");
}

function targetKeyForWindow(target: BrowserWindow | null): string | null {
  if (!target) return null;
  for (const [key, win] of popoutWindows) {
    if (win === target) return key;
  }
  return null;
}

function saveBounds(target: PopoutTarget, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const { x, y, width, height } = win.getNormalBounds();
  patchState(target, { x, y, width, height });
}

/** Open popouts; `pinned` comes from the state file, not the window's own flag,
    because the file is the pin authority. */
function listOpenPopouts(): PopoutWindowInfo[] {
  const state = readState();
  const list: PopoutWindowInfo[] = [];
  for (const [key, win] of popoutWindows) {
    if (win.isDestroyed()) continue;
    const target = parsePopoutTargetKey(key);
    if (!target) continue;
    const { x, y, width, height } = win.getNormalBounds();
    list.push({
      target,
      pinned: state[key]?.pinned === true,
      bounds: { x, y, width, height },
    });
  }
  return list;
}

function notifyStateChanged(): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(POPOUT_STATE_CHANGED, listOpenPopouts());
}

function openPopout(target: PopoutTarget, options?: PopoutOpenOptions): void {
  const key = popoutTargetKey(target);
  const existing = popoutWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    // A workspace applies to windows that are already up, so requested geometry
    // moves them instead of being dropped; same clamping as a fresh open.
    if (options?.bounds) {
      patchState(target, options.bounds);
      existing.setBounds(restoreBounds(target, readState()[key]));
    }
    if (typeof options?.pinned === "boolean") {
      existing.setAlwaysOnTop(options.pinned);
      patchState(target, { pinned: options.pinned });
    }
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    notifyStateChanged();
    return;
  }

  // A workspace restores the geometry it captured, so the requested bounds
  // become the remembered ones before the window reads them back.
  if (options?.bounds) patchState(target, options.bounds);
  if (typeof options?.pinned === "boolean") patchState(target, { pinned: options.pinned });

  const saved = readState()[key];
  const pinned = saved?.pinned === true;
  const min = minSizeFor(target);
  const entryFile = rendererEntryFile();
  const win = new BrowserWindow({
    ...restoreBounds(target, saved),
    minWidth: min.width,
    minHeight: min.height,
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
  popoutWindows.set(key, win);
  registerPopoutWebContents(webContentsId);

  hardenBrowserWindowNavigation(win, {
    label: `popout:${key}`,
    allowedFilePaths: [entryFile],
    log,
  });

  // ready-to-show can silently never fire on Linux, leaving the window hidden
  // forever, so the load event and a hard deadline show it too.
  let shown = false;
  const show = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(showTimer);
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
      saveBounds(target, win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  };
  win.on("move", queueBoundsSave);
  win.on("resize", queueBoundsSave);
  win.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveBounds(target, win);
  });
  win.on("closed", () => {
    clearTimeout(showTimer);
    unregisterPopoutWebContents(webContentsId);
    if (popoutWindows.get(key) === win) popoutWindows.delete(key);
    notifyStateChanged();
  });

  // The renderer reads both from its own URL: one bundle, one slim shell.
  const search = pinned ? `popout=${key}&pinned=1` : `popout=${key}`;
  void win.loadFile(entryFile, { search }).catch((err: unknown) => {
    log.error(`Failed to load the ${key} popout renderer:`, err);
    show();
  });
  notifyStateChanged();
}

function closePopout(target: PopoutTarget): boolean {
  const win = popoutWindows.get(popoutTargetKey(target));
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
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
  handleAuthorized(POPOUT_OPEN, assertMainRendererSender, (_event, ...args: unknown[]) => {
    const target = parsePopoutTarget(args[0]);
    if (!target) {
      log.warn(`Ignored popout open for unknown target: ${JSON.stringify(args[0] ?? null)}`);
      return { ok: false };
    }
    const raw = (args[1] ?? null) as { pinned?: unknown; bounds?: unknown } | null;
    const options: PopoutOpenOptions = {};
    if (typeof raw?.pinned === "boolean") options.pinned = raw.pinned;
    const bounds = parsePopoutBounds(raw?.bounds);
    if (bounds) options.bounds = bounds;
    openPopout(target, options);
    return { ok: true };
  });

  handleAuthorized(POPOUT_LIST, assertMainRendererSender, () => listOpenPopouts());

  handleAuthorized(POPOUT_CLOSE, assertMainRendererSender, (_event, ...args: unknown[]) => {
    const target = parsePopoutTarget(args[0]);
    if (!target) return { ok: false };
    return { ok: closePopout(target) };
  });

  handleAuthorized(POPOUT_CLOSE_ALL, assertMainRendererSender, () => {
    let closed = 0;
    for (const win of [...popoutWindows.values()]) {
      if (win.isDestroyed()) continue;
      win.close();
      closed += 1;
    }
    return { ok: true, closed };
  });

  handleAuthorized(POPOUT_SET_PINNED, assertPopoutSender, (event, pinned: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const key = targetKeyForWindow(win);
    const target = key ? parsePopoutTargetKey(key) : null;
    if (!win || !target) return { ok: false };
    const next = pinned === true;
    win.setAlwaysOnTop(next);
    patchState(target, { pinned: next });
    notifyStateChanged();
    return { ok: true };
  });
}

function sendToPopouts(channel: string, ...args: unknown[]): void {
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

/** A renderer push has to reach the main window and every popout; the main
    window can be missing while the app runs in the tray. */
export function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  const win = ctx.mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  sendToPopouts(channel, ...args);
}

export const __test__ = {
  reviveState,
  restoreBounds,
  patchState,
  readState,
  listOpenPopouts,
  resetForTest(): void {
    cachedState = null;
    popoutWindows.clear();
  },
};
