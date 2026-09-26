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

// Fractional scales round a fullscreen window's logical size by a pixel.
const FULL_OUTPUT_SLACK = 2;

/** The game as niri lays it out, all in the global logical space. */
export interface NiriGameGeometry {
  output: string;
  outputRect: WindowBounds;
  windowSize: { width: number; height: number };
  /** Known for a floating window and for a tile covering its output; niri
   *  reports no position for a tiled or fullscreen window (niri #2381). */
  rect: WindowBounds | null;
  placement: "floating" | "fullscreen" | "tiled";
  /** False when the game's workspace is not the one its output shows. */
  visible: boolean;
  focused: boolean;
  /** Tiles of the game's size on its workspace, the game included, in column
   *  then tile order; null when niri gives no scrolling position for one. */
  sameSize: { columns: number[]; index: number } | null;
}

function scrollingPos(win: Record<string, unknown>): [number, number] | null {
  return asPair(asRecord(win.layout)?.pos_in_scrolling_layout);
}

function sameSizeTiles(
  windows: unknown[],
  game: Record<string, unknown>,
  size: [number, number],
): NiriGameGeometry["sameSize"] {
  const gamePos = scrollingPos(game);
  if (!gamePos) return null;
  const tiles: Array<{ pos: [number, number]; isGame: boolean }> = [];
  for (const entry of windows) {
    const win = asRecord(entry);
    if (!win || win === game || win.workspace_id !== game.workspace_id) continue;
    if (win.is_floating === true) continue;
    const winSize = asPair(asRecord(win.layout)?.window_size);
    if (!winSize) continue;
    if (Math.abs(winSize[0] - size[0]) > 2 || Math.abs(winSize[1] - size[1]) > 2) continue;
    const pos = scrollingPos(win);
    if (!pos) return null;
    tiles.push({ pos, isGame: false });
  }
  tiles.push({ pos: gamePos, isGame: true });
  tiles.sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);
  return {
    columns: tiles.map((tile) => tile.pos[0]),
    index: tiles.findIndex((tile) => tile.isGame),
  };
}

/** Where niri has the game, or null when any of the three answers is missing a
 *  piece. niri reports a window's position relative to its workspace view, so
 *  the output's logical origin has to be added. */
export async function niriGameGeometry(): Promise<NiriGameGeometry | null> {
  if (!isNiriAvailable()) return null;
  const [windows, workspaces, outputs] = await Promise.all([
    niriQuery("Windows"),
    niriQuery("Workspaces"),
    niriQuery("Outputs"),
  ]);
  if (!Array.isArray(windows) || !Array.isArray(workspaces)) return null;

  const game = niriGameWindow(windows);
  if (!game) return null;
  const output = niriWorkspaceOutput(workspaces, game.workspace_id);
  const outputBounds = output ? outputRect(outputs, output) : null;
  const layout = asRecord(game.layout);
  const windowSize = asPair(layout?.window_size);
  if (!output || !outputBounds || !windowSize) return null;

  const workspace = workspaces.map(asRecord).find((entry) => entry?.id === game.workspace_id);
  const tilePos = asPair(layout?.tile_pos_in_workspace_view);
  const windowOffset = asPair(layout?.window_offset_in_tile) ?? [0, 0];
  const size = { width: Math.round(windowSize[0]), height: Math.round(windowSize[1]) };
  const coversOutput =
    Math.abs(size.width - outputBounds.width) <= FULL_OUTPUT_SLACK &&
    Math.abs(size.height - outputBounds.height) <= FULL_OUTPUT_SLACK;

  let rect: WindowBounds | null = null;
  if (tilePos) {
    rect = {
      x: Math.round(outputBounds.x + tilePos[0] + windowOffset[0]),
      y: Math.round(outputBounds.y + tilePos[1] + windowOffset[1]),
      ...size,
    };
  } else if (coversOutput) {
    rect = { ...outputBounds };
  }
  const floating = game.is_floating === true;
  return {
    output,
    outputRect: outputBounds,
    windowSize: size,
    rect,
    placement: floating ? "floating" : coversOutput ? "fullscreen" : "tiled",
    visible: workspace?.is_active !== false,
    focused: game.is_focused === true,
    sameSize: floating ? null : sameSizeTiles(windows, game, windowSize),
  };
}

/** Screen coordinates of the game window, where niri says where it is. */
export async function niriWindowBounds(): Promise<WindowBounds | null> {
  return (await niriGameGeometry())?.rect ?? null;
}
