import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { LAYOUT_STORAGE_KEY } from "../../../src/lib/layout/types.js";
import type { registerSections } from "../../../src/lib/layout/registry.js";

let stored: Map<string, string>;
let writes = 0;
let safeMode = false;

function register(registerInto: typeof registerSections): void {
  registerInto("world", [
    { id: "world.cycles", view: "world", labelKey: "world.planetCycles", defaultSpan: 1 },
    { id: "world.timers", view: "world", labelKey: "world.resetTimers", defaultSpan: 1 },
    {
      id: "world.fissures",
      view: "world",
      labelKey: "world.voidFissures",
      defaultSpan: 1,
      canCollapse: true,
    },
    {
      id: "world.bounties",
      view: "world",
      labelKey: "world.bounties",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
  ]);
}

/** The store reads storage once at import, so every case needs a fresh module. */
async function loadStore(raw?: string) {
  stored = new Map();
  writes = 0;
  if (raw !== undefined) stored.set(LAYOUT_STORAGE_KEY, raw);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === LAYOUT_STORAGE_KEY) writes += 1;
      stored.set(key, value);
    },
  });
  vi.resetModules();
  vi.doMock("../../../src/lib/customCss/safeMode.js", () => ({
    isSafeMode: () => safeMode,
    SAFE_MODE_ONCE_KEY: "wf_safe_mode_once",
  }));
  // resetModules gives the store a fresh registry, so registration has to go
  // through that same instance rather than the one this file imported.
  const registry = await import("../../../src/lib/layout/registry.js");
  register(registry.registerSections);
  return await import("../../../src/stores/layout.js");
}

function persisted(): unknown {
  const raw = stored.get(LAYOUT_STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

beforeEach(() => {
  safeMode = false;
  stored = new Map();
  writes = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../../src/lib/customCss/safeMode.js");
});

describe("reading a stored layout", () => {
  it("starts from registry defaults with nothing stored", async () => {
    const mod = await loadStore();
    expect(get(mod.layoutFor("world", "wide")).map((section) => section.id)).toEqual([
      "world.cycles",
      "world.timers",
      "world.fissures",
      "world.bounties",
    ]);
  });

  it("merges a layout written by a build with different ids", async () => {
    const mod = await loadStore(
      JSON.stringify({
        version: 1,
        views: {
          world: {
            wide: {
              sections: [
                { id: "world.retired", span: 1 },
                { id: "world.fissures", span: 2, hidden: true },
                { id: "world.cycles", span: 1 },
              ],
            },
          },
        },
      }),
    );
    const sections = get(mod.layoutFor("world", "wide"));
    // A new id follows the section it sits behind by default, so bounties lands
    // after fissures even though the user moved fissures to the top.
    expect(sections.map((section) => section.id)).toEqual([
      "world.fissures",
      "world.bounties",
      "world.cycles",
      "world.timers",
    ]);
    expect(sections[0]?.hidden).toBe(true);
  });

  it("falls back to defaults on corrupt JSON and keeps the bad value on disk", async () => {
    const mod = await loadStore("{not json");
    expect(get(mod.layoutFor("world", "wide"))).toHaveLength(4);
    expect(stored.get(LAYOUT_STORAGE_KEY)).toBe("{not json");
  });

  it("keeps the two breakpoints independent", async () => {
    const mod = await loadStore();
    mod.setHidden("world", "narrow", "world.timers", true);
    expect(get(mod.layoutFor("world", "narrow")).find((s) => s.id === "world.timers")?.hidden).toBe(
      true,
    );
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.timers")?.hidden).toBe(
      false,
    );
  });
});

describe("edits", () => {
  it("moves, spans, hides and collapses, and persists each change", async () => {
    const mod = await loadStore();
    mod.moveSection("world", "wide", "world.fissures", "up");
    expect(get(mod.layoutFor("world", "wide")).map((s) => s.id)).toEqual([
      "world.cycles",
      "world.fissures",
      "world.timers",
      "world.bounties",
    ]);

    mod.setSpan("world", "wide", "world.cycles", 2);
    mod.setHidden("world", "wide", "world.timers", true);
    mod.setCollapsed("world", "wide", "world.fissures", true);

    const sections = get(mod.layoutFor("world", "wide"));
    expect(sections.find((s) => s.id === "world.cycles")?.span).toBe(2);
    expect(sections.find((s) => s.id === "world.timers")?.hidden).toBe(true);
    expect(sections.find((s) => s.id === "world.fissures")?.collapsed).toBe(true);
    expect(persisted()).not.toBeUndefined();
  });

  it("never hides a protected section", async () => {
    const mod = await loadStore();
    mod.setHidden("world", "wide", "world.bounties", true);
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.bounties")?.hidden).toBe(
      false,
    );
  });
});

