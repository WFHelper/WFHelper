import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import type { PopoutWindowInfo } from "../../../config/shared/popoutTypes.js";

const STORAGE_KEY = "wf_workspaces_v1";

let stored: Map<string, string>;
let safeMode = false;
let openWindows: PopoutWindowInfo[] = [];
let calls: unknown[][] = [];

const invokeMock = vi.fn(async (channel: string, ...args: unknown[]) => {
  calls.push([channel, ...args]);
  if (channel === "popoutList") return openWindows;
  if (channel === "popoutCloseAll") return { ok: true, closed: openWindows.length };
  return { ok: true };
});

/** The store reads storage once at import, so every case needs a fresh module. */
async function loadStore(raw?: string) {
  stored = new Map();
  if (raw !== undefined) stored.set(STORAGE_KEY, raw);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.resetModules();
  vi.doMock("../../../src/lib/customCss/safeMode.js", () => ({
    isSafeMode: () => safeMode,
    SAFE_MODE_ONCE_KEY: "wf_safe_mode_once",
  }));
  vi.doMock("../../../src/lib/ipc.js", () => ({
    invoke: invokeMock,
    on: () => () => undefined,
  }));
  vi.doMock("../../../src/lib/log.js", () => ({
    log: { warn: () => undefined, error: () => undefined, info: () => undefined },
  }));
  return await import("../../../src/stores/workspaces.js");
}

function persisted(): { workspaces: { id: string; name: string }[]; restoreOnLaunch: unknown } {
  return JSON.parse(stored.get(STORAGE_KEY) ?? "null");
}

function workspaceFixture(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    name: `ws ${id}`,
    sidebar: { order: ["inventory", "settings"], hidden: ["world"], width: 240 },
    layout: { version: 1, views: {} },
    popouts: [],
    ...extra,
  };
}

beforeEach(() => {
  safeMode = false;
  openWindows = [];
  calls = [];
  invokeMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../../src/lib/customCss/safeMode.js");
  vi.doUnmock("../../../src/lib/ipc.js");
  vi.doUnmock("../../../src/lib/log.js");
});

describe("workspace file validation", () => {
  it("starts empty on unreadable JSON", async () => {
    const store = await loadStore("{not json");

    expect(get(store.workspaces)).toEqual({ version: 1, workspaces: [], restoreOnLaunch: null });
  });

  it("ignores a file from another schema version", async () => {
    const store = await loadStore(
      JSON.stringify({ version: 2, workspaces: [workspaceFixture("a")], restoreOnLaunch: "a" }),
    );

    expect(get(store.workspaces).workspaces).toEqual([]);
  });

  it("caps the list at twenty and drops duplicate ids", async () => {
    const list = Array.from({ length: 25 }, (_, i) => workspaceFixture(`w${i}`));
    list.push(workspaceFixture("w0"));
    const store = await loadStore(JSON.stringify({ version: 1, workspaces: list }));

    const ids = get(store.workspaces).workspaces.map((workspace) => workspace.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("drops a popout target this build does not know", async () => {
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [
          workspaceFixture("a", {
            popouts: [
              { target: { kind: "view", view: "settings" }, pinned: false },
              { target: { kind: "section", sectionId: "no spaces allowed" }, pinned: false },
              {
                target: { kind: "section", sectionId: "world.fissures" },
                pinned: true,
                bounds: { x: 1, y: 2, width: 300, height: 200 },
              },
              { target: { kind: "section", sectionId: "world.fissures" }, pinned: false },
            ],
          }),
        ],
      }),
    );

    expect(get(store.workspaces).workspaces[0].popouts).toEqual([
      {
        target: { kind: "section", sectionId: "world.fissures" },
        pinned: true,
        bounds: { x: 1, y: 2, width: 300, height: 200 },
      },
    ]);
  });

  it("forgets a restore target that is not in the list", async () => {
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [workspaceFixture("a")],
        restoreOnLaunch: "gone",
      }),
    );

    expect(get(store.workspaces).restoreOnLaunch).toBeNull();
  });

  it("rejects a bounds object with a non-finite number", async () => {
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [
          workspaceFixture("a", {
            popouts: [
              {
                target: { kind: "view", view: "world" },
                pinned: false,
                bounds: { x: 0, y: 0, width: "wide", height: 200 },
              },
            ],
          }),
        ],
      }),
    );

    expect(get(store.workspaces).workspaces[0].popouts[0].bounds).toBeUndefined();
  });
});

