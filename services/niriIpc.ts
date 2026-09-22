// niri implements no wlr-foreign-toplevel-management, so its own ipc socket is
// the only way to see the game window there. The socket itself belongs to
// waylandCompositor; this module only reads focus and geometry off it.

import { withScope } from "./logger";
import { niriOk, niriRequest, pickWarframeWindow } from "./waylandCompositor";

const log = withScope("niriIpc");

// The focus poll runs once a second, so a snapshot this old is still the
// freshest answer any caller could have had.
const SNAPSHOT_TTL_MS = 1_000;
// Past this, a snapshot no refresh can renew stops being an answer at all.
const SNAPSHOT_STALE_MS = 5_000;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What niri last answered about focus. A null `window` means niri said nothing
 *  is focused, which is not the same as niri never answering. `at` is the time
 *  of that answer, so an unrenewable snapshot can be retired. */
interface NiriWindowSnapshot {
  window: { title: string; appId: string } | null;
  at: number;
}

export interface NiriTransport {
  request(variant: string): Promise<unknown>;
}

const realTransport: NiriTransport = {
  request(variant: string): Promise<unknown> {
    const socketPath = process.env.NIRI_SOCKET;
    if (!socketPath) return Promise.reject(new Error("NIRI_SOCKET is not set"));
    return niriRequest(socketPath, variant);
  },
};
let transport: NiriTransport = realTransport;

/** Swaps the socket out. Null restores it and drops the cached snapshot. */
export function setNiriTransportForTest(next: NiriTransport | null): void {
  transport = next ?? realTransport;
  snapshot = null;
}

export function isNiriAvailable(): boolean {
  return process.platform === "linux" && !!process.env.NIRI_SOCKET;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const first = asNumber(value[0]);
  const second = asNumber(value[1]);
  return first === null || second === null ? null : [first, second];
}

let warnedRequest = false;

async function niriQuery(variant: string): Promise<unknown> {
  if (!isNiriAvailable()) return undefined;
  try {
    return niriOk(await transport.request(variant), variant);
  } catch (err) {
    if (!warnedRequest) {
      warnedRequest = true;
      log.warn(`[Niri] ${variant} request failed:`, (err as Error)?.message);
    }
    return undefined;
  }
}

interface NiriWindow {
  title: string;
  appId: string;
  /** niri's is_focused, under the name the ranking helper reads. */
  activated: boolean;
  workspaceId: number | null;
  tilePos: [number, number] | null;
  windowOffset: [number, number] | null;
  windowSize: [number, number] | null;
}

// Every field is optional on purpose: older niri builds report no `layout` at
// all, and a window with no tile position is simply not placeable.
function parseWindow(value: unknown): NiriWindow | null {
  if (!isRecord(value)) return null;
  const layout = isRecord(value.layout) ? value.layout : null;
  return {
    title: asString(value.title),
    appId: asString(value.app_id),
    activated: value.is_focused === true,
    workspaceId: asNumber(value.workspace_id),
    tilePos: layout ? asPair(layout.tile_pos_in_workspace_view) : null,
    windowOffset: layout ? asPair(layout.window_offset_in_tile) : null,
    windowSize: layout ? asPair(layout.window_size) : null,
  };
}

function workspaceOutput(value: unknown, workspaceId: number): string | null {
  if (!isRecord(value)) return null;
  if (asNumber(value.id) !== workspaceId) return null;
  const output = asString(value.output);
  return output ? output : null;
}

/** Outputs arrive keyed by connector name, each with an optional logical rect. */
function outputRect(outputs: unknown, name: string): WindowBounds | null {
  if (!isRecord(outputs)) return null;
  const entry = outputs[name];
  const logical = isRecord(entry) && isRecord(entry.logical) ? entry.logical : null;
  if (!logical) return null;
  const x = asNumber(logical.x);
  const y = asNumber(logical.y);
  const width = asNumber(logical.width);
  const height = asNumber(logical.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

let snapshot: NiriWindowSnapshot | null = null;
let refreshing = false;

async function refreshFocusedWindow(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const reply = await niriQuery("FocusedWindow");
    // Undefined is a failed request: the last answer stands for a while, then
    // stops being one, or a dead socket would pin focus forever.
    if (reply === undefined) {
      if (snapshot && Date.now() - snapshot.at >= SNAPSHOT_STALE_MS) snapshot = null;
      return;
    }
    const focused = parseWindow(reply);
    snapshot = {
      window: focused ? { title: focused.title, appId: focused.appId } : null,
      at: Date.now(),
    };
  } catch {
    // niriQuery already swallowed and logged the real failure
  } finally {
    refreshing = false;
  }
}

/** Never blocks: a stale snapshot is served while a fresh one is fetched, and
 *  null means niri has not answered once yet. */
export function niriFocusedWindowSync(): NiriWindowSnapshot | null {
  if (!isNiriAvailable()) return null;
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  void refreshFocusedWindow();
  return snapshot;
}

/** Screen coordinates of the game window, or null when any of the three answers
 *  is missing a piece. niri reports a window's position relative to its
 *  workspace view, so the output's logical origin has to be added. */
export async function niriWindowBounds(): Promise<WindowBounds | null> {
  if (!isNiriAvailable()) return null;
  const [windows, workspaces, outputs] = await Promise.all([
    niriQuery("Windows"),
    niriQuery("Workspaces"),
    niriQuery("Outputs"),
  ]);
  if (!Array.isArray(windows) || !Array.isArray(workspaces)) return null;

  const parsed: NiriWindow[] = [];
  for (const entry of windows) {
    const window = parseWindow(entry);
    if (window) parsed.push(window);
  }
  const game = pickWarframeWindow(parsed);
  if (!game || game.workspaceId === null) return null;
  if (!game.tilePos || !game.windowOffset || !game.windowSize) return null;

  let outputName: string | null = null;
  for (const entry of workspaces) {
    outputName = workspaceOutput(entry, game.workspaceId);
    if (outputName) break;
  }
  if (!outputName) return null;

  const rect = outputRect(outputs, outputName);
  if (!rect) return null;
  return {
    x: Math.round(rect.x + game.tilePos[0] + game.windowOffset[0]),
    y: Math.round(rect.y + game.tilePos[1] + game.windowOffset[1]),
    width: Math.round(game.windowSize[0]),
    height: Math.round(game.windowSize[1]),
  };
}
