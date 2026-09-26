import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayerAnchor, LayerSurfaceOptions } from "../../services/layerShell";

interface FakeAddon {
  available: ReturnType<typeof vi.fn>;
  outputs: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isClosed: ReturnType<typeof vi.fn>;
  scaleOf: ReturnType<typeof vi.fn>;
  sizeOf?: ReturnType<typeof vi.fn>;
  setInteractive: ReturnType<typeof vi.fn>;
  pollEvents: ReturnType<typeof vi.fn>;
  toplevels?: ReturnType<typeof vi.fn>;
  takeDropReason?: ReturnType<typeof vi.fn>;
}

// The loader's own require is the only seam a native addon can be injected
// through. With nothing injected it falls through to the real require, so the
// missing- and broken-addon cases still exercise the real failure.
const injected = vi.hoisted(() => ({ addon: null as unknown }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: ((filename: string | URL) => {
      const real = actual.createRequire(filename);
      const shim = (id: string): unknown => (injected.addon ? injected.addon : real(id));
      return Object.assign(shim, real);
    }) as typeof actual.createRequire,
  };
});

const logged = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ ...logged, time: () => {}, timeEnd: () => {} }),
}));

vi.mock("../../services/warframeStatus", () => ({
  getWarframeWindowBoundsLinux: vi.fn(async () => null),
}));

vi.mock("../../services/waylandCompositor", () => ({
  resolveGameOutput: vi.fn(async () => null),
}));

// The module caches its load, so each case needs a fresh copy of it.
async function freshProbe() {
  vi.resetModules();
  const module = await import("../../services/layerShell");
  return module.probeLayerShell;
}

async function freshCreate() {
  vi.resetModules();
  const module = await import("../../services/layerShell");
  return module.createLayerSurface;
}

async function freshToplevels() {
  vi.resetModules();
  const module = await import("../../services/layerShell");
  return module.layerToplevels;
}

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Puts a fake addon where the loader looks: linux, addon file reported present. */
function useAddon(overrides: Partial<FakeAddon> = {}): FakeAddon {
  setPlatform("linux");
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  const addon: FakeAddon = {
    available: vi.fn(() => true),
    outputs: vi.fn(() => ["DP-1"]),
    create: vi.fn(() => 0),
    commit: vi.fn(() => true),
    destroy: vi.fn(),
    isClosed: vi.fn(() => false),
    scaleOf: vi.fn(() => 1),
    setInteractive: vi.fn(() => true),
    pollEvents: vi.fn(() => []),
    ...overrides,
  };
  injected.addon = addon;
  return addon;
}

const surfaceOptions = (extra: Partial<LayerSurfaceOptions> = {}): LayerSurfaceOptions => ({
  output: "DP-1",
  width: 4,
  height: 2,
  anchor: "center",
  ...extra,
});

/** The frame the 4x2 fixture surface expects: BGRA, four bytes a pixel. */
const fullFrame = (): Buffer => Buffer.alloc(4 * 2 * 4);

const connectionLostLines = (): unknown[] =>
  logged.warn.mock.calls
    .map(([message]) => message as unknown)
    .filter((message) => String(message).startsWith("[LayerShell] compositor connection lost"));

afterEach(() => {
  setPlatform(realPlatform);
  injected.addon = null;
  for (const spy of Object.values(logged)) spy.mockClear();
  vi.restoreAllMocks();
});