describe("undo", () => {
  it("restores the state before the last change", async () => {
    const mod = await loadStore();
    expect(get(mod.canUndo)).toBe(false);

    mod.setHidden("world", "wide", "world.timers", true);
    expect(get(mod.canUndo)).toBe(true);
    mod.moveSection("world", "wide", "world.fissures", "up");

    mod.undo();
    expect(get(mod.layoutFor("world", "wide")).map((s) => s.id)).toEqual([
      "world.cycles",
      "world.timers",
      "world.fissures",
      "world.bounties",
    ]);
    mod.undo();
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.timers")?.hidden).toBe(
      false,
    );
    expect(get(mod.canUndo)).toBe(false);
  });

  it("does nothing on an empty stack", async () => {
    const mod = await loadStore();
    mod.undo();
    expect(get(mod.layoutFor("world", "wide"))).toHaveLength(4);
  });

  it("writes the restored state back to storage", async () => {
    const mod = await loadStore();
    mod.setHidden("world", "wide", "world.timers", true);
    mod.undo();
    const state = persisted() as { views: { world?: { wide?: { sections: unknown[] } } } };
    expect(state.views.world).toBeUndefined();
  });
});

describe("undo groups", () => {
  const ids = (mod: Awaited<ReturnType<typeof loadStore>>): string[] =>
    get(mod.layoutFor("world", "wide")).map((s) => s.id);

  it("writes once for a whole drag and undoes it in one step", async () => {
    const mod = await loadStore();
    const before = ids(mod);
    mod.beginUndoGroup("world", "wide", "world.fissures");
    mod.moveSection("world", "wide", "world.fissures", "up");
    mod.moveSection("world", "wide", "world.fissures", "up");
    expect(ids(mod)[0]).toBe("world.fissures");
    expect(writes).toBe(0);

    mod.endUndoGroup();
    expect(writes).toBe(1);
    expect(persisted()).not.toBeUndefined();
    mod.undo();
    expect(ids(mod)).toEqual(before);
    expect(get(mod.canUndo)).toBe(false);
  });

  it("writes nothing for a drag that moved nothing", async () => {
    const mod = await loadStore();
    mod.beginUndoGroup("world", "wide", "world.fissures");
    mod.endUndoGroup();
    expect(writes).toBe(0);
    expect(get(mod.canUndo)).toBe(false);
  });

  it("writes nothing for a drag that ends where it started", async () => {
    const mod = await loadStore();
    const before = ids(mod);
    mod.beginUndoGroup("world", "wide", "world.fissures");
    mod.moveSection("world", "wide", "world.fissures", "up");
    mod.moveSection("world", "wide", "world.fissures", "down");
    mod.endUndoGroup();
    expect(ids(mod)).toEqual(before);
    expect(writes).toBe(0);
    expect(get(mod.canUndo)).toBe(false);
  });

  it("groups the moves a pointer drag makes under the drag's own key", async () => {
    const mod = await loadStore();
    const drag = await import("../../../src/lib/layout/drag.js");
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("document", { body: { style: {} } });

    drag.beginSectionDrag({
      view: "world",
      breakpoint: "wide",
      id: "world.fissures",
      pointerId: 1,
      scope: null,
      from: null,
    });
    // A key the drag and moveSection spell differently would flush the group on
    // the first move and write once per crossed section.
    mod.moveSection("world", "wide", "world.fissures", "up");
    mod.moveSection("world", "wide", "world.fissures", "up");
    expect(writes).toBe(0);

    mod.endUndoGroup();
    expect(writes).toBe(1);
    expect(ids(mod)[0]).toBe("world.fissures");
  });

  it("keeps a change from outside the drag on its own undo entry", async () => {
    const mod = await loadStore();
    mod.beginUndoGroup("world", "wide", "world.fissures");
    mod.moveSection("world", "wide", "world.fissures", "up");
    mod.setHidden("world", "wide", "world.timers", true);
    // The drag flushes first, then the hide records; two writes, two entries.
    expect(writes).toBe(2);

    mod.undo();
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.timers")?.hidden).toBe(
      false,
    );
    expect(ids(mod)[1]).toBe("world.fissures");
    mod.undo();
    expect(ids(mod)[1]).toBe("world.timers");
    expect(get(mod.canUndo)).toBe(false);
  });
});

