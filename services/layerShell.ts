// Optional Wayland layer-shell addon. Absent on every platform but Linux, and
// absent on Linux too unless it compiled, so nothing here may throw: a failure
// means the caller keeps its ordinary overlay window.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { withScope } from "./logger";
import { sleep } from "./sleep";

const log = withScope("layerShell");

interface LayerShellAddon {
  available(): boolean;
  outputs(): string[];
  /** An opaque handle that is never reissued, so a dead one cannot reach a new surface; or -1. */
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
  /** Why the addon last dropped its compositor connection, handed out once. */
  takeDropReason?(): string | null;
  screencopyAvailable?(): boolean;
  /** Starts one copy of the named output; screencopyPoll() reports how it went. */
  screencopyStart?(output: string): boolean;
  screencopyPoll?(): RawScreenCopy;
  screencopyCancel?(): void;
}

/** The copy as the compositor wrote it. The frame fields are set once ready. */
interface RawScreenCopy {
  state: "idle" | "pending" | "ready" | "failed";
  reason?: string;
  width?: number;
  height?: number;
  stride?: number;
  /** wl_shm format code. */
  format?: number;
  /** Rows run bottom to top. */
  yInvert?: boolean;
  /** The output's wl_output.transform, which the buffer still carries. */
  transform?: number;
  pixels?: Buffer;
}

