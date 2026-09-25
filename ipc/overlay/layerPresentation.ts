// Presents a passive overlay as a Wayland layer surface instead of a window.
// It is the only way to pick the monitor and sit above a fullscreen game; both
// are impossible for an ordinary window on native Wayland.

import {
  createLayerSurface,
  layerOutputRects,
  type LayerAnchor,
  type LayerPointerEvent,
  type LayerSurface,
} from "../../services/layerShell";
import { withScope } from "../../services/logger";
import { getWarframeWindowBoundsLinux } from "../../services/warframeStatus";
import { resolveGameOutput } from "../../services/waylandCompositor";

interface PaintImage {
  toBitmap: () => Buffer;
}

// Lowercase because that is what electron's typings declare; chromium takes
// either, but only this form typechecks.
type ButtonModifier = "leftbuttondown" | "middlebuttondown" | "rightbuttondown";

// Narrowed to the one overload we use, so an Electron BrowserWindow satisfies it
// without dragging the whole WebContents event map in.
interface PointerInputBase {
  x: number;
  y: number;
  /** Logical screen pixels. Chromium passes these through to DOM screenX and
   *  screenY untouched by the page zoom, and the overlay drag measures its
   *  deltas in them. */
  globalX: number;
  globalY: number;
  /** Held buttons, which is the only thing that sets DOM event.buttons. Without
   *  it every drag stops on its first motion event. */
  modifiers: ButtonModifier[];
}

// Split the way electron splits it, so the union assigns to sendInputEvent.
interface MouseInputEvent extends PointerInputBase {
  type: "mouseEnter" | "mouseLeave" | "mouseMove" | "mouseDown" | "mouseUp";
  button?: "left" | "middle" | "right";
  clickCount?: number;
}

interface WheelInputEvent extends PointerInputBase {
  type: "mouseWheel";
  deltaX: number;
  deltaY: number;
}

type InputEvent = MouseInputEvent | WheelInputEvent;

interface OffscreenWindow {
  setSize?: (width: number, height: number) => void;
  webContents: {
    setFrameRate: (fps: number) => void;
    setZoomFactor?: (factor: number) => void;
    sendInputEvent?: (event: InputEvent) => void;
    on: (
      event: "paint",
      listener: (event: unknown, dirty: unknown, image: PaintImage) => void,
    ) => unknown;
  };
}

/** Where an overlay wants to sit and how large it wants to be, in logical
 *  pixels. x and y are measured from the top-left corner of the output it lands
 *  on, because a layer surface is placed by margins and never by screen
 *  coordinates. zoomFactor is the page zoom that makes the layout fill it. */
export interface LayerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  zoomFactor: number;
}

interface LayerPresentationOptions {
  label: string;
  anchor: LayerAnchor;
  frameRate?: number;
  log?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  createSurface?: typeof createLayerSurface;
  resolveOutput?: () => Promise<string | null>;
  /** Read on every show and on every applyGeometry, so a saved spot, a live drag
   *  and a scale change all land. Absent for overlays with a fixed size. */
  resolveGeometry?: () => LayerGeometry | null;
  /** Distance to hold off the anchored edges when there is no geometry, so a
   *  corner overlay is not flush against the screen edge. */
  inset?: number;
}

const DEFAULT_FRAME_RATE = 30;

const outputLog = withScope("layerOutput");

/** Which monitor holds the game, by matching its window against the compositor's
 *  logical layout. XWayland reports geometry in that same space, so this works on
 *  any compositor, unlike the ipc lookup that only niri, sway and Hyprland answer. */