// The addon's own behaviour is covered by running it against a real compositor;
// what matters here is that its absence is never fatal.
describe("probeLayerShell", () => {
  it("is null off linux without even looking for the addon", async () => {
    setPlatform("win32");
    const exists = vi.spyOn(fs, "existsSync");

    expect((await freshProbe())()).toBeNull();
    // Other modules stat their own files during the import, so only ours counts.
    const looked = exists.mock.calls.map(([target]) => String(target));
    expect(looked.some((target) => target.includes("layershell.node"))).toBe(false);
  });

  it("is null on linux when the addon was never built", async () => {
    setPlatform("linux");
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect((await freshProbe())()).toBeNull();
    // Not vacuous: it did look, and looked where a packaged build puts it.
    expect(exists).toHaveBeenCalled();
    const looked = exists.mock.calls.map(([target]) => String(target));
    expect(looked.some((target) => target.includes("layershell.node"))).toBe(true);
  });

  // Compiled main runs from .electron-build/services, so one level up lands
  // inside the build output where the addon never is. Two roots are probed for
  // that reason; dropping either one silently disables the addon in dev.
  it("probes two roots, a level apart", async () => {
    setPlatform("linux");
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    await (
      await freshProbe()
    )();

    const looked = [
      ...new Set(
        exists.mock.calls
          .map(([target]) => path.normalize(String(target)))
          .filter((target) => target.endsWith("layershell.node")),
      ),
    ].sort((a, b) => a.length - b.length);

    expect(looked).toHaveLength(2);
    const up = (target: string, times: number): string =>
      times === 0 ? target : up(path.dirname(target), times - 1);
    expect(up(looked[0], 4)).toBe(up(looked[1], 5));
  });

  // The whole point of the optional addon: a present but broken one is not fatal.
  it("is null when a present addon fails to load", async () => {
    setPlatform("linux");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect((await freshProbe())()).toBeNull();
  });

  it("caches the failed load instead of retrying every call", async () => {
    setPlatform("linux");
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const probe = await freshProbe();

    probe();
    const afterFirst = exists.mock.calls.length;
    probe();

    expect(exists.mock.calls.length).toBe(afterFirst);
  });
});

describe("createLayerSurface", () => {
  it("is null with no addon, so the caller opens a normal window", async () => {
    setPlatform("linux");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect((await freshCreate())(surfaceOptions())).toBeNull();
  });

  it("is null when the compositor does not offer the protocol", async () => {
    const addon = useAddon({ available: vi.fn(() => false) });

    expect((await freshCreate())(surfaceOptions())).toBeNull();
    expect(addon.create).not.toHaveBeenCalled();
  });

  it("is null when the compositor refuses the surface", async () => {
    useAddon({ create: vi.fn(() => -1) });

    expect((await freshCreate())(surfaceOptions())).toBeNull();
  });

  it("measures frames against the size the compositor granted", async () => {
    useAddon({ sizeOf: vi.fn(() => ({ width: 6, height: 3 })), scaleOf: vi.fn(() => 2) });

    const surface = (await freshCreate())(surfaceOptions({ width: 4, height: 2 }));

    expect(surface?.frameWidth).toBe(12);
    expect(surface?.frameHeight).toBe(6);
  });

  it("keeps the requested size when the addon cannot report one", async () => {
    useAddon({ sizeOf: vi.fn(() => null) });

    const surface = (await freshCreate())(surfaceOptions({ width: 4, height: 2 }));

    expect(surface?.frameWidth).toBe(4);
    expect(surface?.frameHeight).toBe(2);
  });

  it.each([
    ["center", 0],
    ["top-left", 5],
    ["top-right", 9],
  ] as [LayerAnchor, number][])("anchors %s as %i", async (anchor, bits) => {
    const addon = useAddon();

    expect((await freshCreate())(surfaceOptions({ anchor }))).not.toBeNull();
    expect(addon.create.mock.calls[0]?.[3]).toBe(bits);
  });

  it("passes the output through and defaults every margin to 0", async () => {
    const addon = useAddon();

    (await freshCreate())(surfaceOptions({ output: "HDMI-A-2", width: 640, height: 360 }));

    expect(addon.create.mock.calls[0]).toEqual(["HDMI-A-2", 640, 360, 0, 0, 0, 0, 0]);
  });

  it("passes margins in top, right, bottom, left order", async () => {
    const addon = useAddon();

    (await freshCreate())(
      surfaceOptions({ marginTop: 12, marginRight: 34, marginBottom: 56, marginLeft: 78 }),
    );

    expect(addon.create.mock.calls[0]?.slice(4)).toEqual([12, 34, 56, 78]);
  });

  it("sends a null output when none is asked for", async () => {
    const addon = useAddon();

    (await freshCreate())(surfaceOptions({ output: null }));

    expect(addon.create.mock.calls[0]?.[0]).toBeNull();
  });

  it.each([
    [0, 10],
    [10, 0],
    [-4, 10],
    [10, -4],
    [Number.NaN, 10],
  ])("is null for a %s by %s surface without calling native", async (width, height) => {
    const addon = useAddon();

    expect((await freshCreate())(surfaceOptions({ width, height }))).toBeNull();
    expect(addon.create).not.toHaveBeenCalled();
  });

  it("is null when the addon throws instead of returning a handle", async () => {
    useAddon({
      create: vi.fn(() => {
        throw new Error("no compositor");
      }),
    });

    expect((await freshCreate())(surfaceOptions())).toBeNull();
  });
});

