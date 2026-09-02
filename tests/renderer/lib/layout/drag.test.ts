import { describe, expect, it } from "vitest";

import { resolveDropTarget } from "../../../../src/lib/layout/drag.js";

interface Drag {
  id: string;
  scope: readonly string[] | null;
  lastTargetId: string | null;
}

function drag(patch: Partial<Drag> = {}): Drag {
  return { id: "world.darvo", scope: null, lastTargetId: null, ...patch };
}

describe("resolveDropTarget", () => {
  it("takes a section the pointer has not dropped on yet", () => {
    expect(resolveDropTarget(drag(), "world.cycles", true)).toEqual({
      targetId: "world.cycles",
      lastTargetId: "world.cycles",
    });
  });

  it("ignores a pointer that is over nothing", () => {
    expect(resolveDropTarget(drag({ lastTargetId: "world.cycles" }), null, true)).toEqual({
      targetId: null,
      lastTargetId: "world.cycles",
    });
  });

  it("forgets the last cell when the pointer is back over the dragged section", () => {
    // The move puts the dragged section under the pointer, so the cell it came
    // from has to become droppable again or a drag can only ever move once.
    expect(resolveDropTarget(drag({ lastTargetId: "world.cycles" }), "world.darvo", true)).toEqual({
      targetId: null,
      lastTargetId: null,
    });
  });

  it("commits once while the pointer stays on the same cell", () => {
    expect(resolveDropTarget(drag({ lastTargetId: "world.cycles" }), "world.cycles", true)).toEqual(
      { targetId: null, lastTargetId: "world.cycles" },
    );
  });

  it("ignores a hit that belongs to another grid", () => {
    expect(resolveDropTarget(drag(), "world.dailies", false)).toEqual({
      targetId: null,
      lastTargetId: null,
    });
  });

  it("ignores a section this screen does not render", () => {
    const scoped = drag({ scope: ["world.darvo", "world.cycles"] });
    expect(resolveDropTarget(scoped, "world.arbiSchedule", true)).toEqual({
      targetId: null,
      lastTargetId: null,
    });
    expect(resolveDropTarget(scoped, "world.cycles", true)).toEqual({
      targetId: "world.cycles",
      lastTargetId: "world.cycles",
    });
  });
});
