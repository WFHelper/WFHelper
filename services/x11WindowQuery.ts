import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("x11WindowQuery");

// Depth 3 covers root -> window-manager frame -> client window, which is as deep
// as a reparenting WM puts a top-level window.
const MAX_TREE_DEPTH = 3;
const MAX_WINDOWS_VISITED = 4_000;

interface X11WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- native FFI bindings are untyped at compile time */
interface X11Bindings {
  XOpenDisplay: (...args: any[]) => any;
  XCloseDisplay: (...args: any[]) => any;
  XDefaultRootWindow: (...args: any[]) => any;
  XQueryTree: (...args: any[]) => any;
  XGetGeometry: (...args: any[]) => any;
  XTranslateCoordinates: (...args: any[]) => any;
  XFetchName: (...args: any[]) => any;
  XInternAtom: (...args: any[]) => any;
  XGetWindowProperty: (...args: any[]) => any;
  XFree: (...args: any[]) => any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let _koffi: typeof import("koffi") | null = null;
let _x11: X11Bindings | null = null;
let _loadFailed = false;

function loadBindings(): X11Bindings | null {
  if (_x11) return _x11;
  if (_loadFailed || process.platform !== "linux") return null;

  try {
    _koffi = require("koffi") as typeof import("koffi");
    const lib = _koffi.load("libX11.so.6");
    // Prototype strings keep the signatures readable; every out param is a
    // scalar, so no struct layout has to be mirrored here.
    _x11 = {
      XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
      XCloseDisplay: lib.func("int XCloseDisplay(void *display)"),
      XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *display)"),
      XQueryTree: lib.func(
        "int XQueryTree(void *display, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *nchildren)",
      ),
      XGetGeometry: lib.func(
        "int XGetGeometry(void *display, unsigned long d, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *width, _Out_ unsigned int *height, _Out_ unsigned int *border_width, _Out_ unsigned int *depth)",
      ),
      XTranslateCoordinates: lib.func(
        "int XTranslateCoordinates(void *display, unsigned long src_w, unsigned long dest_w, int src_x, int src_y, _Out_ int *dest_x, _Out_ int *dest_y, _Out_ unsigned long *child)",
      ),
      // void** rather than char**: koffi would hand back a copied string and the
      // X-allocated buffer would leak, since XFree needs the pointer itself.
      XFetchName: lib.func("int XFetchName(void *display, unsigned long w, _Out_ void **name)"),
      XInternAtom: lib.func(
        "unsigned long XInternAtom(void *display, const char *atom_name, int only_if_exists)",
      ),
      XGetWindowProperty: lib.func(
        "int XGetWindowProperty(void *display, unsigned long w, unsigned long property, long long_offset, long long_length, int delete, unsigned long req_type, _Out_ unsigned long *actual_type, _Out_ int *actual_format, _Out_ unsigned long *nitems, _Out_ unsigned long *bytes_after, _Out_ void **prop)",
      ),
      XFree: lib.func("int XFree(void *data)"),
    };
    return _x11;
  } catch (err) {
    _loadFailed = true;
    log.warn("[X11] libX11 unavailable:", normalizeErrorMessage(err));
    return null;
  }
}

// Property text, up to 1024 items; NULs separate WM_CLASS's two strings.
function readTextProperty(
  x11: X11Bindings,
  display: unknown,
  window: number,
  atomName: string,
): string {
  const atom = Number(x11.XInternAtom(display, atomName, 1));
  if (!atom) return "";

  const actualType = [0];
  const actualFormat = [0];
  const itemCount = [0];
  const bytesAfter = [0];
  const property = [null];
  const status = x11.XGetWindowProperty(
    display,
    window,
    atom,
    0,
    1024,
    0,
    0,
    actualType,
    actualFormat,
    itemCount,
    bytesAfter,
    property,
  );
  if (status !== 0) return "";

  const ptr = property[0];
  if (!ptr) return "";
  const count = Number(itemCount[0]) || 0;
  try {
    if (count <= 0) return "";
    // decode copies; koffi.view would hand back memory we are about to free.
    const bytes = _koffi!.decode(ptr, "unsigned char", count) as number[];
    return Buffer.from(bytes).toString("utf8").replace(/\0/g, " ").trim();
  } finally {
    x11.XFree(ptr);
  }
}

function readLegacyName(x11: X11Bindings, display: unknown, window: number): string {
  const namePtr = [null];
  if (!x11.XFetchName(display, window, namePtr)) return "";
  const ptr = namePtr[0];
  if (!ptr) return "";
  try {
    const name = _koffi!.decode(ptr, "char", -1);
    return typeof name === "string" ? name : "";
  } finally {
    x11.XFree(ptr);
  }
}