describe("workspace actions", () => {
  it("captures the open windows when saving", async () => {
    openWindows = [
      {
        target: { kind: "section", sectionId: "world.fissures" },
        pinned: true,
        bounds: { x: 10, y: 20, width: 640, height: 480 },
      },
    ];
    const store = await loadStore();

    const id = await store.saveWorkspace("  Trading  ");

    expect(id).toBeTruthy();
    const saved = get(store.workspaces).workspaces[0];
    expect(saved.name).toBe("Trading");
    expect(saved.popouts).toEqual([
      {
        target: { kind: "section", sectionId: "world.fissures" },
        pinned: true,
        bounds: { x: 10, y: 20, width: 640, height: 480 },
      },
    ]);
    expect(persisted().workspaces).toHaveLength(1);
  });

  it("refuses a blank name", async () => {
    const store = await loadStore();

    expect(await store.saveWorkspace("   ")).toBeNull();
    expect(get(store.workspaces).workspaces).toHaveLength(0);
  });

  it("drops the oldest entry once the cap is reached", async () => {
    const list = Array.from({ length: 20 }, (_, i) => workspaceFixture(`w${i}`));
    const store = await loadStore(JSON.stringify({ version: 1, workspaces: list }));

    await store.saveWorkspace("newest");

    const names = get(store.workspaces).workspaces.map((workspace) => workspace.name);
    expect(names).toHaveLength(20);
    expect(names[0]).toBe("ws w1");
    expect(names[names.length - 1]).toBe("newest");
  });

  it("renames, deletes and clears the launch target with the workspace", async () => {
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [workspaceFixture("a"), workspaceFixture("b")],
        restoreOnLaunch: "b",
      }),
    );

    store.renameWorkspace("a", "Renamed");
    expect(get(store.workspaces).workspaces[0].name).toBe("Renamed");

    store.deleteWorkspace("b");
    expect(get(store.workspaces).workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(get(store.workspaces).restoreOnLaunch).toBeNull();
  });

  it("closes the windows a workspace does not want and opens the ones it does", async () => {
    openWindows = [
      {
        target: { kind: "view", view: "world" },
        pinned: false,
        bounds: { x: 0, y: 0, width: 900, height: 700 },
      },
    ];
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [
          workspaceFixture("a", {
            popouts: [
              {
                target: { kind: "section", sectionId: "world.fissures" },
                pinned: true,
                bounds: { x: 5, y: 6, width: 700, height: 500 },
              },
            ],
          }),
        ],
      }),
    );

    await store.applyWorkspace("a");

    expect(calls).toContainEqual(["popoutClose", { kind: "view", view: "world" }]);
    expect(calls).toContainEqual([
      "popoutOpen",
      { kind: "section", sectionId: "world.fissures" },
      { pinned: true, bounds: { x: 5, y: 6, width: 700, height: 500 } },
    ]);
  });

  it("re-applies bounds and pin to a target that is already open", async () => {
    openWindows = [
      {
        target: { kind: "view", view: "world" },
        pinned: false,
        bounds: { x: 0, y: 0, width: 900, height: 700 },
      },
    ];
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [
          workspaceFixture("a", {
            popouts: [
              {
                target: { kind: "view", view: "world" },
                pinned: true,
                bounds: { x: 40, y: 50, width: 1000, height: 800 },
              },
            ],
          }),
        ],
      }),
    );

    await store.applyWorkspace("a");

    expect(calls).toContainEqual([
      "popoutOpen",
      { kind: "view", view: "world" },
      { pinned: true, bounds: { x: 40, y: 50, width: 1000, height: 800 } },
    ]);
    expect(calls).not.toContainEqual(["popoutClose", { kind: "view", view: "world" }]);
  });

  it("reports an unknown workspace instead of applying anything", async () => {
    const store = await loadStore();

    expect(await store.applyWorkspace("missing")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("restore on launch", () => {
  it("applies the stored workspace once", async () => {
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [workspaceFixture("a")],
        restoreOnLaunch: "a",
      }),
    );

    await store.restoreWorkspaceOnLaunch();
    const afterFirst = calls.length;
    await store.restoreWorkspaceOnLaunch();

    expect(afterFirst).toBeGreaterThan(0);
    expect(calls).toHaveLength(afterFirst);
  });

  it("does nothing in safe mode", async () => {
    safeMode = true;
    const store = await loadStore(
      JSON.stringify({
        version: 1,
        workspaces: [workspaceFixture("a")],
        restoreOnLaunch: "a",
      }),
    );

    await store.restoreWorkspaceOnLaunch();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing when no workspace is marked", async () => {
    const store = await loadStore(
      JSON.stringify({ version: 1, workspaces: [workspaceFixture("a")], restoreOnLaunch: null }),
    );

    await store.restoreWorkspaceOnLaunch();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
