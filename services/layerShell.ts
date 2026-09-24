// Optional Wayland layer-shell addon. Absent on every platform but Linux, and
// absent on Linux too unless it compiled, so nothing here may throw: a failure
// means the caller keeps its ordinary overlay window.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { withScope } from "./logger";

const log = withScope("layerShell");

interface LayerShellAddon {
  available(): boolean;
  outputs(): string[];
  create(
    output: string | null,
    width: number,
    height: number,
    anchor: number,
    marginTop: number,
    marginRight: number,
    marginBottom: number,
    marginLeft: number,
  ): number;
  commit(handle: number, frame: Buffer): boolean;
  destroy(handle: number): void;
  isClosed(handle: number): boolean;
  scaleOf?(handle: number): number;
  sizeOf?(handle: number): { width: number; height: number } | null;
  setInteractive?(handle: number, interactive: boolean): boolean;
  pollEvents?(): RawPointerEvent[];
  outputRects?(): LayerOutputRect[];
  toplevels?(): WaylandToplevel[] | null;
  setMargin?(handle: number, top: number, right: number, bottom: number, left: number): boolean;
  resize?(handle: number, width: number, height: number): { width: number; height: number } | null;
}

/** One monitor in the compositor's logical layout, which is the same space an
 *  XWayland window's geometry is reported in. `placed` is false when the
 *  compositor offers no xdg-output, leaving the position unknowable. */
interface LayerOutputRect {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  placed: boolean;
}

/** One window the compositor exposes through wlr-foreign-toplevel-management.
 *  `outputs` holds connector names, spelled as in layerOutputRects(). */
export interface WaylandToplevel {
  title: string;
  appId: string;
  activated: boolean;
  fullscreen: boolean;
  outputs: string[];
}

interface RawPointerEvent {
  handle: number;
  type: number;
  x: number;
  y: number;
  button: number;
  pressed: boolean;
  dx: number;
  dy: number;
}

/** Pointer events the compositor delivered to a surface, in surface-local
 *  logical pixels. Mirrors the enum in addon.c. */
export interface LayerPointerEvent {
  kind: "enter" | "leave" | "motion" | "button" | "axis";
  x: number;
  y: number;
  /** 0 left, 1 middle, 2 right. */
  button: number;
  pressed: boolean;
  deltaX: number;
  deltaY: number;
}

const EVENT_KINDS: LayerPointerEvent["kind"][] = ["enter", "leave", "motion", "button", "axis"];

interface LayerShellProbe {
  available: boolean;
  /** Connector names, e.g. DP-1, matching what the compositor ipc reports. */
  outputs: string[];
}

/** Matches the `placement` values overlay windows already use. */
export type LayerAnchor = "center" | "top-left" | "top-right";

export interface LayerSurfaceOptions {
  /** Connector name from probeLayerShell(), or null to let the compositor pick. */
  output: string | null;
  width: number;
  height: number;
  anchor: LayerAnchor;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
}

type EventSink = (event: LayerPointerEvent) => void;

const sinks = new Map<number, EventSink>();
let drainTimer: ReturnType<typeof setInterval> | null = null;

/** One shared drain for every surface: the addon queue is global and reading it
 *  from one surface would swallow another surface's events. */
function pumpEvents(addon: LayerShellAddon): void {
  let raw: RawPointerEvent[];
  try {
    raw = addon.pollEvents?.() ?? [];
  } catch (err) {
    log.warn("[LayerShell] pollEvents failed:", (err as Error)?.message);
    return;
  }
  for (const event of raw) {
    const sink = sinks.get(event.handle);
    const kind = EVENT_KINDS[event.type];
    if (!sink || !kind) continue;
    sink({
      kind,
      x: event.x,
      y: event.y,
      button: event.button,
      pressed: event.pressed === true,
      deltaX: event.dx,
      deltaY: event.dy,
    });
  }
}