describe("LayerSurface", () => {
  async function open(overrides: Partial<FakeAddon> = {}) {
    const addon = useAddon({ create: vi.fn(() => 3), ...overrides });
    const surface = (await freshCreate())(surfaceOptions());
    if (!surface) throw new Error("expected a surface");
    return { addon, surface };
  }

  it("commits a frame of exactly the surface size", async () => {
    const { addon, surface } = await open();
    const frame = fullFrame();

    expect(surface.commit(frame)).toBe(true);
    expect(addon.commit).toHaveBeenCalledWith(3, frame);
  });

  // A frame shorter than the shm mapping would be read past its end in C.
  it("rejects a short frame without handing it to native code", async () => {
    const { addon, surface } = await open();

    expect(surface.commit(Buffer.alloc(4 * 2 * 4 - 1))).toBe(false);
    expect(addon.commit).not.toHaveBeenCalled();
  });

  it("logs a repeatedly failing commit once, not once per frame", async () => {
    const { surface } = await open();
    const short = Buffer.alloc(4);

    for (let i = 0; i < 10; i++) expect(surface.commit(short)).toBe(false);

    expect(logged.warn).toHaveBeenCalledTimes(1);
  });

  it("reports a compositor-closed surface", async () => {
    const { surface } = await open({ isClosed: vi.fn(() => true) });

    expect(surface.isClosed()).toBe(true);
  });

  it("is inert after destroy", async () => {
    const { addon, surface } = await open();
    surface.destroy();

    expect(surface.commit(fullFrame())).toBe(false);
    expect(surface.isClosed()).toBe(true);
    expect(addon.commit).not.toHaveBeenCalled();
    // Answered by the wrapper, so a freed handle never goes back into native code.
    expect(addon.isClosed).not.toHaveBeenCalled();
  });

  it("destroys once however often it is called", async () => {
    const { addon, surface } = await open();

    surface.destroy();
    surface.destroy();
    surface.destroy();

    expect(addon.destroy).toHaveBeenCalledTimes(1);
  });

  it("never lets a throwing addon escape to the caller", async () => {
    const boom = (): never => {
      throw new Error("compositor died");
    };
    const { surface } = await open({
      commit: vi.fn(boom),
      isClosed: vi.fn(boom),
      destroy: vi.fn(boom),
    });

    expect(surface.commit(fullFrame())).toBe(false);
    expect(surface.isClosed()).toBe(true);
    expect(() => surface.destroy()).not.toThrow();
  });

  it("logs why the compositor connection dropped, once however many calls see it", async () => {
    let dropped = false;
    let reason: string | null = null;
    const { surface } = await open({
      // The first frame finds the display dead; later calls find no display at all.
      commit: vi.fn(() => {
        if (!dropped) reason = "protocol error 2 on zwlr_layer_surface_v1@12";
        dropped = true;
        return false;
      }),
      isClosed: vi.fn(() => dropped),
      takeDropReason: vi.fn(() => {
        const taken = reason;
        reason = null;
        return taken;
      }),
    });

    for (let i = 0; i < 5; i++) {
      expect(surface.commit(fullFrame())).toBe(false);
      expect(surface.isClosed()).toBe(true);
    }

    expect(connectionLostLines()).toEqual([
      "[LayerShell] compositor connection lost: protocol error 2 on zwlr_layer_surface_v1@12",
    ]);
  });
});

