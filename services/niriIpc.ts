// niri implements no wlr-foreign-toplevel-management, so its own ipc socket is
// the only way to see the game window there. The socket itself belongs to
// waylandCompositor; this module only reads focus and geometry off it.

import { withScope } from "./logger";
import type { WindowBounds } from "./warframeStatus";
import { niriGameWindow, niriOk, niriRequest, niriWorkspaceOutput } from "./waylandCompositor";
import { asRecord } from "../config/shared/objectValidation";

const log = withScope("niriIpc");

const SNAPSHOT_TTL_MS = 1_000;
const SNAPSHOT_STALE_MS = 5_000;

/** Whether the game window had niri's focus at `at`. A game niri does not list
 *  is not focused, which is not the same as niri never answering. */
interface NiriFocusSnapshot {
  gameFocused: boolean;
  at: number;
}

interface NiriTransport {
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

function isNiriAvailable(): boolean {
  return process.platform === "linux" && !!process.env.NIRI_SOCKET;
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

/** Outputs arrive keyed by connector name, each with an optional logical rect. */
function outputRect(outputs: unknown, name: string): WindowBounds | null {
  const logical = asRecord(asRecord(asRecord(outputs)?.[name])?.logical);
  if (!logical) return null;
  const x = asNumber(logical.x);
  const y = asNumber(logical.y);
  const width = asNumber(logical.width);
  const height = asNumber(logical.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

let snapshot: NiriFocusSnapshot | null = null;
let refreshing = false;

async function refreshGameFocus(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const windows = await niriQuery("Windows");
    if (!Array.isArray(windows)) {
      if (snapshot && Date.now() - snapshot.at >= SNAPSHOT_STALE_MS) snapshot = null;
      return;
    }
    snapshot = { gameFocused: niriGameWindow(windows)?.is_focused === true, at: Date.now() };
  } finally {
    refreshing = false;
  }
}

/** Never waits on the socket: a stale answer is served while a fresh one is
 *  fetched, and null means niri has not answered once yet. */
export function niriGameFocusSync(): boolean | null {
  if (!isNiriAvailable()) return null;
  if (!snapshot || Date.now() - snapshot.at >= SNAPSHOT_TTL_MS) void refreshGameFocus();
  return snapshot ? snapshot.gameFocused : null;
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

  const game = niriGameWindow(windows);
  if (!game) return null;
  const outputName = niriWorkspaceOutput(workspaces, game.workspace_id);
  const rect = outputName ? outputRect(outputs, outputName) : null;
  const layout = asRecord(game.layout);
  const tilePos = asPair(layout?.tile_pos_in_workspace_view);
  const windowOffset = asPair(layout?.window_offset_in_tile);
  const windowSize = asPair(layout?.window_size);
  if (!rect || !tilePos || !windowOffset || !windowSize) return null;

  return {
    x: Math.round(rect.x + tilePos[0] + windowOffset[0]),
    y: Math.round(rect.y + tilePos[1] + windowOffset[1]),
    width: Math.round(windowSize[0]),
    height: Math.round(windowSize[1]),
  };
}