function updateDrain(addon: LayerShellAddon): void {
  if (sinks.size > 0 && !drainTimer) {
    // Fast enough that a click never feels late, cheap because an empty queue
    // costs one non-blocking wayland read.
    drainTimer = setInterval(() => pumpEvents(addon), 16);
    drainTimer.unref?.();
    return;
  }
  if (sinks.size === 0 && drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

export interface LayerSurface {
  /** BGRA, at least frameWidth * frameHeight * 4 bytes. False means dropped. */
  commit(frame: Buffer): boolean;
  isClosed(): boolean;
  destroy(): void;
  /** Buffer pixels per logical pixel on the output the surface landed on. */
  scale: number;
  /** Pixel size a frame must have, which is the logical size times the scale. */
  frameWidth: number;
  frameHeight: number;
  /** Accept pointer input, or let clicks fall through to the game. */
  setInteractive(interactive: boolean, onEvent?: EventSink): boolean;
  /** Distance from each anchored edge, in logical pixels. A layer surface has no
   *  position of its own, so this is the only way to move one. */
  setMargin(top: number, right: number, bottom: number, left: number): boolean;
  /** Ask for a new logical size. False means the surface is gone and the caller
   *  must build a fresh one; frameWidth and frameHeight follow a success. */
  resize(width: number, height: number): boolean;
  /** Re-read the density the compositor now uses for this surface, which
   *  changes when its monitor is rescaled. True means scale and the frame size
   *  moved and the caller has to resize whatever paints into it. */
  refreshScale(): boolean;
}

const ANCHOR_TOP = 1;
const ANCHOR_LEFT = 4;
const ANCHOR_RIGHT = 8;

// No anchor bit at all is how the protocol asks the compositor to centre a surface.
const ANCHOR_BITS: Record<LayerAnchor, number> = {
  center: 0,
  "top-left": ANCHOR_TOP | ANCHOR_LEFT,
  "top-right": ANCHOR_TOP | ANCHOR_RIGHT,
};

const ADDON_RELATIVE = path.join("native", "layer-shell", "build", "layershell.node");

function candidatePaths(): string[] {
  const candidates: string[] = [];
  // asarUnpack puts it here in a packaged build; __dirname is inside the asar.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", ADDON_RELATIVE));
  }
  // Unpackaged, this file runs from .electron-build/services, so the repo root
  // is two levels up. One level up is kept for a flatter layout.
  candidates.push(path.join(__dirname, "..", "..", ADDON_RELATIVE));
  candidates.push(path.join(__dirname, "..", ADDON_RELATIVE));
  return candidates;
}

let cached: LayerShellAddon | null | undefined;

function loadAddon(): LayerShellAddon | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== "linux") return cached;
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      // Late require on purpose: a native module that fails to link must not
      // take the import graph down with it.
      const addon = createRequire(__filename)(candidate) as LayerShellAddon;
      if (typeof addon?.available === "function") {
        cached = addon;
        return cached;
      }
      log.warn(`[LayerShell] ${candidate} loaded but exports no available()`);
    } catch (err) {
      log.warn(`[LayerShell] ${candidate} failed to load:`, (err as Error)?.message);
    }
  }
  return cached;
}

/** What the running compositor offers. Null when the addon is not there at all,
 *  which is every Windows and macOS run and any Linux build without it. */
export function probeLayerShell(): LayerShellProbe | null {
  const addon = loadAddon();
  if (!addon) return null;
  try {
    const available = addon.available() === true;
    return { available, outputs: available ? addon.outputs() : [] };
  } catch (err) {
    log.warn("[LayerShell] probe failed:", (err as Error)?.message);
    return null;
  }
}

function makeSurface(
  addon: LayerShellAddon,
  handle: number,
  width: number,
  height: number,
  scale: number,
): LayerSurface {
  let destroyed = false;
  let logicalWidth = width;
  let logicalHeight = height;
  // One latch for every per-frame failure. A surface that fails once fails on
  // every following frame, so an unlatched warning would flood the log.
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    log.warn(message);
  };

  const surface: LayerSurface = {
    scale,
    frameWidth: width * scale,
    frameHeight: height * scale,
    resize(nextWidth: number, nextHeight: number): boolean {
      if (destroyed) return false;
      let granted: { width: number; height: number } | null | undefined;
      try {
        granted = addon.resize?.(handle, Math.floor(nextWidth), Math.floor(nextHeight));
      } catch (err) {
        warnOnce(`[LayerShell] resize failed: ${(err as Error)?.message}`);
        return false;
      }
      if (!granted || granted.width <= 0 || granted.height <= 0) return false;
      // The compositor has the last word on the size, so frames are measured
      // against what it granted rather than what was asked for.
      logicalWidth = granted.width;
      logicalHeight = granted.height;
      surface.frameWidth = logicalWidth * surface.scale;
      surface.frameHeight = logicalHeight * surface.scale;
      return true;
    },
    refreshScale(): boolean {
      if (destroyed) return false;
      let reported: number | undefined;
      try {
        reported = addon.scaleOf?.(handle);
      } catch {
        return false;
      }
      if (typeof reported !== "number" || !Number.isInteger(reported) || reported <= 0)
        return false;
      if (reported === surface.scale) return false;
      surface.scale = reported;
      surface.frameWidth = logicalWidth * reported;
      surface.frameHeight = logicalHeight * reported;
      return true;
    },
    setMargin(top: number, right: number, bottom: number, left: number): boolean {
      if (destroyed) return false;
      try {
        return addon.setMargin?.(handle, top, right, bottom, left) === true;
      } catch (err) {
        warnOnce(`[LayerShell] setMargin failed: ${(err as Error)?.message}`);
        return false;
      }
    },
    setInteractive(interactive: boolean, onEvent?: EventSink): boolean {
      if (destroyed) return false;
      let applied: boolean;
      try {
        applied = addon.setInteractive?.(handle, interactive) === true;
      } catch (err) {
        warnOnce(`[LayerShell] setInteractive failed: ${(err as Error)?.message}`);
        return false;
      }
      // Only route events while the surface actually accepts them, so a stale
      // sink cannot feed clicks to an overlay the user made click-through.
      if (applied && interactive && onEvent) sinks.set(handle, onEvent);
      else sinks.delete(handle);
      updateDrain(addon);
      return applied;
    },
    commit(frame: Buffer): boolean {
      if (destroyed) return false;
      const frameBytes = surface.frameWidth * surface.frameHeight * 4;
      // A short frame would be read past the end of the shm mapping in C.
      if (!Buffer.isBuffer(frame) || frame.length < frameBytes) {
        const got = Buffer.isBuffer(frame) ? `${frame.length} bytes` : "a non-buffer frame";
        warnOnce(
          `[LayerShell] rejected ${got} for a ` +
            `${surface.frameWidth}x${surface.frameHeight} surface, need ${frameBytes}`,
        );
        return false;
      }
      try {
        return addon.commit(handle, frame) === true;
      } catch (err) {
        warnOnce(`[LayerShell] commit failed: ${(err as Error)?.message}`);
        return false;
      }
    },
    isClosed(): boolean {
      if (destroyed) return true;
      try {
        return addon.isClosed(handle) === true;
      } catch (err) {
        // Polled alongside commit, so it shares the latch.
        warnOnce(`[LayerShell] isClosed failed: ${(err as Error)?.message}`);
        return true;
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      sinks.delete(handle);
      updateDrain(addon);
      try {
        addon.destroy(handle);
      } catch (err) {
        log.warn("[LayerShell] destroy failed:", (err as Error)?.message);
      }
    },
  };
  return surface;
}