describe("pointer input", () => {
  afterEach(() => {
    vi.useRealTimers();
    setPlatform(realPlatform);
    injected.addon = null;
    vi.restoreAllMocks();
  });

  async function openTwo() {
    vi.useFakeTimers();
    let next = 0;
    const addon = useAddon({ create: vi.fn(() => next++) });
    const create = await freshCreate();
    const first = create(surfaceOptions());
    const second = create(surfaceOptions());
    if (!first || !second) throw new Error("expected two surfaces");
    return { addon, first, second };
  }

  it("routes an event to the surface the compositor named and no other", async () => {
    const { addon, first, second } = await openTwo();
    const toFirst = vi.fn();
    const toSecond = vi.fn();
    first.setInteractive(true, toFirst);
    second.setInteractive(true, toSecond);
    addon.pollEvents.mockReturnValueOnce([
      { handle: 1, type: 3, x: 7, y: 9, button: 2, pressed: true, dx: 0, dy: 0 },
    ]);

    vi.advanceTimersByTime(20);

    expect(toFirst).not.toHaveBeenCalled();
    expect(toSecond).toHaveBeenCalledWith({
      kind: "button",
      x: 7,
      y: 9,
      button: 2,
      pressed: true,
      deltaX: 0,
      deltaY: 0,
    });
  });

  it("stops routing to a surface that went click-through", async () => {
    const { addon, first } = await openTwo();
    const sink = vi.fn();
    first.setInteractive(true, sink);
    first.setInteractive(false);
    addon.pollEvents.mockReturnValue([
      { handle: 0, type: 2, x: 1, y: 1, button: 0, pressed: false, dx: 0, dy: 0 },
    ]);

    vi.advanceTimersByTime(40);

    expect(sink).not.toHaveBeenCalled();
  });

  it("stops polling once no surface wants input", async () => {
    const { addon, first, second } = await openTwo();
    first.setInteractive(true, vi.fn());
    second.setInteractive(true, vi.fn());
    vi.advanceTimersByTime(20);
    expect(addon.pollEvents).toHaveBeenCalled();

    addon.pollEvents.mockClear();
    first.destroy();
    second.setInteractive(false);
    vi.advanceTimersByTime(100);

    expect(addon.pollEvents).not.toHaveBeenCalled();
  });

  it("reports failure rather than routing when the addon refuses", async () => {
    vi.useFakeTimers();
    const addon = useAddon({ setInteractive: vi.fn(() => false) });
    const create = await freshCreate();
    const surface = create(surfaceOptions());
    const sink = vi.fn();

    expect(surface?.setInteractive(true, sink)).toBe(false);
    addon.pollEvents.mockReturnValue([
      { handle: 0, type: 2, x: 1, y: 1, button: 0, pressed: false, dx: 0, dy: 0 },
    ]);
    vi.advanceTimersByTime(40);

    expect(sink).not.toHaveBeenCalled();
  });

  it("survives an addon built before pointer input existed", async () => {
    const addon = useAddon();
    delete (addon as Partial<FakeAddon>).setInteractive;
    const create = await freshCreate();
    const surface = create(surfaceOptions());

    expect(surface?.setInteractive(true, vi.fn())).toBe(false);
  });
});

interface RawEvent {
  handle: number;
  type: number;
  x: number;
  y: number;
  button: number;
  pressed: boolean;
  dx: number;
  dy: number;
}

interface NativeSlot {
  handle: number;
  closed: boolean;
  frames: number;
  width: number;
  height: number;
}

/** addon.c's surface table: eight slots, all freed at once when the display
 *  drops, and handles that carry the slot's generation above its index. A
 *  crashed compositor goes unnoticed until an entry point that talks to the
 *  display reaches it, and a reconnect waits out INIT_RETRY_COOLDOWN_MS. */
