// A game running as a native wayland client has no X11 window, so neither
// _NET_ACTIVE_WINDOW nor xwininfo can see it. Two sources answer instead:
// wlr-foreign-toplevel-management through the addon, and niri's own ipc.

import { layerOutputRects, layerToplevels } from "./layerShell";
import type { WaylandToplevel } from "./layerShell";
import { niriFocusedWindowSync, niriWindowBounds } from "./niriIpc";
import type { WindowBounds } from "./niriIpc";
import { looksLikeWarframe, pickWarframeWindow } from "./waylandCompositor";

interface WaylandGameBounds extends WindowBounds {
  source: "foreign-toplevel" | "niri";
}

function isWaylandSession(): boolean {
  return !!process.env.WAYLAND_DISPLAY;
}

/** Ranked, not first-hit: a wiki tab or the Steam properties dialog also
 *  carries the name, and reading one of those as the game hides every overlay. */
function findGameToplevel(): WaylandToplevel | null {
  const windows = layerToplevels();
  if (!windows) return null;
  const picked = pickWarframeWindow(
    windows.map((entry) => ({
      title: typeof entry?.title === "string" ? entry.title : "",
      appId: typeof entry?.appId === "string" ? entry.appId : "",
      activated: entry?.activated === true,
      fullscreen: entry?.fullscreen === true,
      entry,
    })),
  );
  return picked ? picked.entry : null;
}

/** True/false only when a wayland source knows; null leaves the answer to X11.
 *  Both reads are non-blocking, because the z-order poll calls this every second. */
export function waylandGameFocus(): boolean | null {
  if (!isWaylandSession()) return null;

  const game = findGameToplevel();
  if (game) return game.activated === true;

  const snapshot = niriFocusedWindowSync();
  if (!snapshot) return null;
  const focused = snapshot.window;
  return focused ? looksLikeWarframe(focused.title, focused.appId) : false;
}

/** A fullscreen toplevel covers its output exactly, which is the only geometry
 *  the protocol carries. An unplaced output has no known origin, so it is not
 *  usable as a position. */
function fullscreenOutputBounds(): WaylandGameBounds | null {
  const game = findGameToplevel();
  if (!game || game.fullscreen !== true) return null;
  const name = Array.isArray(game.outputs) ? game.outputs[0] : null;
  if (typeof name !== "string" || !name) return null;
  const rect = layerOutputRects().find((entry) => entry.name === name && entry.placed);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    source: "foreign-toplevel",
  };
}

export async function waylandGameBounds(): Promise<WaylandGameBounds | null> {
  if (!isWaylandSession()) return null;
  const fromToplevel = fullscreenOutputBounds();
  if (fromToplevel) return fromToplevel;

  const fromNiri = await niriWindowBounds();
  return fromNiri ? { ...fromNiri, source: "niri" } : null;
}
