import { describe, expect, it } from "vitest";

import {
  columnOf,
  mergeViewLayout,
  moveSectionInList,
  nextSpan,
  normalizeLayoutState,
  placeSectionColumns,
  planSections,
} from "../../../../src/lib/layout/plan.js";
import type {
  LayoutColumn,
  SectionDescriptor,
  SectionState,
} from "../../../../src/lib/layout/types.js";
import { VIEW_NAMES } from "../../../../src/types/views.js";

const DESCRIPTORS: SectionDescriptor[] = [
  { id: "world.cycles", view: "world", labelKey: "world.planetCycles", defaultSpan: 1 },
  { id: "world.timers", view: "world", labelKey: "world.resetTimers", defaultSpan: 1 },
  {
    id: "world.circuit",
    view: "world",
    labelKey: "world.theCircuit",
    defaultSpan: 1,
    minSpan: 2,
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
];

// Mirrors the World registry around the vendor section, which was added after
// users already had a stored World layout.
const WORLD_VENDOR_DESCRIPTORS: SectionDescriptor[] = [
  { id: "world.invasions", view: "world", labelKey: "world.invasions", defaultSpan: 1 },
  { id: "world.darvo", view: "world", labelKey: "world.darvosDeal", defaultSpan: 1 },
  { id: "world.vendors", view: "world", labelKey: "world.vendorRotations", defaultSpan: 1 },
  { id: "world.baro", view: "world", labelKey: "world.baroKiteer", defaultSpan: "full" },
];

const state = (id: string, patch: Partial<SectionState> = {}): SectionState => ({
  id,
  span: 1,
  hidden: false,
  collapsed: false,
  ...patch,
});

const placed = (
  id: string,
  column: LayoutColumn,
  patch: Partial<SectionState> = {},
): SectionState => state(id, { column, ...patch });

const columns = (sections: readonly SectionState[]): Record<string, LayoutColumn> =>
  Object.fromEntries(sections.map((section) => [section.id, columnOf(section)]));

const ids = (sections: readonly SectionState[]): string[] => sections.map((section) => section.id);

describe("mergeViewLayout", () => {
  it("returns registry defaults when nothing is stored", () => {
    const merged = mergeViewLayout(null, DESCRIPTORS);
    expect(merged.sections.map((section) => section.id)).toEqual([
      "world.cycles",
      "world.timers",
      "world.circuit",
      "world.bounties",
    ]);
    // defaultSpan is clamped up to minSpan, not taken literally.
    expect(merged.sections[2]?.span).toBe(2);
    expect(merged.sections[3]?.span).toBe("full");
  });

  it("drops ids this build no longer knows", () => {
    const merged = mergeViewLayout(
      { version: 1, sections: [state("world.gone"), state("world.timers")] },
      DESCRIPTORS,
    );
    expect(merged.sections.map((section) => section.id)).not.toContain("world.gone");
    expect(merged.sections).toHaveLength(4);
  });

  it("reinserts a missing id at its default position", () => {
    const merged = mergeViewLayout(
      {
        version: 1,
        sections: [state("world.cycles"), state("world.circuit"), state("world.bounties")],
      },
      DESCRIPTORS,
    );
    expect(merged.sections.map((section) => section.id)).toEqual([
      "world.cycles",
      "world.timers",
      "world.circuit",
      "world.bounties",
    ]);
  });

  it("adds a late section hidden to a saved layout but visible to a fresh one", () => {
    const late = DESCRIPTORS.map((d) =>
      d.id === "world.timers" ? { ...d, hiddenInSavedLayouts: true } : d,
    );
    const saved = mergeViewLayout(
      { version: 1, sections: [state("world.cycles"), state("world.circuit")] },
      late,
    );
    expect(saved.sections.find((s) => s.id === "world.timers")?.hidden).toBe(true);
    const fresh = mergeViewLayout(null, late);
    expect(fresh.sections.find((s) => s.id === "world.timers")?.hidden).toBe(false);
  });

  it("reinserts a missing first id at the front", () => {
    const merged = mergeViewLayout(
      { version: 1, sections: [state("world.bounties"), state("world.timers")] },
      DESCRIPTORS,
    );
    expect(merged.sections.map((section) => section.id)).toEqual([
      "world.cycles",
      "world.bounties",
      "world.timers",
      "world.circuit",
    ]);
  });

  it("clamps a stored span below minSpan and ignores a bad one", () => {
    const merged = mergeViewLayout(
      {
        version: 1,
        sections: [
          state("world.circuit", { span: 1 }),
          state("world.cycles", { span: "wide" as unknown as 1 }),
        ],
      },
      DESCRIPTORS,
    );
    expect(merged.sections.find((s) => s.id === "world.circuit")?.span).toBe(2);
    expect(merged.sections.find((s) => s.id === "world.cycles")?.span).toBe(1);
  });

  it("refuses to hide a protected section and to collapse a non-collapsible one", () => {
    const merged = mergeViewLayout(
      {
        version: 1,
        sections: [
          state("world.bounties", { hidden: true, span: "full" }),
          state("world.cycles", { collapsed: true }),
          state("world.circuit", { collapsed: true, span: 2 }),
        ],
      },
      DESCRIPTORS,
    );
    expect(merged.sections.find((s) => s.id === "world.bounties")?.hidden).toBe(false);
    expect(merged.sections.find((s) => s.id === "world.cycles")?.collapsed).toBe(false);
    expect(merged.sections.find((s) => s.id === "world.circuit")?.collapsed).toBe(true);
  });

  it("drops a duplicated id", () => {
    const merged = mergeViewLayout(
      { version: 1, sections: [state("world.timers"), state("world.timers")] },
      DESCRIPTORS,
    );
    expect(merged.sections.filter((s) => s.id === "world.timers")).toHaveLength(1);
  });

  it("lands the vendor section after Darvo for a layout that predates it", () => {
    const merged = mergeViewLayout(
      {
        version: 1,
        sections: [
          state("world.baro", { span: "full" }),
          state("world.darvo"),
          state("world.invasions"),
        ],
      },
      WORLD_VENDOR_DESCRIPTORS,
    );
    expect(merged.sections.map((section) => section.id)).toEqual([
      "world.baro",
      "world.darvo",
      "world.vendors",
      "world.invasions",
    ]);
  });

  it("passes the stored order through when the view has not registered yet", () => {
    const merged = mergeViewLayout({ version: 1, sections: [state("world.timers")] }, []);
    expect(merged.sections.map((section) => section.id)).toEqual(["world.timers"]);
  });
});

describe("normalizeLayoutState", () => {
  it("rejects a foreign version and non-objects", () => {
    expect(normalizeLayoutState({ version: 2, views: { world: {} } }).views).toEqual({});
    expect(normalizeLayoutState("nope").views).toEqual({});
    expect(normalizeLayoutState(null).views).toEqual({});
  });

  it("keeps only well-formed section rows", () => {
    const normalized = normalizeLayoutState({
      version: 1,
      views: {
        world: {
          wide: {
            sections: [
              { id: "world.cycles", span: 2, hidden: true, collapsed: false },
              { id: 42 },
              null,
              { id: "world.timers", span: "huge" },
            ],
          },
          narrow: "not-a-layout",
        },
        broken: null,
      },
    });
    expect(normalized.views.world?.wide?.sections).toEqual([
      { id: "world.cycles", span: 2, hidden: true, collapsed: false },
      { id: "world.timers", span: 1, hidden: false, collapsed: false },
    ]);
    expect(normalized.views.world?.narrow).toBeUndefined();
    expect(Object.keys(normalized.views)).toEqual(["world"]);
  });

  it("keeps a stored column and drops one that is not a column", () => {
    const normalized = normalizeLayoutState({
      version: 1,
      views: {
        world: {
          wide: {
            sections: [
              { id: "world.cycles", span: 1, column: 1 },
              { id: "world.timers", span: 1, column: 7 },
              { id: "world.fissures", span: 1, column: 0 },
            ],
          },
        },
      },
    });
    expect((normalized.views.world?.wide?.sections ?? []).map((section) => section.column)).toEqual(
      [1, undefined, 0],
    );
  });

  it("drops a view key that is not arrangeable", () => {
    const sections = [{ id: "world.cycles", span: 1, hidden: false, collapsed: false }];
    const normalized = normalizeLayoutState({
      version: 1,
      views: {
        settings: { wide: { sections } },
        "not-a-view": { wide: { sections } },
        constructor: { wide: { sections } },
        world: { wide: { sections } },
      },
    });
    expect(Object.keys(normalized.views)).toEqual(["world"]);
  });

  it("keeps every arrangeable view id the app knows", () => {
    const sections = [{ id: "any.section", span: 1, hidden: false, collapsed: false }];
    const views: Record<string, unknown> = {};
    for (const view of VIEW_NAMES) views[view] = { wide: { sections } };
    expect(Object.keys(normalizeLayoutState({ version: 1, views }).views)).toEqual(
      VIEW_NAMES.filter((view) => view !== "setup" && view !== "settings"),
    );
  });
});

describe("moveSectionInList", () => {
  const list = [state("a"), state("b"), state("c")];

  it("steps up and down", () => {
    expect(moveSectionInList(list, "c", "up").map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(moveSectionInList(list, "a", "down").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("clamps at both ends and ignores an unknown id", () => {
    expect(moveSectionInList(list, "a", "up").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(moveSectionInList(list, "c", "down").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(moveSectionInList(list, "zz", 0).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("takes an absolute index and clamps it", () => {
    expect(moveSectionInList(list, "a", 2).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(moveSectionInList(list, "a", 99).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("takes the slot a named section holds", () => {
    expect(moveSectionInList(list, "a", { toId: "c" }).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(moveSectionInList(list, "c", { toId: "a" }).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("leaves the list alone for an id it does not hold", () => {
    expect(moveSectionInList(list, "a", { toId: "zz" }).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(moveSectionInList(list, "a", { toId: "a" }).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("drops onto a full-width section and onto a collapsed one", () => {
    const mixed = [state("a"), state("wide", { span: "full" }), state("c", { collapsed: true })];
    expect(moveSectionInList(mixed, "a", { toId: "wide" }).map((s) => s.id)).toEqual([
      "wide",
      "a",
      "c",
    ]);
    expect(moveSectionInList(mixed, "a", { toId: "c" }).map((s) => s.id)).toEqual([
      "wide",
      "c",
      "a",
    ]);
  });

  it("takes the column of the section it landed on", () => {
    const four = [placed("a", 0), placed("b", 0), placed("c", 1), placed("d", 1)];
    const moved = moveSectionInList(four, "a", { toId: "d" });
    expect(ids(moved)).toEqual(["b", "c", "d", "a"]);
    expect(columns(moved)).toEqual({ a: 1, b: 0, c: 1, d: 1 });
  });

  it("keeps its own column when it lands on a full-width section", () => {
    const list = [placed("a", 1), placed("b", 0), state("wide", { span: "full", column: 0 })];
    const moved = moveSectionInList(list, "a", { toId: "wide" });
    expect(ids(moved)).toEqual(["b", "wide", "a"]);
    expect(columnOf(moved[2] as SectionState)).toBe(1);
  });
});

describe("moveSectionInList across columns", () => {
  const four = [placed("a", 0), placed("b", 0), placed("c", 1), placed("d", 1)];

  it("moves only the dragged section when the drop crosses the boundary", () => {
    const moved = moveSectionInList(four, "d", { index: 1, column: 0 });
    expect(ids(moved)).toEqual(["a", "d", "b", "c"]);
    expect(columns(moved)).toEqual({ a: 0, b: 0, c: 1, d: 0 });
    expect(columns(four)).toEqual({ a: 0, b: 0, c: 1, d: 1 });
  });

  it("lands at the bottom of the column it was dropped into", () => {
    const moved = moveSectionInList(four, "a", { index: 3, column: 1 });
    const rows = planSections(moved, "wide");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["b"]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["c", "d", "a"]);
  });

  it("changes the column without changing the order", () => {
    const moved = moveSectionInList(four, "b", { index: 1, column: 1 });
    expect(ids(moved)).toEqual(["a", "b", "c", "d"]);
    const rows = planSections(moved, "wide");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["a"]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["b", "c", "d"]);
  });

  it("swaps both slots for an arrow step across the boundary", () => {
    const moved = moveSectionInList(four, "b", "down");
    expect(ids(moved)).toEqual(["a", "c", "b", "d"]);
    expect(columns(moved)).toEqual({ a: 0, b: 1, c: 0, d: 1 });
    expect(columns(moveSectionInList(moved, "b", "up"))).toEqual(columns(four));
    expect(ids(moveSectionInList(moved, "b", "up"))).toEqual(ids(four));
  });

  it("leaves the columns alone for an arrow step inside one column", () => {
    const moved = moveSectionInList(four, "c", "down");
    expect(ids(moved)).toEqual(["a", "b", "d", "c"]);
    expect(columns(moved)).toEqual({ a: 0, b: 0, c: 1, d: 1 });
  });
});

describe("nextSpan", () => {
  it("cycles 1 -> 2 -> full -> 1", () => {
    expect(nextSpan(1)).toBe(2);
    expect(nextSpan(2)).toBe("full");
    expect(nextSpan("full")).toBe(1);
  });

  it("never goes below minSpan", () => {
    expect(nextSpan(2, 2)).toBe("full");
    expect(nextSpan("full", 2)).toBe(2);
    expect(nextSpan("full", "full")).toBe("full");
  });
});

describe("placeSectionColumns", () => {
  it("cuts a run nobody placed in half, the way the old build rendered it", () => {
    const run = [state("a"), state("b"), state("c"), state("d"), state("e")];
    expect(columns(placeSectionColumns(run))).toEqual({ a: 0, b: 0, c: 0, d: 1, e: 1 });
  });

  it("cuts each run between full-width sections on its own", () => {
    const rows = placeSectionColumns([
      state("a"),
      state("b"),
      state("wide", { span: "full" }),
      state("c"),
      state("d"),
    ]);
    expect(columns(rows)).toEqual({ a: 0, b: 1, wide: 0, c: 0, d: 1 });
  });

  it("counts only the sections the old cut would have counted", () => {
    const rows = placeSectionColumns([
      state("a"),
      state("b", { hidden: true }),
      state("c"),
      state("d"),
    ]);
    expect(columns(rows)).toEqual({ a: 0, b: 0, c: 0, d: 1 });
  });

  it("gives a section added by an update the column of its neighbour", () => {
    const rows = placeSectionColumns([placed("a", 0), state("new"), placed("c", 1)]);
    expect(columns(rows)).toEqual({ a: 0, new: 0, c: 1 });
  });

  it("takes the column below when a new section leads the run", () => {
    expect(columns(placeSectionColumns([state("new"), placed("b", 1)]))).toEqual({
      new: 1,
      b: 1,
    });
  });

  it("leaves a placed run untouched", () => {
    const stored = [placed("a", 1), placed("b", 1), placed("c", 0)];
    expect(columns(placeSectionColumns(stored))).toEqual({ a: 1, b: 1, c: 0 });
  });
});

describe("a stored layout written before columns were explicit", () => {
  const LEGACY: SectionDescriptor[] = ["a", "b", "c", "d"].map((name) => ({
    id: `world.${name}`,
    view: "world",
    labelKey: "world.planetCycles",
    defaultSpan: 1,
  }));

  const legacyStored = {
    version: 1 as const,
    sections: ["a", "b", "c", "d"].map((name) => state(`world.${name}`)),
  };

  it("loads into the arrangement the halving cut gave it", () => {
    const before = planSections(legacyStored.sections, "wide");
    const merged = mergeViewLayout(legacyStored, LEGACY);
    const after = planSections(merged.sections, "wide");
    expect(after).toEqual(before);
    if (after[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(after[0].columns[0]?.map((slot) => slot.id)).toEqual(["world.a", "world.b"]);
    expect(after[0].columns[1]?.map((slot) => slot.id)).toEqual(["world.c", "world.d"]);
  });

  it("comes back out of storage with a column on every section", () => {
    const normalized = normalizeLayoutState({
      version: 1,
      views: { world: { wide: { sections: legacyStored.sections } } },
    });
    const merged = mergeViewLayout(normalized.views.world?.wide ?? null, LEGACY);
    expect(columns(merged.sections)).toEqual({
      "world.a": 0,
      "world.b": 0,
      "world.c": 1,
      "world.d": 1,
    });
  });

  it("cuts the run by the spans the registry gives it, not the ones on disk", () => {
    const stored = {
      version: 1,
      views: {
        world: {
          wide: {
            sections: ["world.cycles", "world.timers", "world.circuit", "world.bounties"].map(
              (id) => ({ id, hidden: false, collapsed: false }),
            ),
          },
        },
      },
    };
    const normalized = normalizeLayoutState(stored);
    const merged = mergeViewLayout(normalized.views.world?.wide ?? null, DESCRIPTORS);
    expect(columns(merged.sections)).toEqual({
      "world.cycles": 0,
      "world.timers": 1,
      "world.circuit": 0,
      "world.bounties": 0,
    });
  });
});

describe("a single-column breakpoint", () => {
  const stored = [placed("a", 1), placed("b", 0), placed("c", 1)];

  it("stacks every section in one column whatever they were placed in", () => {
    const rows = planSections(stored, "narrow");
    expect(rows).toHaveLength(1);
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].columns[1]).toEqual([]);
  });

  it("round-trips the columns it does not use, so widening finds them again", () => {
    const normalized = normalizeLayoutState({
      version: 1,
      views: { world: { narrow: { sections: stored }, wide: { sections: stored } } },
    });
    const narrow = normalized.views.world?.narrow?.sections ?? [];
    expect(columns(narrow)).toEqual({ a: 1, b: 0, c: 1 });
    expect(columns(normalized.views.world?.wide?.sections ?? [])).toEqual({ a: 1, b: 0, c: 1 });
  });
});

describe("planSections", () => {
  const single = [state("a"), state("b"), state("c"), state("d"), state("e")];

  it("puts each section in the column it was placed in", () => {
    const rows = planSections(
      [placed("a", 1), placed("b", 0), placed("c", 1), placed("d", 0)],
      "wide",
    );
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["b", "d"]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["a", "c"]);
    expect(rows[0].columns[1]?.[0]?.firstInColumn).toBe(true);
    expect(rows[0].columns[1]?.[1]?.firstInColumn).toBe(false);
  });

  it("renders an empty column when every section was placed in one", () => {
    const rows = planSections([placed("a", 1), placed("b", 1)], "wide");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]).toEqual([]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["a", "b"]);
  });

  it("stacks everything in one column when narrow", () => {
    const rows = planSections(single, "narrow");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("columns");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rows[0].columns[1]).toEqual([]);
  });

  it("fills the left column first so each column reads top to bottom", () => {
    const rows = planSections(single, "wide");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["a", "b", "c"]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["d", "e"]);
    expect(rows[0].columns[0]?.[0]?.firstInColumn).toBe(true);
    expect(rows[0].columns[0]?.[1]?.firstInColumn).toBe(false);
    expect(rows[0].columns[1]?.[0]?.firstInColumn).toBe(true);
  });

  it("breaks the run for a wide section and resumes after it", () => {
    const rows = planSections(
      [state("a"), state("b"), state("wide", { span: "full" }), state("c"), state("d")],
      "wide",
    );
    expect(rows.map((row) => row.kind)).toEqual(["columns", "full", "columns"]);
    if (rows[1]?.kind !== "full") throw new Error("expected a full row");
    expect(rows[1].slot.id).toBe("wide");
    expect(rows[1].slot.firstInColumn).toBe(false);
  });

  it("skips hidden sections and sections with no content right now", () => {
    const rows = planSections(
      [state("a"), state("b", { hidden: true }), state("c")],
      "wide",
      new Set(["a", "b"]),
    );
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["a"]);
    expect(rows[0].columns[1]).toEqual([]);
  });

  it("returns no rows when everything is hidden", () => {
    expect(planSections([state("a", { hidden: true })], "wide")).toEqual([]);
  });
});