function nativeTable() {
  const SLOTS = 8;
  const COOLDOWN_MS = 5000;
  const generations = new Array<number>(SLOTS).fill(0);
  const slots = new Array<NativeSlot | null>(SLOTS).fill(null);
  const issued: number[] = [];
  let queued: RawEvent[] = [];
  let connected = true;
  let socketDead = false;
  let compositorUp = true;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let connections = 1;
  let dropReason: string | null = null;
  const live = (handle: number): NativeSlot | null =>
    slots.find((slot) => slot?.handle === handle) ?? null;
  const clearTable = (): void => {
    slots.fill(null);
    queued = [];
  };
  /** flush_or_drop: true when this call found the display dead and dropped it. */
  const noticed = (): boolean => {
    if (!connected || !socketDead) return false;
    clearTable();
    connected = false;
    lastAttempt = Date.now();
    dropReason = "errno 32 (Broken pipe)";
    return true;
  };
  const event = (handle: number, type: number, pressed: boolean): RawEvent => ({
    handle,
    type,
    x: 2,
    y: 1,
    button: 0,
    pressed,
    dx: 0,
    dy: 0,
  });
  const addon = useAddon({
    available: vi.fn(() => {
      if (connected) return true;
      if (Date.now() - lastAttempt < COOLDOWN_MS) return false;
      lastAttempt = Date.now();
      if (!compositorUp) return false;
      connected = true;
      socketDead = false;
      connections++;
      return true;
    }),
    create: vi.fn((_output: string | null, width: number, height: number) => {
      if (!connected) return -1;
      const index = slots.indexOf(null);
      if (index < 0) return -1;
      generations[index] = (generations[index] ?? 0) + 1;
      const handle = (generations[index] ?? 0) * SLOTS + index;
      if (noticed()) return -1;
      slots[index] = { handle, closed: false, frames: 0, width, height };
      issued.push(handle);
      return handle;
    }),
    commit: vi.fn((handle: number) => {
      const slot = live(handle);
      if (!slot || slot.closed || noticed()) return false;
      slot.frames++;
      return true;
    }),
    destroy: vi.fn((handle: number) => {
      const index = slots.findIndex((slot) => slot?.handle === handle);
      if (index < 0) return;
      slots[index] = null;
      noticed();
    }),
    isClosed: vi.fn((handle: number) => {
      const slot = live(handle);
      return !slot || noticed() || slot.closed;
    }),
    scaleOf: vi.fn((handle: number) => (live(handle) ? 1 : 0)),
    sizeOf: vi.fn((handle: number) => {
      const slot = live(handle);
      return slot ? { width: slot.width, height: slot.height } : null;
    }),
    setInteractive: vi.fn((handle: number) => {
      const slot = live(handle);
      return slot !== null && !slot.closed && !noticed();
    }),
    pollEvents: vi.fn(() => (!connected || noticed() ? [] : queued.splice(0))),
    takeDropReason: vi.fn(() => {
      const reason = dropReason;
      dropReason = null;
      return reason;
    }),
  });
  return {
    addon,
    latest: (): number => issued[issued.length - 1] ?? -1,
    slotOf: (handle: number): number => handle % SLOTS,
    live,
    slotsInUse: (): number => slots.filter(Boolean).length,
    connections: (): number => connections,
    /** drop_connection: the compositor went away and took every surface along. */
    drop: clearTable,
    /** SIGKILL: the socket is dead, and nothing has read from it yet. */
    crash(): void {
      socketDead = connected;
      compositorUp = false;
    },
    restart(): void {
      compositorUp = true;
    },
    /** layer_surface.closed, as when the surface's output is unplugged. */
    close(handle: number): void {
      const slot = live(handle);
      if (slot) slot.closed = true;
    },
    press(handle: number): void {
      queued.push(event(handle, 3, true));
    },
    move(handle: number): void {
      queued.push(event(handle, 2, false));
    },
  };
}

type PaintListener = (event: unknown, dirty: unknown, image: { toBitmap: () => Buffer }) => void;