describe("reset", () => {
  it("drops one view and leaves the rest", async () => {
    const mod = await loadStore();
    mod.setHidden("world", "wide", "world.timers", true);
    mod.applyPreset("runAnalyst", ["arbi"]);

    mod.resetView("world");
    const state = persisted() as { views: Record<string, unknown> };
    expect(state.views.world).toBeUndefined();
    expect(state.views.arbi).not.toBeUndefined();
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.timers")?.hidden).toBe(
      false,
    );
  });

  it("resetAll clears every view", async () => {
    const mod = await loadStore();
    mod.setHidden("world", "wide", "world.timers", true);
    mod.resetAll();
    expect(persisted()).toEqual({ version: 1, views: {} });
  });
});

describe("presets", () => {
  it("applies to both breakpoints and merges against the registry", async () => {
    const mod = await loadStore();
    mod.applyPreset("relicFarmer");
    const wide = get(mod.layoutFor("world", "wide"));
    const narrow = get(mod.layoutFor("world", "narrow"));
    expect(wide.map((s) => s.id)).toEqual(narrow.map((s) => s.id));
    // The preset lists ids this test registry does not carry; they are dropped,
    // and the registered ones it never mentions are appended.
    expect(wide.map((s) => s.id).sort()).toEqual([
      "world.bounties",
      "world.cycles",
      "world.fissures",
      "world.timers",
    ]);
    expect(wide[0]?.id).toBe("world.fissures");
    expect(wide.find((s) => s.id === "world.timers")?.hidden).toBe(true);
  });

  it("limits the change to the named views", async () => {
    const mod = await loadStore();
    mod.applyPreset("relicFarmer", ["inventory"]);
    const state = persisted() as { views: Record<string, unknown> };
    expect(state.views.inventory).not.toBeUndefined();
    expect(state.views.world).toBeUndefined();
  });

  it("ignores an unknown preset id", async () => {
    const mod = await loadStore();
    mod.applyPreset("no-such-preset");
    expect(persisted()).toBeUndefined();
  });

  it("stores an unopened view's ids verbatim until that view registers", async () => {
    const mod = await loadStore();
    mod.applyPreset("runAnalyst", ["arbi"]);
    const state = persisted() as {
      views: { arbi?: { wide?: { sections: { id: string }[] } } };
    };
    expect(state.views.arbi?.wide?.sections.map((section) => section.id)).toEqual([
      "arbi.filters",
      "arbi.runs",
    ]);
  });
});

describe("safe mode", () => {
  it("renders defaults and leaves the stored layout untouched", async () => {
    safeMode = true;
    const raw = JSON.stringify({
      version: 1,
      views: { world: { wide: { sections: [{ id: "world.timers", span: 1, hidden: true }] } } },
    });
    const mod = await loadStore(raw);

    expect(get(mod.layoutFor("world", "wide")).map((s) => s.id)).toEqual([
      "world.cycles",
      "world.timers",
      "world.fissures",
      "world.bounties",
    ]);
    expect(stored.get(LAYOUT_STORAGE_KEY)).toBe(raw);

    // An edit made during a safe-mode session stays in memory only.
    mod.setHidden("world", "wide", "world.cycles", true);
    expect(get(mod.layoutFor("world", "wide")).find((s) => s.id === "world.cycles")?.hidden).toBe(
      true,
    );
    expect(stored.get(LAYOUT_STORAGE_KEY)).toBe(raw);
  });
});