/** A monitor's pixels in the form the Linux capture path hands to the scanners. */
interface ScreenCopy {
  width: number;
  height: number;
  /** BGRA, top row first, rows packed at width * 4 bytes, alpha 255. */
  bitmap: Buffer;
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

/** Runs after every addon call that can reach the display. The addon hands
 *  each reason out once, so a drop is logged once whichever call noticed it. */
function reportDrop(addon: LayerShellAddon): void {
  let reason: string | null | undefined;
  try {
    reason = addon.takeDropReason?.();
  } catch {
    return;
  }
  if (typeof reason === "string" && reason) {
    log.warn(`[LayerShell] compositor connection lost: ${reason}`);
  }
}

/** One shared drain for every surface: the addon queue is global and reading it
 *  from one surface would swallow another surface's events. */
function pumpEvents(addon: LayerShellAddon): void {
  let raw: RawPointerEvent[];
  try {
    raw = addon.pollEvents?.() ?? [];
  } catch (err) {
    log.warn("[LayerShell] pollEvents failed:", (err as Error)?.message);
    return;
  } finally {
    reportDrop(addon);
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
// Set by the startup probe, the first call allowed to connect to the compositor.
let probed = false;

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
  probed = true;
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
      } finally {
        reportDrop(addon);
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
      } finally {
        reportDrop(addon);
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
      } finally {
        reportDrop(addon);
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
      } finally {
        reportDrop(addon);
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
      } finally {
        reportDrop(addon);
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
      } finally {
        reportDrop(addon);
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
  } finally {
    reportDrop(addon);
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
  } finally {
    reportDrop(addon);
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
  } finally {
    reportDrop(addon);
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

// A copy lands on the output's next repaint, a few frames at worst. This bounds
// how long a scan waits: polls are non-blocking reads, and only a start that has
// to reconnect a dropped connection holds the thread, for two 150ms roundtrips.
const SCREEN_COPY_TIMEOUT_MS = 1000;
const SCREEN_COPY_POLL_MS = 4;

// wl_shm codes: 0 and 1 are the protocol's own, the rest are DRM fourccs. The
// names read as a little-endian word, so ARGB8888 is B, G, R, A in memory.
const SHM_ARGB8888 = 0;
const SHM_XRGB8888 = 1;
const SHM_ABGR8888 = 0x34324241;
const SHM_XBGR8888 = 0x34324258;
const SHM_ARGB2101010 = 0x30335241;
const SHM_XRGB2101010 = 0x30335258;
const SHM_ABGR2101010 = 0x30334241;
const SHM_XBGR2101010 = 0x30334258;

type PixelLayout = "bgra" | "rgba" | "rgb10" | "bgr10";

const PIXEL_LAYOUTS = new Map<number, PixelLayout>([
  [SHM_ARGB8888, "bgra"],
  [SHM_XRGB8888, "bgra"],
  [SHM_ABGR8888, "rgba"],
  [SHM_XBGR8888, "rgba"],
  [SHM_ARGB2101010, "rgb10"],
  [SHM_XRGB2101010, "rgb10"],
  [SHM_ABGR2101010, "bgr10"],
  [SHM_XBGR2101010, "bgr10"],
]);

// Alpha is forced opaque: an X format leaves that byte undefined.
function convertRow(
  layout: PixelLayout,
  source: Uint32Array,
  from: number,
  out: Uint32Array,
  to: number,
  width: number,
): void {
  switch (layout) {
    case "bgra":
      for (let x = 0; x < width; x++) out[to + x] = source[from + x] | 0xff000000;
      return;
    case "rgba":
      for (let x = 0; x < width; x++) {
        const v = source[from + x];
        out[to + x] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
      }
      return;
    case "rgb10":
      for (let x = 0; x < width; x++) {
        const v = source[from + x];
        out[to + x] =
          0xff000000 |
          (((v >>> 22) & 0xff) << 16) |
          (((v >>> 12) & 0xff) << 8) |
          ((v >>> 2) & 0xff);
      }
      return;
    case "bgr10":
      for (let x = 0; x < width; x++) {
        const v = source[from + x];
        out[to + x] =
          0xff000000 |
          (((v >>> 2) & 0xff) << 16) |
          (((v >>> 12) & 0xff) << 8) |
          ((v >>> 22) & 0xff);
      }
      return;
  }
}

/** Reads a w by h buffer back upright: the index of the top-left pixel, then the
 *  step for one pixel right and one row down. wl_output.transform names what the
 *  compositor did: 90/180/270 turn the picture counter-clockwise, flipped ones
 *  mirror it left to right first. Null for a value the protocol lacks. */
function transformWalk(transform: number, w: number, h: number): [number, number, number] | null {
  switch (transform) {
    case 0:
      return [0, 1, w];
    case 1:
      return [(h - 1) * w, -w, 1];
    case 2:
      return [w * h - 1, -1, -w];
    case 3:
      return [w - 1, w, -1];
    case 4:
      return [w - 1, -1, w];
    case 5:
      return [0, w, 1];
    case 6:
      return [(h - 1) * w, 1, -w];
    case 7:
      return [w * h - 1, -w, -1];
    default:
      return null;
  }
}

/** Repacks a finished copy as BGRA, top row first and upright, or null when
 *  its format, size or transform cannot be read. */
function toScreenCopy(raw: RawScreenCopy): ScreenCopy | null {
  const { width, height, stride, format, pixels } = raw;
  if (typeof width !== "number" || typeof height !== "number" || typeof stride !== "number") {
    return null;
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(stride)) {
    return null;
  }
  const layout = PIXEL_LAYOUTS.get(format ?? -1);
  if (!layout || width <= 0 || height <= 0 || stride < width * 4 || stride % 4 !== 0) return null;
  if (!Buffer.isBuffer(pixels) || pixels.length < stride * height) return null;
  const transform = raw.transform ?? 0;
  const walk = transformWalk(transform, width, height);
  if (!walk) return null;

  // A word view needs 4-byte alignment, which a Buffer's offset does not promise.
  const bytes = pixels.byteOffset % 4 === 0 ? pixels : new Uint8Array(pixels);
  const source = new Uint32Array(bytes.buffer, bytes.byteOffset, (stride * height) / 4);
  let out = new Uint32Array(width * height);
  const rowWords = stride / 4;
  for (let y = 0; y < height; y++) {
    const from = (raw.yInvert === true ? height - 1 - y : y) * rowWords;
    convertRow(layout, source, from, out, y * width, width);
  }
  let outWidth = width;
  let outHeight = height;
  if (transform !== 0) {
    // Odd transforms turn the picture a quarter, so its sides swap.
    if (transform % 2 === 1) [outWidth, outHeight] = [height, width];
    const [origin, stepX, stepY] = walk;
    const upright = new Uint32Array(width * height);
    let to = 0;
    for (let y = 0, row = origin; y < outHeight; y++, row += stepY) {
      for (let x = 0, at = row; x < outWidth; x++, at += stepX) upright[to++] = out[at];
    }
    out = upright;
  }
  return {
    width: outWidth,
    height: outHeight,
    bitmap: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
  };
}

let lastCopyFailure: string | null = null;
const loggedCopyShapes = new Set<string>();

// Once per reason: a scan retries, and every retry would fail the same way.
function noteCopyFailure(reason: string): void {
  if (reason === lastCopyFailure) return;
  lastCopyFailure = reason;
  log.warn(`[LayerShell] screen copy failed: ${reason}`);
}

function noteCopyShape(output: string, raw: RawScreenCopy): void {
  const shape =
    `${output} ${raw.width}x${raw.height} format 0x${(raw.format ?? 0).toString(16)}` +
    `${raw.yInvert === true ? " y-inverted" : ""}` +
    `${raw.transform ? ` transform ${raw.transform}` : ""}`;
  lastCopyFailure = null;
  if (loggedCopyShapes.has(shape)) return;
  loggedCopyShapes.add(shape);
  log.info(`[LayerShell] screen copy of ${shape}`);
}

/** Why the last screen copy failed, or null once one succeeded. */
export function screenCopyFailure(): string | null {
  return lastCopyFailure;
}

// A dropped connection makes the addon answer no until it reconnects; a scan in
// that window should fail, not fall back to the portal's dialog over the game.
let screenCopySeen = false;

/** Whether a scan can copy the screen straight from the compositor, without a
 *  portal. False until the startup probe has run, so an early caller never
 *  makes the first connect and moves its cost out of that probe. Once true it
 *  stays true for the session. */
export function screenCopyAvailable(): boolean {
  if (screenCopySeen) return true;
  if (!probed) return false;
  const addon = loadAddon();
  if (typeof addon?.screencopyAvailable !== "function") return false;
  try {
    screenCopySeen = addon.screencopyAvailable() === true;
    return screenCopySeen;
  } catch (err) {
    noteCopyFailure(`availability check threw: ${(err as Error)?.message}`);
    return false;
  } finally {
    reportDrop(addon);
  }
}

async function runCopy(addon: LayerShellAddon, output: string): Promise<ScreenCopy | null> {
  const deadline = Date.now() + SCREEN_COPY_TIMEOUT_MS;
  // Only a copy left pending is cancelled; ready and failed free themselves.
  let settled = false;
  try {
    addon.screencopyStart?.(output);
    reportDrop(addon);
    for (;;) {
      const raw = addon.screencopyPoll?.();
      reportDrop(addon);
      if (raw?.state === "ready") {
        settled = true;
        const copy = toScreenCopy(raw);
        if (!copy) {
          noteCopyFailure(
            `unreadable frame ${raw.width}x${raw.height} stride ${raw.stride}` +
              ` format 0x${(raw.format ?? 0).toString(16)}` +
              `${raw.transform ? ` transform ${raw.transform}` : ""}`,
          );
          return null;
        }
        noteCopyShape(output, raw);
        return copy;
      }
      if (raw?.state !== "pending") {
        settled = true;
        noteCopyFailure(raw?.reason || "no copy in progress");
        return null;
      }
      if (Date.now() >= deadline) {
        noteCopyFailure(`${output} sent no frame within ${SCREEN_COPY_TIMEOUT_MS}ms`);
        return null;
      }
      await sleep(SCREEN_COPY_POLL_MS);
    }
  } catch (err) {
    noteCopyFailure(`threw: ${(err as Error)?.message}`);
    return null;
  } finally {
    if (!settled) {
      try {
        addon.screencopyCancel?.();
      } catch {
        // The next start frees whatever this left.
      }
    }
    reportDrop(addon);
  }
}

let inFlight: { output: string; copy: Promise<ScreenCopy | null> } | null = null;

/** One frame of the named output, cursor left out, or null. The addon holds a
 *  single copy, so overlapping callers for the same output share it and any
 *  other output waits its turn. */
export async function copyOutput(output: string): Promise<ScreenCopy | null> {
  const addon = loadAddon();
  if (typeof addon?.screencopyStart !== "function" || typeof addon.screencopyPoll !== "function") {
    return null;
  }
  while (inFlight) {
    if (inFlight.output === output) return inFlight.copy;
    await inFlight.copy;
  }
  const entry = { output, copy: runCopy(addon, output) };
  inFlight = entry;
  void entry.copy.finally(() => {
    if (inFlight === entry) inFlight = null;
  });
  return entry.copy;
}