async function outputFromGameBounds(): Promise<string | null> {
  const rects = layerOutputRects().filter((rect) => rect.placed && rect.width > 0);
  // One monitor cannot be the wrong monitor.
  if (rects.length < 2) return null;
  const bounds = await getWarframeWindowBoundsLinux();
  if (!bounds) return null;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const hit = rects.find(
    (rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
  );
  return hit?.name ?? null;
}

let loggedOutputSource: string | null = null;

function noteOutputSource(source: string, output: string | null): string | null {
  if (loggedOutputSource !== source) {
    loggedOutputSource = source;
    outputLog.info(`[LayerOutput] game monitor from ${source}: ${output ?? "unknown"}`);
  }
  return output;
}

/** Measured rect first: the ipc lookup takes the first window titled /warframe/i. */
export async function resolveOutputForGame(): Promise<string | null> {
  const fromBounds = await outputFromGameBounds();
  if (fromBounds) return noteOutputSource("the game window rect", fromBounds);
  return noteOutputSource("compositor ipc", await resolveGameOutput());
}

export function createLayerPresentation(options: LayerPresentationOptions) {
  const {
    label,
    anchor,
    frameRate = DEFAULT_FRAME_RATE,
    log,
    createSurface = createLayerSurface,
    resolveOutput = resolveOutputForGame,
    resolveGeometry,
    inset = 0,
  } = options;

  let surface: LayerSurface | null = null;
  let attached: OffscreenWindow | null = null;
  let width = 0;
  let height = 0;
  // Page zoom the layout needs at the current size. 1 for a fixed-size overlay
  // like the trade toast, which never reports a geometry.
  let zoom = 1;
  let currentOutput: string | null = null;
  // Top-left of the surface in the compositor's logical space. Wayland only
  // gives surface-local coordinates, and a drag has to be measured on screen.
  let originX = 0;
  let originY = 0;
  let interactive = false;
  // Bumped on every hide so a slow output lookup cannot map a surface for a
  // show the user already dismissed.
  let generation = 0;
  let warnedCommit = false;
  // A show already waiting on the compositor. Two callers drive one trigger (the
  // route creates the window, then the feature controller shows it), and without
  // this both would see no surface and allocate one; the addon has eight slots.
  let pending: Promise<boolean> | null = null;

  /** Size the offscreen window to the surface's pixel size and zoom the page to
   *  match, so a HiDPI output gets a sharp frame instead of an upscaled one.
   *  The zoom carries the overlay's own scale too, or the layout would render
   *  at 1x inside a viewport the scale had already made larger. */
  function applyWindowSize(scale: number): void {
    if (!attached) return;
    try {
      attached.setSize?.(width * scale, height * scale);
      attached.webContents.setZoomFactor?.(Number((zoom * scale).toFixed(3)));
    } catch (err) {
      log?.warn?.(
        `[${label}] could not size to ${width}x${height} at ${scale}x: ${(err as Error)?.message}`,
      );
    }
  }

  /** The wanted spot as margins from the output's top-left corner, kept inside
   *  the output: the saved spot may come from a monitor of a different size. */
  function marginsFor(
    geometry: LayerGeometry,
    output: string | null,
  ): { top: number; left: number } {
    const rect = output ? layerOutputRects().find((entry) => entry.name === output) : undefined;
    const left = Math.max(0, Math.round(geometry.x));
    const top = Math.max(0, Math.round(geometry.y));
    return {
      left:
        rect && rect.width > 0 ? Math.min(left, Math.max(0, rect.width - geometry.width)) : left,
      top:
        rect && rect.height > 0 ? Math.min(top, Math.max(0, rect.height - geometry.height)) : top,
    };
  }

  /** Remember where the surface's top-left landed, so forwarded events can be
   *  reported in screen coordinates. Only a placed surface is draggable, so an
   *  anchored one settles for the output's own origin. */
  function setOrigin(output: string | null, margins: { top: number; left: number } | null): void {
    const rect = output ? layerOutputRects().find((entry) => entry.name === output) : undefined;
    originX = (rect?.x ?? 0) + (margins?.left ?? 0);
    originY = (rect?.y ?? 0) + (margins?.top ?? 0);
  }

  /** How the surface is placed. A geometry pins it to the output's top-left and
   *  positions it by margins; without one it keeps its anchor and the inset
   *  only holds it off the edges it is anchored to. */
  function placementFor(geometry: LayerGeometry | null, output: string | null) {
    if (geometry) {
      const margins = marginsFor(geometry, output);
      return {
        anchor: "top-left" as LayerAnchor,
        marginTop: margins.top,
        marginLeft: margins.left,
      };
    }
    if (!inset || anchor === "center") return { anchor };
    return {
      anchor,
      marginTop: inset,
      marginLeft: anchor === "top-left" ? inset : 0,
      marginRight: anchor === "top-right" ? inset : 0,
    };
  }

  const BUTTONS: Array<"left" | "middle" | "right"> = ["left", "middle", "right"];
  const BUTTON_MODIFIERS: ButtonModifier[] = [
    "leftbuttondown",
    "middlebuttondown",
    "rightbuttondown",
  ];
  // Buttons the compositor has reported down and not yet up.
  const heldButtons = new Set<number>();

  /** A press the old surface never saw released must not ride into the next. */
  function dropSurface(): void {
    heldButtons.clear();
    surface?.destroy();
    surface = null;
  }

  /** One wayland axis notch is 15 units; chromium counts a notch as 120. */
  const WHEEL_PER_AXIS_UNIT = 8;

  function toInputEvent(event: LayerPointerEvent, scale: number): InputEvent | null {
    // Surface-local logical pixels to window pixels. The window is sized in
    // buffer pixels and the page is zoomed by the same factor.
    const x = Math.round(event.x * scale);
    const y = Math.round(event.y * scale);
    // Screen coordinates stay logical: the page zoom does not touch them, and
    // the surface origin moves under the pointer while a drag is running.
    const globalX = Math.round(originX + event.x);
    const globalY = Math.round(originY + event.y);
    if (event.kind === "button") {
      // Updated before the event is built, so a press reports itself as held
      // and a release does not, which is what the DOM does.
      if (event.pressed) heldButtons.add(event.button);
      else heldButtons.delete(event.button);
    }
    if (event.kind === "leave") heldButtons.clear();
    const modifiers = [...heldButtons]
      .map((button) => BUTTON_MODIFIERS[button])
      .filter((modifier): modifier is ButtonModifier => modifier !== undefined);
    const base = { x, y, globalX, globalY, modifiers };
    switch (event.kind) {
      case "enter":
        return { ...base, type: "mouseEnter" };
      case "leave":
        return { ...base, type: "mouseLeave" };
      case "motion":
        return { ...base, type: "mouseMove" };
      case "button":
        return {
          ...base,
          type: event.pressed ? "mouseDown" : "mouseUp",
          button: BUTTONS[event.button] ?? "left",
          clickCount: 1,
        };
      case "axis":
        return {
          ...base,
          type: "mouseWheel",
          deltaX: -event.deltaX * WHEEL_PER_AXIS_UNIT,
          deltaY: -event.deltaY * WHEEL_PER_AXIS_UNIT,
        };
      default:
        return null;
    }
  }

  function forwardEvent(event: LayerPointerEvent): void {
    if (!attached || !surface) return;
    const input = toInputEvent(event, surface.scale);
    if (!input) return;
    try {
      attached.webContents.sendInputEvent?.(input);
    } catch {
      // A destroyed webContents throws; the next show rebuilds the wiring.
    }
  }

  function commitFrame(image: PaintImage): void {
    if (!surface) return;
    let frame: Buffer;
    try {
      frame = image.toBitmap();
    } catch {
      return;
    }
    // A monitor rescaled under a live overlay changes the density the
    // compositor wants, so the window behind it is resized and this frame,
    // painted at the old one, is dropped.
    if (surface.refreshScale()) {
      applyWindowSize(surface.scale);
      return;
    }
    // A resize takes a frame or two to land, and those carry the old size.
    if (frame.length !== surface.frameWidth * surface.frameHeight * 4) return;
    if (surface.commit(frame)) return;
    if (surface.isClosed()) {
      // The compositor took the surface away; drop it so the next show remakes it.
      dropSurface();
      log?.info?.(`[${label}] layer surface closed by the compositor`);
      return;
    }
    if (!warnedCommit) {
      warnedCommit = true;
      log?.warn?.(`[${label}] layer frame refused; further refusals are not logged`);
    }
  }

  return {
    /** Wire an offscreen window's paints to whatever surface is up at the time. */
    attach(window: OffscreenWindow, frameWidth: number, frameHeight: number): void {
      attached = window;
      width = frameWidth;
      height = frameHeight;
      window.webContents.setFrameRate(frameRate);
      window.webContents.on("paint", (_event, _dirty, image) => {
        if (image && typeof image.toBitmap === "function") commitFrame(image);
      });
    },

    /** Map the surface on the output the game is on. Async because only the
     *  compositor knows which that is; frames before it lands are dropped. */
    show(): Promise<boolean> {
      if (surface && !surface.isClosed()) return Promise.resolve(true);
      // Closed while idle: its input sink and, unless the display dropped, its
      // native slot are still held until it is destroyed.
      dropSurface();
      if (pending) return pending;
      const token = generation;
      const attempt = (async () => {
        const output = await resolveOutput();
        if (token !== generation) return false;
        const geometry = resolveGeometry?.() ?? null;
        if (geometry) {
          width = geometry.width;
          height = geometry.height;
          zoom = geometry.zoomFactor;
        }
        currentOutput = output;
        surface = createSurface({ output, width, height, ...placementFor(geometry, output) });
        if (!surface && output) {
          // A named output that has gone away is refused outright. Letting the
          // compositor pick may land on the wrong monitor, which beats nothing.
          log?.warn?.(`[${label}] output ${output} refused a surface; letting the compositor pick`);
          currentOutput = null;
          surface = createSurface({ output: null, width, height, ...placementFor(geometry, null) });
        }
        if (!surface) {
          log?.warn?.(`[${label}] layer surface unavailable; using a window instead`);
          return false;
        }
        warnedCommit = false;
        setOrigin(currentOutput, geometry ? marginsFor(geometry, currentOutput) : null);
        applyWindowSize(surface.scale);
        if (interactive) surface.setInteractive(true, forwardEvent);
        log?.info?.(
          `[${label}] layer surface up on ${output ?? "compositor choice"} at ${surface.scale}x`,
        );
        return true;
      })();
      pending = attempt;
      return attempt.finally(() => {
        if (pending === attempt) pending = null;
      });
    },

    hide(): void {
      generation++;
      // Drop the in-flight show too, or the next show would return its promise
      // and resolve false against the generation this hide just bumped.
      pending = null;
      dropSurface();
    },

    isShowing(): boolean {
      return surface !== null && !surface.isClosed();
    },

    /** Push a new size or spot to a surface that is already up. A drag and a
     *  scale change both land here; a hidden overlay picks the geometry up on
     *  its next show instead. */
    applyGeometry(): void {
      if (!surface || surface.isClosed()) return;
      const geometry = resolveGeometry?.();
      if (!geometry) return;
      const resized = geometry.width !== width || geometry.height !== height;
      width = geometry.width;
      height = geometry.height;
      zoom = geometry.zoomFactor;
      if (resized && !surface.resize(width, height)) {
        // No buffers at the new size means no frame can land, so drop the
        // surface and let the next show build one that fits.
        log?.warn?.(`[${label}] layer surface refused ${width}x${height}; dropping it`);
        dropSurface();
        return;
      }
      const margins = marginsFor(geometry, currentOutput);
      surface.setMargin(margins.top, 0, 0, margins.left);
      setOrigin(currentOutput, margins);
      applyWindowSize(surface.scale);
    },

    /** Accept clicks, or let them fall through to the game. Sticky across shows,
     *  because the surface is remade on every show and starts click-through. */
    setInteractive(next: boolean): void {
      interactive = next;
      surface?.setInteractive(next, forwardEvent);
    },
  };
}