function offscreenWindow() {
  let paint: PaintListener | undefined;
  const window = {
    setSize: vi.fn(),
    webContents: {
      setFrameRate: vi.fn(),
      setZoomFactor: vi.fn(),
      sendInputEvent: vi.fn(),
      on: vi.fn((_event: "paint", listener: PaintListener) => {
        paint = listener;
      }),
    },
  };
  return { window, paint: (bitmap: Buffer) => paint?.(null, null, { toBitmap: () => bitmap }) };
}

// Two overlays kept by their owners across a compositor restart, through the
// real wrapper and the real presentation that retains it.
describe("a display reset under retained overlays", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function retainedOverlays() {
    vi.useFakeTimers();
    const table = nativeTable();
    vi.resetModules();
    const { createLayerSurface } = await import("../../services/layerShell");
    const { createLayerPresentation } = await import("../../ipc/overlay/layerPresentation");
    const overlay = (label: string) => {
      const { window, paint } = offscreenWindow();
      const presentation = createLayerPresentation({
        label,
        anchor: "top-left",
        createSurface: createLayerSurface,
        resolveOutput: async () => "DP-1",
      });
      presentation.attach(window, 4, 2);
      presentation.setInteractive(true);
      return { presentation, window, paint, handle: -1 };
    };
    return { table, overlays: [overlay("reward"), overlay("toast")] as const };
  }

  it("keeps an idle overlay's dead surface off the overlay that took its slot", async () => {
    const { table, overlays } = await retainedOverlays();
    for (const overlay of overlays) {
      expect(await overlay.presentation.show()).toBe(true);
      overlay.handle = table.latest();
    }

    for (let cycle = 0; cycle < 3; cycle++) {
      const [idle, first] = cycle % 2 === 0 ? overlays : [overlays[1], overlays[0]];
      // A press lands, then the compositor dies before its release can.
      table.press(idle.handle);
      vi.advanceTimersByTime(20);
      table.drop();

      expect(await first.presentation.show()).toBe(true);
      const firstHandle = table.latest();
      expect(table.slotOf(firstHandle)).toBe(table.slotOf(idle.handle));
      first.handle = firstHandle;

      // The idle owner only looks now, with its old slot already reused.
      expect(idle.presentation.isShowing()).toBe(false);
      idle.paint(Buffer.alloc(4 * 2 * 4));
      expect(table.live(firstHandle)).toEqual(
        expect.objectContaining({ closed: false, frames: 0 }),
      );

      const idleInputs = idle.window.webContents.sendInputEvent.mock.calls.length;
      table.move(firstHandle);
      vi.advanceTimersByTime(20);
      expect(first.window.webContents.sendInputEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "mouseMove", modifiers: [] }),
      );
      expect(idle.window.webContents.sendInputEvent).toHaveBeenCalledTimes(idleInputs);

      expect(await idle.presentation.show()).toBe(true);
      idle.handle = table.latest();
      table.move(idle.handle);
      vi.advanceTimersByTime(20);
      // The press died with the old surface; the new one never saw it.
      expect(idle.window.webContents.sendInputEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "mouseMove", modifiers: [] }),
      );
      first.paint(Buffer.alloc(4 * 2 * 4));
      expect(table.live(firstHandle)?.frames).toBe(1);
    }

    for (const overlay of overlays) overlay.presentation.hide();
    expect(table.slotsInUse()).toBe(0);
    table.addon.pollEvents.mockClear();
    vi.advanceTimersByTime(100);
    // No sink of any dead surface is left keeping the input drain alive.
    expect(table.addon.pollEvents).not.toHaveBeenCalled();
  });

  it("frees the slot of a surface the compositor closed under an idle overlay", async () => {
    const { table, overlays } = await retainedOverlays();
    const [overlay] = overlays;
    expect(await overlay.presentation.show()).toBe(true);

    for (let unplug = 0; unplug < 8; unplug++) {
      table.close(table.latest());
      expect(await overlay.presentation.show()).toBe(true);
      expect(table.slotsInUse()).toBe(1);
    }
  });

  type Overlays = Awaited<ReturnType<typeof retainedOverlays>>["overlays"];
  const crashRoutes: Array<[string, (overlays: Overlays) => unknown]> = [
    ["a frame", (overlays) => overlays[0].paint(Buffer.alloc(4 * 2 * 4))],
    ["the input drain", () => vi.advanceTimersByTime(20)],
    ["a show", (overlays) => overlays[1].presentation.show()],
  ];

  // Nothing polls toplevels here, as on niri, so the loss is noticed by whichever
  // surface call reaches the dead socket first.
  it.each(crashRoutes)(
    "rebuilds every overlay after a crash that %s noticed",
    async (_route, notice) => {
      const { table, overlays } = await retainedOverlays();
      for (const overlay of overlays) expect(await overlay.presentation.show()).toBe(true);

      for (let cycle = 0; cycle < 3; cycle++) {
        table.crash();
        await notice(overlays);

        expect(table.slotsInUse()).toBe(0);
        for (const overlay of overlays) expect(overlay.presentation.isShowing()).toBe(false);
        // Still down and inside the reconnect cooldown: no surface, not a dead one.
        expect(await overlays[0].presentation.show()).toBe(false);
        expect(connectionLostLines()).toEqual(
          new Array(cycle + 1).fill(
            "[LayerShell] compositor connection lost: errno 32 (Broken pipe)",
          ),
        );

        table.restart();
        vi.advanceTimersByTime(5000);
        const connections = table.connections();
        for (const overlay of overlays) {
          expect(await overlay.presentation.show()).toBe(true);
          overlay.handle = table.latest();
        }
        expect(table.connections()).toBe(connections + 1);
        overlays[0].paint(Buffer.alloc(4 * 2 * 4));
        expect(table.live(overlays[0].handle)?.frames).toBe(1);
      }
    },
  );
});

