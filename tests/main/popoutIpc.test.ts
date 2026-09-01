import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POPOUT_OPEN, POPOUT_SET_PINNED } from "../../config/shared/ipcChannels";
import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

interface StoredBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The stub class lives inside vi.hoisted so the electron mock factory can hand
// it out while statically imported modules evaluate (a top-level class would
// still be in its temporal dead zone at that point).
const h = vi.hoisted(() => {
  const state = {
    stored: null as unknown,
    writes: [] as unknown[],
    displayWorkArea: { x: 0, y: 0, width: 1920, height: 1040 },
    nextWebContentsId: 100,
  };

  class BrowserWindowStub {
    static instances: BrowserWindowStub[] = [];

    static fromWebContents(sender: { id: number }): BrowserWindowStub | null {
      return BrowserWindowStub.instances.find((win) => win.webContents.id === sender.id) ?? null;
    }

    options: Record<string, unknown>;
    webContents = {
      id: ++state.nextWebContentsId,
      once: (event: string, handler: () => void) => this.listen(`wc:${event}`, handler),
      on: () => undefined,
      setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
        this.windowOpenHandler = handler;
      },
    };
    windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
    loaded: { file: string; options?: { search?: string } } | null = null;
    bounds: StoredBounds = { x: 10, y: 20, width: 900, height: 700 };
    alwaysOnTop = false;
    shown = 0;
    focused = 0;
    destroyed = false;
    minimized = false;
    private handlers = new Map<string, (() => void)[]>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      BrowserWindowStub.instances.push(this);
    }

    private listen(event: string, handler: () => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    on(event: string, handler: () => void): void {
      this.listen(event, handler);
    }

    once(event: string, handler: () => void): void {
      this.listen(event, handler);
    }

    emit(event: string): void {
      for (const handler of this.handlers.get(event) ?? []) handler();
    }

    loadFile(file: string, options?: { search?: string }): Promise<void> {
      this.loaded = { file, options };
      return Promise.resolve();
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.minimized = false;
    }
    show(): void {
      this.shown += 1;
    }
    focus(): void {
      this.focused += 1;
    }
    setAlwaysOnTop(value: boolean): void {
      this.alwaysOnTop = value;
    }
    getNormalBounds(): StoredBounds {
      return this.bounds;
    }
  }

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  return Object.assign(state, { BrowserWindowStub, handlers });
});

const BrowserWindowStub = h.BrowserWindowStub;
type PopoutWindowStub = InstanceType<typeof h.BrowserWindowStub>;
const handlers = h.handlers;

vi.mock("electron", () => ({
  app: { getAppPath: () => "D:/app" },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
    ) => {
      h.handlers.set(channel, handler);
    },
    on: () => undefined,
  },
  BrowserWindow: h.BrowserWindowStub,
  screen: {
    getDisplayMatching: () => ({ workArea: h.displayWorkArea }),
  },
}));

vi.mock("../../services/jsonCache", () => ({
  createJsonCache: (_filename: string, revive: (parsed: unknown) => unknown) => ({
    read: () => (h.stored === null ? null : revive(h.stored)),
    write: (payload: unknown) => {
      h.writes.push(payload);
      h.stored = JSON.parse(JSON.stringify(payload));
    },
  }),
}));

import ctx from "../../ipc/context";
import * as ipcSecurity from "../../ipc/ipcSecurity";
import * as popoutIpc from "../../ipc/popoutIpc";

const ENTRY_FILE = path.join("D:/app", "renderer", "dist", "index.html");
const MAIN_URL = "file:///D:/app/renderer/dist/index.html";
const POPOUT_URL = "file:///D:/app/renderer/dist/index.html?popout=world";

function callHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} is not registered`);
  return handler(event, ...args);
}

async function openWorld(): Promise<PopoutWindowStub> {
  await callHandler(POPOUT_OPEN, makeEvent(1, MAIN_URL), "world");
  const win = BrowserWindowStub.instances.at(-1);
  if (!win) throw new Error("no window was created");
  return win;
}

describe("popoutIpc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.stored = null;
    h.writes = [];
    h.displayWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
    BrowserWindowStub.instances = [];
    handlers.clear();
    popoutIpc.__test__.resetForTest();
    ctx.mainWindow = makeWindowStub(1);
    popoutIpc.register();
  });

  afterEach(() => {
    vi.useRealTimers();
    ctx.mainWindow = null;
  });

  it("opens one window per view and focuses the existing one", async () => {
    const first = await openWorld();
    expect(first.loaded).toEqual({
      file: ENTRY_FILE,
      options: { search: "popout=world" },
    });

    await callHandler(POPOUT_OPEN, makeEvent(1, MAIN_URL), "world");

    expect(BrowserWindowStub.instances).toHaveLength(1);
    expect(first.focused).toBe(1);
  });

  it("rejects an unknown view without creating a window", async () => {
    await expect(callHandler(POPOUT_OPEN, makeEvent(1, MAIN_URL), "settings")).resolves.toEqual({
      ok: false,
    });
    expect(BrowserWindowStub.instances).toHaveLength(0);
  });

  it("restores saved bounds and the pinned flag on open", async () => {
    h.stored = { world: { x: 400, y: 200, width: 1000, height: 800, pinned: true } };

    const win = await openWorld();

    expect(win.options).toMatchObject({ x: 400, y: 200, width: 1000, height: 800 });
    expect(win.options.alwaysOnTop).toBe(true);
    expect(win.loaded?.options?.search).toBe("popout=world&pinned=1");
  });

  it("clamps a saved position that no longer fits the matched display", async () => {
    h.displayWorkArea = { x: 0, y: 0, width: 1280, height: 720 };
    h.stored = { world: { x: 4000, y: 2000, width: 1600, height: 1200, pinned: false } };

    const win = await openWorld();

    expect(win.options).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("saves bounds debounced on resize and immediately on close", async () => {
    const win = await openWorld();
    win.bounds = { x: 55, y: 66, width: 950, height: 720 };

    win.emit("resize");
    expect(h.writes).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(h.writes.at(-1)).toEqual({
      world: { width: 950, height: 720, pinned: false, x: 55, y: 66 },
    });

    win.bounds = { x: 70, y: 80, width: 900, height: 700 };
    win.emit("close");
    expect(h.writes.at(-1)).toEqual({
      world: { width: 900, height: 700, pinned: false, x: 70, y: 80 },
    });
  });

  it("pins only the calling popout window and persists the flag", async () => {
    const win = await openWorld();

    await expect(
      callHandler(POPOUT_SET_PINNED, { sender: { id: win.webContents.id } }, true),
    ).resolves.toEqual({ ok: true });
    expect(win.alwaysOnTop).toBe(true);
    expect(h.stored).toMatchObject({ world: { pinned: true } });

    // The main window is never a popout, so its own pin request is refused.
    await expect(callHandler(POPOUT_SET_PINNED, makeEvent(1, MAIN_URL), true)).rejects.toThrow(
      "Unauthorized IPC sender",
    );
  });

  it("lets a popout through the main renderer guard only while it is open", async () => {
    const win = await openWorld();
    const event = makeEvent(win.webContents.id, POPOUT_URL);

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-world-state")).not.toThrow();

    win.emit("closed");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-world-state")).toThrow();

    // The registry entry is gone, so the next open builds a fresh window.
    await openWorld();
    expect(BrowserWindowStub.instances).toHaveLength(2);
  });

  it("does not trust a popout sender loading some other file", async () => {
    const win = await openWorld();
    const event = makeEvent(win.webContents.id, "file:///D:/app/renderer/overlay.html");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-world-state")).toThrow();
  });

  it("blocks window.open from a popout", async () => {
    const win = await openWorld();

    expect(win.windowOpenHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" });
  });
});

describe("popout window state file", () => {
  it("drops unknown views and repairs bad numbers", () => {
    const state = popoutIpc.__test__.reviveState({
      world: { x: 1.6, y: "nope", width: 10, height: null, pinned: "yes" },
      market: { width: 900, height: 700 },
      arbitrations: 5,
    });

    expect(state).toEqual({ world: { x: 2, width: 720, height: 840, pinned: false } });
  });

  it("rejects a non-object payload", () => {
    expect(popoutIpc.__test__.reviveState("[]corrupt")).toBeNull();
  });
});
