import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface X11Names {
  title: string;
  wmClass: string;
}

const probe = vi.hoisted(() => ({
  nativeBounds: null as unknown,
  x11Focused: true as boolean | null,
  x11Names: null as X11Names | null,
  x11Windows: null as Array<X11Names & { bounds?: Bounds }> | null,
  waylandFocus: null as boolean | null,
  waylandBounds: null as unknown,
}));

// With windows listed, the largest one the matcher accepts wins, as in libX11.
vi.mock("../../services/x11WindowQuery", () => ({
  findWindowBoundsMatching: vi.fn((matches: (names: X11Names) => boolean) => {
    if (!probe.x11Windows) return probe.nativeBounds;
    const hits = probe.x11Windows
      .filter(matches)
      .map((win) => win.bounds ?? (probe.nativeBounds as Bounds));
    return hits.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
  }),
  isActiveWindowMatching: vi.fn((matches: (names: X11Names) => boolean) =>
    probe.x11Names ? matches(probe.x11Names) : probe.x11Focused,
  ),
}));

vi.mock("../../services/waylandGameWindow", () => ({
  waylandGameFocus: vi.fn(() => probe.waylandFocus),
  waylandGameBounds: vi.fn(() => Promise.resolve(probe.waylandBounds)),
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
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus({ needBounds: false });

    expect(status.isFocused).toBe(true);
    expect(findWindowBoundsMatching).not.toHaveBeenCalled();
  });

  it("still resolves geometry for callers that anchor to the game display", async () => {
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus();

    expect(findWindowBoundsMatching).toHaveBeenCalled();
    expect(status.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("never serves a bounds-free cache entry to a caller that needs bounds", async () => {
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus({ needBounds: false });
    // Inside the 2s TTL: the cheap entry must not satisfy this one.
    const full = await warframeStatus.getStatus();

    expect(findWindowBoundsMatching).toHaveBeenCalledTimes(1);
    expect(full.focusedWindowBounds).not.toBeNull();
  });

  it("reuses a bounds-complete cache entry for a cheap caller", async () => {
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ needBounds: false });

    expect(findWindowBoundsMatching).toHaveBeenCalledTimes(1);
  });

  it("keeps the bounds request in flight when its bounds-free peer settles first", async () => {
    const held = heldBounds(NATIVE_BOUNDS);
    probe.nativeBounds = held.thenable;
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const cheap = warframeStatus.getStatus({ needBounds: false });
    const full = warframeStatus.getStatus();
    const cheapStatus = await cheap;

    // The bounds walk is still running, so a caller that bypasses the cache
    // has to join it instead of starting a second one.
    const joined = warframeStatus.getStatus({ force: true });
    held.release();
    const [fullStatus, joinedStatus] = await Promise.all([full, joined]);

    expect(findWindowBoundsMatching).toHaveBeenCalledTimes(1);
    expect(cheapStatus.focusedWindowBounds).toBeNull();
    expect(fullStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
    expect(joinedStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("keeps cached geometry when a bounds-free probe observes the same instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ force: true, needBounds: false });
    const cached = await warframeStatus.getStatus();

    expect(findWindowBoundsMatching).toHaveBeenCalledTimes(1);
    expect(cached.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });
});

const COMPOSITOR_RECT: Bounds = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("linux focus and geometry precedence", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("linux");
    probe.nativeBounds = null;
    probe.x11Focused = true;
    probe.waylandFocus = null;
    probe.waylandBounds = null;
    probe.x11Names = null;
    probe.x11Windows = null;
    process.env.DISPLAY = ":0";
    process.env.WAYLAND_DISPLAY = "wayland-1";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    restoreEnv();
  });

  it.each([true, false])("takes the compositor's focus answer (%s) before X11", async (focused) => {
    probe.waylandFocus = focused;
    const { isActiveWindowMatching } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(focused);
    expect(isActiveWindowMatching).not.toHaveBeenCalled();
  });

  // Whisper notifications and the reward-scan gate read isFocused, which used to
  // mean only "running" on Linux.
  it.each([
    [false, false],
    [true, true],
    [null, true],
  ])("puts the compositor's focus answer (%s) into the status", async (focus, expected) => {
    probe.waylandFocus = focus;
    probe.x11Focused = null;
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus({ needBounds: false, force: true });
    expect(status.isOpen).toBe(true);
    expect(status.isFocused).toBe(expected);
  });

  // A browser on warframe.market used to count as the game, which muted whispers
  // exactly while the player traded there.
  it.each([
    [{ title: "Warframe Market - Mozilla Firefox", wmClass: "Navigator" }, false],
    [{ title: "Warframe", wmClass: "steam_app_230410" }, true],
    [{ title: "", wmClass: "warframe.x64.exe" }, true],
    [{ title: "Warframe", wmClass: "mpv" }, true],
  ])("judges the X11 active window %o as the game: %s", async (names, expected) => {
    probe.x11Names = names;
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(expected);
  });

  // A native game on GNOME/KDE with an XWayland browser open on warframe.market:
  // the browser used to prove an unfocused game and let whispers notify.
  it("does not take a browser naming the game for the game's X11 window", async () => {
    probe.x11Focused = false;
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    probe.x11Windows = [{ title: "Warframe Market - Mozilla Firefox", wmClass: "Navigator" }];
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBeNull();
  });

  it("falls back to X11 when no wayland source knows", async () => {
    const { isActiveWindowMatching } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBe(true);
    expect(isActiveWindowMatching).toHaveBeenCalled();
  });

  // GNOME native wayland keeps _NET_ACTIVE_WINDOW at 0 all session, which the
  // X11 read reports as "not focused" and would hide every overlay for good.
  it("is unknown when X11 says no and the game has no X11 window", async () => {
    probe.x11Focused = false;
    const { findWindowBoundsMatching } = await import("../../services/x11WindowQuery");
    const { isWarframeWindowFocusedLinux } = await import("../../services/warframeStatus");

    expect(isWarframeWindowFocusedLinux()).toBeNull();
    isWarframeWindowFocusedLinux();
    // The presence walk is cached, so the one-second poll does not repeat it.
    expect(findWindowBoundsMatching).toHaveBeenCalledTimes(1);
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
    probe.waylandBounds = { ...COMPOSITOR_RECT, source: "foreign-toplevel" };
    const { waylandGameBounds } = await import("../../services/waylandGameWindow");
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toEqual(NATIVE_BOUNDS);
    expect(waylandGameBounds).not.toHaveBeenCalled();
  });

  it("takes the compositor rect when X11 has nothing", async () => {
    delete process.env.DISPLAY;
    probe.waylandBounds = { ...COMPOSITOR_RECT, source: "foreign-toplevel" };
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    // The geometry source is logged, not returned: a plain rect reaches callers.
    expect(await getWarframeWindowBoundsLinux()).toEqual(COMPOSITOR_RECT);
  });

  it("prefers a windowed game over a larger browser that names it", async () => {
    const game = { x: 100, y: 100, width: 1280, height: 720 };
    probe.x11Windows = [
      { title: "Warframe Market - Mozilla Firefox", wmClass: "Navigator", bounds: NATIVE_BOUNDS },
      { title: "Warframe", wmClass: "steam_app_230410", bounds: game },
    ];
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toEqual(game);
  });

  it("asks the compositor before an X11 browser that names the game", async () => {
    probe.x11Windows = [
      { title: "Warframe Market - Mozilla Firefox", wmClass: "Navigator", bounds: NATIVE_BOUNDS },
    ];
    probe.waylandBounds = { ...COMPOSITOR_RECT, source: "foreign-toplevel" };
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toEqual(COMPOSITOR_RECT);
  });

  it("has no geometry when no backend reports the window", async () => {
    delete process.env.DISPLAY;
    const { getWarframeWindowBoundsLinux } = await import("../../services/warframeStatus");

    expect(await getWarframeWindowBoundsLinux()).toBeNull();
  });
});

describe("X11 position trust", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("linux");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("distrusts X11 positions in a niri session without scanning processes", async () => {
    const fs = await import("node:fs");
    const { x11PositionDistrust } = await import("../../services/warframeStatus");

    expect(x11PositionDistrust({ NIRI_SOCKET: "/run/niri.sock" })).toContain("xwayland-satellite");
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it("distrusts them wherever xwayland-satellite runs, by its cut comm", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue("xwayland-satell\n");
    const { x11PositionDistrust } = await import("../../services/warframeStatus");

    expect(x11PositionDistrust({ DISPLAY: ":0" })).toBe("xwayland-satellite is running");
  });

  it("trusts them under an ordinary X server", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue("Xwayland\n");
    const { x11PositionDistrust } = await import("../../services/warframeStatus");

    expect(x11PositionDistrust({ DISPLAY: ":0" })).toBeNull();
  });
});