// Null and an empty array mean different things here: null is "the compositor
// cannot be asked", which sends the caller to the next focus source.
describe("layerToplevels", () => {
  it("is null with no addon at all", async () => {
    setPlatform("linux");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect((await freshToplevels())()).toBeNull();
  });

  // The addon answers this one without layer-shell, so a compositor that
  // refuses a surface can still report its windows.
  it("asks even when the compositor offers no layer-shell", async () => {
    const addon = useAddon({ available: vi.fn(() => false), toplevels: vi.fn(() => []) });

    expect((await freshToplevels())()).toEqual([]);
    expect(addon.toplevels).toHaveBeenCalled();
  });

  it("is null on an addon built before the export existed", async () => {
    useAddon();

    expect((await freshToplevels())()).toBeNull();
  });

  it("is null when the compositor has no foreign-toplevel manager", async () => {
    useAddon({ toplevels: vi.fn(() => null) });

    expect((await freshToplevels())()).toBeNull();
  });

  it("hands back the windows the addon reports", async () => {
    const windows = [
      {
        title: "Warframe",
        appId: "steam_app_230410",
        activated: true,
        fullscreen: true,
        outputs: ["DP-2"],
      },
    ];
    useAddon({ toplevels: vi.fn(() => windows) });

    expect((await freshToplevels())()).toEqual(windows);
  });

  // Without layer-shell no surface exists, so toplevels() is the only call left
  // to notice a dead compositor.
  it("logs a drop that the toplevel poll noticed", async () => {
    const reasons = ["errno 104 (Connection reset by peer)"];
    useAddon({
      available: vi.fn(() => false),
      toplevels: vi.fn(() => null),
      takeDropReason: vi.fn(() => reasons.shift() ?? null),
    });
    const toplevels = await freshToplevels();

    for (let i = 0; i < 3; i++) expect(toplevels()).toBeNull();

    expect(connectionLostLines()).toEqual([
      "[LayerShell] compositor connection lost: errno 104 (Connection reset by peer)",
    ]);
  });

  it("is null and warns once when the addon throws", async () => {
    useAddon({
      toplevels: vi.fn(() => {
        throw new Error("display gone");
      }),
    });
    const toplevels = await freshToplevels();

    expect(toplevels()).toBeNull();
    expect(toplevels()).toBeNull();
    expect(logged.warn).toHaveBeenCalledTimes(1);
  });
});
