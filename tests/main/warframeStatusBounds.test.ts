import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const probe = vi.hoisted(() => ({
  nativeBounds: null as unknown,
  x11Focused: true as boolean | null,
  toplevels: null as unknown,
  outputRects: [] as unknown,
  niriSnapshot: null as unknown,
  niriBounds: null as unknown,
}));

vi.mock("../../services/x11WindowQuery", () => ({
  findWindowBoundsByTitle: vi.fn(() => probe.nativeBounds),
  isWindowFocusedByTitle: vi.fn(() => probe.x11Focused),
}));

vi.mock("../../services/layerShell", () => ({
  layerToplevels: vi.fn(() => probe.toplevels),
  layerOutputRects: vi.fn(() => probe.outputRects),
}));

vi.mock("../../services/niriIpc", () => ({
  niriFocusedWindowSync: vi.fn(() => probe.niriSnapshot),
  niriWindowBounds: vi.fn(() => Promise.resolve(probe.niriBounds)),
}));

vi.mock("node:fs", () => {
  const fs = {
    readdirSync: vi.fn(() => ["1"]),
    readFileSync: vi.fn(() => "Warframe.x64.exe"),
  };
  return { ...fs, default: fs };
});

vi.mock("electron", () => ({
  screen: { getDisplayMatching: vi.fn(() => ({ id: 7 })) },
  app: { once: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

const realPlatform = process.platform;
const realDisplay = process.env.DISPLAY;
const realWaylandDisplay = process.env.WAYLAND_DISPLAY;
const NATIVE_BOUNDS: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restoreEnv(): void {
  if (realDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = realDisplay;
  if (realWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = realWaylandDisplay;
}

// The probe is async and returns whatever the X query handed back, so a
// thenable lets a test hold the bounds request open while its peers finish.
function heldBounds(value: Bounds): { thenable: unknown; release: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    thenable: {
      ...value,
      then: (onFulfilled: (bounds: Bounds) => void) => {
        void opened.then(() => onFulfilled(value));
      },
    },
    release: () => open(),
  };
}

describe("getStatus bounds skipping on linux", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    delete process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    restoreEnv();
  });

  it("skips the X tree walk when the caller only needs focus", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus({ needBounds: false });

    expect(status.isFocused).toBe(true);
    expect(findWindowBoundsByTitle).not.toHaveBeenCalled();
  });

  it("still resolves geometry for callers that anchor to the game display", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalled();
    expect(status.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("never serves a bounds-free cache entry to a caller that needs bounds", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus({ needBounds: false });
    // Inside the 2s TTL: the cheap entry must not satisfy this one.
    const full = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(full.focusedWindowBounds).not.toBeNull();
  });

  it("reuses a bounds-complete cache entry for a cheap caller", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ needBounds: false });

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
  });

  it("keeps the bounds request in flight when its bounds-free peer settles first", async () => {
    const held = heldBounds(NATIVE_BOUNDS);
    probe.nativeBounds = held.thenable;
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const cheap = warframeStatus.getStatus({ needBounds: false });
    const full = warframeStatus.getStatus();
    const cheapStatus = await cheap;

    // The bounds walk is still running, so a caller that bypasses the cache
    // has to join it instead of starting a second one.
    const joined = warframeStatus.getStatus({ force: true });
    held.release();
    const [fullStatus, joinedStatus] = await Promise.all([full, joined]);

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(cheapStatus.focusedWindowBounds).toBeNull();
    expect(fullStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
    expect(joinedStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("keeps cached geometry when a bounds-free probe observes the same instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ force: true, needBounds: false });
    const cached = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(cached.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });
});

const WARFRAME_TOPLEVEL = {
  title: "Warframe",
  appId: "steam_app_230410",
  activated: true,
  fullscreen: true,
  outputs: ["DP-2"],
};

const DP2_RECT = {
  name: "DP-2",
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  scale: 1,
  placed: true,
};

describe("linux focus and geometry precedence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("linux");
    probe.nativeBounds = null;
    probe.x11Focused = true;
    probe.toplevels = null;
    probe.outputRects = [];
    probe.niriSnapshot = null;
    probe.niriBounds = null;
    process.env.DISPLAY = ":0";
    process.env.WAYLAND_DISPLAY = "wayland-1";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    restoreEnv();
  });

  it("asks the compositor before X11 for focus", async () => {
    probe.toplevels = [WARFRAME_TOPLEVEL];
    const { isWindowFocusedByTitle } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(true);
    expect(isWindowFocusedByTitle).not.toHaveBeenCalled();
  });

  it("uses the niri snapshot when no toplevel matches", async () => {
    probe.toplevels = [{ ...WARFRAME_TOPLEVEL, title: "foot", appId: "foot" }];
    probe.niriSnapshot = { window: { title: "foot", appId: "foot" }, at: Date.now() };
    const { isWindowFocusedByTitle } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(false);
    expect(isWindowFocusedByTitle).not.toHaveBeenCalled();
  });

  it("falls back to X11 when no wayland source knows", async () => {
    const { isWindowFocusedByTitle } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(true);
    expect(isWindowFocusedByTitle).toHaveBeenCalled();
  });

  // GNOME native wayland keeps _NET_ACTIVE_WINDOW at 0 all session, which the
  // X11 read reports as "not focused" and would hide every overlay for good.
  it("is unknown when X11 says no and the game has no X11 window", async () => {
    probe.x11Focused = false;
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBeNull();
    isWarframeWindowFocusedLinux();
    // The presence walk is cached, so the one-second poll does not repeat it.
    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
  });

  it("still reports not focused when the game does have an X11 window", async () => {
    probe.x11Focused = false;
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(false);
  });

  it("is unknown when neither wayland nor X11 can answer", async () => {
    probe.x11Focused = null;
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBeNull();
    delete process.env.DISPLAY;
    expect(isWarframeWindowFocusedLinux()).toBeNull();
  });

  it("keeps exact X11 geometry ahead of the compositor rect", async () => {
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    probe.toplevels = [WARFRAME_TOPLEVEL];
    probe.outputRects = [DP2_RECT];
    const { layerToplevels } = await import("../../services/layerShell");
    const { niriWindowBounds } = await import("../../services/niriIpc");
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toEqual(NATIVE_BOUNDS);
    expect(layerToplevels).not.toHaveBeenCalled();
    expect(niriWindowBounds).not.toHaveBeenCalled();
  });

  it("takes the output of a fullscreen toplevel when X11 has nothing", async () => {
    delete process.env.DISPLAY;
    probe.toplevels = [WARFRAME_TOPLEVEL];
    probe.outputRects = [DP2_RECT];
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    // The geometry source is logged, not returned: a plain rect reaches callers.
    expect(await getWarframeWindowBoundsLinux()).toEqual({
      x: 1920,
      y: 0,
      width: 2560,
      height: 1440,
    });
  });

  it("takes the niri rect when the addon cannot answer", async () => {
    delete process.env.DISPLAY;
    probe.niriBounds = { x: 1935, y: 26, width: 1900, height: 1040 };
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toEqual({
      x: 1935,
      y: 26,
      width: 1900,
      height: 1040,
    });
  });

  it("has no geometry when no backend reports the window", async () => {
    delete process.env.DISPLAY;
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toBeNull();
  });
});
