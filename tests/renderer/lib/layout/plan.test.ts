import { describe, expect, it } from "vitest";

import {
  mergeViewLayout,
  moveSectionInList,
  nextSpan,
  normalizeLayoutState,
  planSections,
} from "../../../../src/lib/layout/plan.js";
import type { SectionDescriptor, SectionState } from "../../../../src/lib/layout/types.js";

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

const state = (id: string, patch: Partial<SectionState> = {}): SectionState => ({
  id,
  span: 1,
  hidden: false,
  collapsed: false,
  ...patch,
});

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

  it("reaches the other column by naming the section it landed on", () => {
    // planSections gives the left column the first ceil(n/2), so a drop on the
    // last section is the only way out of the left column.
    const four = [state("a"), state("b"), state("c"), state("d")];
    const rows = planSections(moveSectionInList(four, "a", { toId: "d" }), "wide");
    if (rows[0]?.kind !== "columns") throw new Error("expected a columns row");
    expect(rows[0].columns[0]?.map((slot) => slot.id)).toEqual(["b", "c"]);
    expect(rows[0].columns[1]?.map((slot) => slot.id)).toEqual(["d", "a"]);
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

describe("planSections", () => {
  const single = [state("a"), state("b"), state("c"), state("d"), state("e")];

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
