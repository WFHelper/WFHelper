import { describe, expect, it } from "vitest";

import { computeGridWindow } from "../../../src/lib/windowedGrid.js";

type GridGeometry = Parameters<typeof computeGridWindow>[1];

function geometry(overrides: Partial<GridGeometry> = {}): GridGeometry {
  return { columns: 4, gap: 10, rowHeights: new Map(), estimate: 90, ...overrides };
}

// With a 90px row and a 10px gap every row starts at a multiple of 100px.
describe("computeGridWindow", () => {
  it("renders nothing for an empty list", () => {
    expect(computeGridWindow(0, geometry(), 0, 500, 0)).toEqual({
      start: 0,
      end: 0,
      topSpacer: null,
      bottomSpacer: null,
    });
  });

  it("covers the view from the top and stands a spacer in for the rest", () => {
    // 40 items = 10 rows = 1000px; the view shows rows 0-2.
    const range = computeGridWindow(40, geometry(), 0, 250, 0);
    expect(range.start).toBe(0);
    expect(range.end).toBe(12);
    expect(range.topSpacer).toBeNull();
    // Rows 3-9 are 700px including their gaps; the spacer row brings one gap itself.
    expect(range.bottomSpacer).toBe(690);
  });

  it("starts on a row boundary and keeps the grid at its full height", () => {
    const range = computeGridWindow(40, geometry(), 420, 620, 0);
    expect(range.start).toBe(16);
    expect(range.end).toBe(28);
    // Row 4 starts at 400px: a 390px spacer plus its gap.
    expect(range.topSpacer).toBe(390);
    expect(range.bottomSpacer).toBe(290);
    const rendered = 3 * 90 + 2 * 10;
    expect((range.topSpacer ?? 0) + 10 + rendered + 10 + (range.bottomSpacer ?? 0)).toBe(990);
  });

  it("widens the rendered rows by the overscan on both sides", () => {
    const range = computeGridWindow(40, geometry(), 420, 620, 150);
    expect(range.start).toBe(8);
    expect(range.end).toBe(32);
  });

  it("uses measured heights where it has them", () => {
    const rowHeights = new Map([
      [0, 290],
      [1, 290],
    ]);
    const range = computeGridWindow(40, geometry({ rowHeights }), 610, 700, 0);
    // Rows 0-1 take 600px, so the view starts in row 2.
    expect(range.start).toBe(8);
    expect(range.topSpacer).toBe(590);
  });

  it("ends a partial last row at the item count", () => {
    const range = computeGridWindow(10, geometry(), 0, 5000, 0);
    expect(range.start).toBe(0);
    expect(range.end).toBe(10);
    expect(range.bottomSpacer).toBeNull();
  });

  it("follows a list that shrank below the view to where the scroller clamps", () => {
    // 8 items = 2 rows = 200px, while the view still sits at 2000-2300px.
    const range = computeGridWindow(8, geometry(), 2000, 2300, 0);
    expect(range.start).toBe(0);
    expect(range.end).toBe(8);
  });

  it("always renders at least one row", () => {
    const range = computeGridWindow(40, geometry(), -500, -400, 0);
    expect(range.end - range.start).toBe(4);
  });

  it("treats a single column as a list", () => {
    const range = computeGridWindow(40, geometry({ columns: 1 }), 1000, 1200, 0);
    expect(range.start).toBe(10);
    expect(range.end).toBe(12);
  });
});