function readWindowBounds(
  x11: X11Bindings,
  display: unknown,
  root: number,
  window: number,
): X11WindowBounds | null {
  try {
    const geometryRoot = [0];
    const x = [0];
    const y = [0];
    const width = [0];
    const height = [0];
    const borderWidth = [0];
    const depth = [0];
    if (!x11.XGetGeometry(display, window, geometryRoot, x, y, width, height, borderWidth, depth)) {
      return null;
    }

    // Geometry is parent-relative, so translate to the root for a screen position.
    const absoluteX = [0];
    const absoluteY = [0];
    const child = [0];
    if (!x11.XTranslateCoordinates(display, window, root, 0, 0, absoluteX, absoluteY, child)) {
      return null;
    }

    return { x: absoluteX[0], y: absoluteY[0], width: width[0], height: height[0] };
  } catch {
    return null;
  }
}

function childrenOf(x11: X11Bindings, display: unknown, window: number): number[] {
  const root = [0];
  const parent = [0];
  const children = [null];
  const count = [0];
  if (!x11.XQueryTree(display, window, root, parent, children, count)) return [];

  const listPtr = children[0];
  const total = Number(count[0]) || 0;
  if (!listPtr || total <= 0) return [];

  try {
    const ids = _koffi!.decode(listPtr, "unsigned long", total) as number[];
    return Array.from(ids, (id) => Number(id));
  } finally {
    x11.XFree(listPtr);
  }
}

function readWindowIdProperty(
  x11: X11Bindings,
  display: unknown,
  window: number,
  atomName: string,
): number | null {
  const atom = Number(x11.XInternAtom(display, atomName, 1));
  if (!atom) return null;

  const actualType = [0];
  const actualFormat = [0];
  const itemCount = [0];
  const bytesAfter = [0];
  const property = [null];
  const status = x11.XGetWindowProperty(
    display,
    window,
    atom,
    0,
    1,
    0,
    0,
    actualType,
    actualFormat,
    itemCount,
    bytesAfter,
    property,
  );
  if (status !== 0) return null;

  const ptr = property[0];
  if (!ptr) return null;
  try {
    if ((Number(itemCount[0]) || 0) <= 0) return null;
    const ids = _koffi!.decode(ptr, "unsigned long", 1) as number[];
    return Number(ids[0]);
  } finally {
    x11.XFree(ptr);
  }
}

/** Title and class of an X window, what a game match is judged on. */
export interface X11WindowNames {
  title: string;
  wmClass: string;
}

function readWindowNames(x11: X11Bindings, display: unknown, window: number): X11WindowNames {
  try {
    return {
      title:
        readTextProperty(x11, display, window, "_NET_WM_NAME") ||
        readLegacyName(x11, display, window),
      wmClass: readTextProperty(x11, display, window, "WM_CLASS"),
    };
  } catch {
    // A window can disappear between the tree walk and this call.
    return { title: "", wmClass: "" };
  }
}

/** Whether `matches` accepts the X active window; null when focus cannot be read at all. */
export function isActiveWindowMatching(
  matches: (names: X11WindowNames) => boolean,
): boolean | null {
  const x11 = loadBindings();
  if (!x11) return null;

  let display: unknown = null;
  try {
    display = x11.XOpenDisplay(null);
    if (!display) return null;

    const root = Number(x11.XDefaultRootWindow(display));
    const active = readWindowIdProperty(x11, display, root, "_NET_ACTIVE_WINDOW");
    if (active === null) return null;
    // 0 = focus sits on a non-X client (native wayland window) or nowhere.
    if (active === 0) return false;
    return matches(readWindowNames(x11, display, active));
  } catch (err) {
    log.warn("[X11] focus query failed:", normalizeErrorMessage(err));
    return null;
  } finally {
    try {
      if (display) x11.XCloseDisplay(display);
    } catch {
      // closing a broken display connection is best effort
    }
  }
}

/** Largest matching window in absolute screen coordinates, null when unavailable. */
export function findWindowBoundsMatching(
  matches: (names: X11WindowNames) => boolean,
  minEdgePx = 200,
): X11WindowBounds | null {
  const x11 = loadBindings();
  if (!x11) return null;

  let display: unknown = null;
  try {
    display = x11.XOpenDisplay(null);
    if (!display) return null;

    const root = Number(x11.XDefaultRootWindow(display));
    let best: X11WindowBounds | null = null;
    let visited = 0;
    let frontier = [root];

    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const window of frontier) {
        if (++visited > MAX_WINDOWS_VISITED) break;
        next.push(...childrenOf(x11, display, window));
        if (window === root) continue;

        if (!matches(readWindowNames(x11, display, window))) continue;
        const bounds = readWindowBounds(x11, display, root, window);
        if (!bounds || bounds.width < minEdgePx || bounds.height < minEdgePx) continue;
        if (!best || bounds.width * bounds.height > best.width * best.height) best = bounds;
      }
      frontier = next;
    }

    return best;
  } catch (err) {
    log.warn("[X11] window query failed:", normalizeErrorMessage(err));
    return null;
  } finally {
    try {
      if (display) x11.XCloseDisplay(display);
    } catch {
      // closing a broken display connection is best effort
    }
  }
}