/** The monitor layout as the compositor sees it. Empty when the addon is absent
 *  or too old to report it, which callers must read as "no opinion". */
export function layerOutputRects(): LayerOutputRect[] {
  const addon = loadAddon();
  if (!addon) return [];
  try {
    if (addon.available() !== true) return [];
    const rects = addon.outputRects?.();
    return Array.isArray(rects) ? rects : [];
  } catch (err) {
    log.warn("[LayerShell] outputRects failed:", (err as Error)?.message);
    return [];
  }
}

let warnedToplevels = false;

/** Every window the compositor exposes, or null when it cannot be asked: no
 *  addon, no display, an addon too old to export it, or no
 *  zwlr_foreign_toplevel_manager_v1, which is how niri and GNOME answer.
 *  available() is not consulted; the addon answers this without layer-shell. */
export function layerToplevels(): WaylandToplevel[] | null {
  const addon = loadAddon();
  if (!addon) return null;
  try {
    const windows = addon.toplevels?.();
    return Array.isArray(windows) ? windows : null;
  } catch (err) {
    if (!warnedToplevels) {
      warnedToplevels = true;
      log.warn("[LayerShell] toplevels failed:", (err as Error)?.message);
    }
    return null;
  }
}

/** A layer-shell surface, or null when one cannot be had. Null is the caller's
 *  only signal, and it means: open an ordinary overlay window instead. */
export function createLayerSurface(options: LayerSurfaceOptions): LayerSurface | null {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    log.warn(`[LayerShell] refusing a ${options.width}x${options.height} surface`);
    return null;
  }

  const addon = loadAddon();
  if (!addon) return null;

  let handle: number;
  try {
    if (addon.available() !== true) return null;
    handle = addon.create(
      options.output ? options.output : null,
      width,
      height,
      ANCHOR_BITS[options.anchor] ?? 0,
      options.marginTop ?? 0,
      options.marginRight ?? 0,
      options.marginBottom ?? 0,
      options.marginLeft ?? 0,
    );
  } catch (err) {
    log.warn("[LayerShell] create failed:", (err as Error)?.message);
    return null;
  }

  if (!Number.isInteger(handle) || handle < 0) {
    log.warn(`[LayerShell] compositor refused a surface on ${options.output ?? "any output"}`);
    return null;
  }
  // An addon without scaleOf reports nothing, which means 1x.
  let scale = 1;
  try {
    const reported = addon.scaleOf?.(handle);
    if (typeof reported === "number" && Number.isInteger(reported) && reported > 0) {
      scale = reported;
    }
  } catch {
    scale = 1;
  }
  // The compositor has the last word on the size here too, and create() reports
  // only the handle, so a granted size that differs would otherwise never be
  // seen and every frame would be refused for its length.
  let granted = { width, height };
  try {
    const reported = addon.sizeOf?.(handle);
    if (reported && reported.width > 0 && reported.height > 0) granted = reported;
  } catch {
    granted = { width, height };
  }
  return makeSurface(addon, handle, granted.width, granted.height, scale);
}
