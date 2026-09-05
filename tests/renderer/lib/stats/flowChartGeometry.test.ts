import { describe, expect, it } from "vitest";

import {
  flowAxis,
  flowBarHeight,
  flowBarX,
  FLOW_BAR,
  FLOW_HEIGHT,
  FLOW_SLOT,
} from "../../../../src/lib/stats/chartData.js";

describe("analysis flow chart geometry", () => {
  it("keeps the slot, bar and height the panels are drawn against", () => {
    expect([FLOW_SLOT, FLOW_BAR, FLOW_HEIGHT]).toEqual([10, 6.5, 100]);
  });

  it("splits the height between the two directions", () => {
    const axis = flowAxis(3, 100, 50);
    expect(axis.width).toBe(30);
    expect(axis.span).toBe(150);
    expect(axis.zeroY).toBeCloseTo(200 / 3, 10);
  });

  it("keeps one slot of width and a full-height zero line with nothing to plot", () => {
    expect(flowAxis(0, 0, 0)).toEqual({ width: 10, zeroY: 100, span: 0 });
    expect(flowAxis(4, 0, 0)).toEqual({ width: 40, zeroY: 100, span: 0 });
  });

  it("centres each bar in its slot", () => {
    expect(flowBarX(0)).toBe(1.75);
    expect(flowBarX(3)).toBe(31.75);
  });

  it("scales a bar to the span and never drops it below a sliver", () => {
    expect(flowBarHeight(100, 150)).toBeCloseTo(200 / 3, 10);
    expect(flowBarHeight(-50, 150)).toBeCloseTo(100 / 3, 10);
    expect(flowBarHeight(0, 150)).toBe(1);
    expect(flowBarHeight(0.0001, 150)).toBe(1);
    expect(flowBarHeight(10, 0)).toBe(0);
  });

  it("reproduces the geometry both panels computed inline", () => {
    const nets = [120, -40, 0, 7];
    const up = nets.reduce((m, n) => Math.max(m, n), 0);
    const down = nets.reduce((m, n) => Math.max(m, -n), 0);
    const span = up + down;
    const zeroY = (up / span) * 100;
    const axis = flowAxis(nets.length, up, down);
    expect(axis.width).toBe(Math.max(1, nets.length) * 10);
    expect(axis.zeroY).toBeCloseTo(zeroY, 10);
    nets.forEach((net, index) => {
      expect(flowBarX(index)).toBeCloseTo(index * 10 + (10 - 6.5) / 2, 10);
      expect(flowBarHeight(net, axis.span)).toBeCloseTo(
        Math.max(1, (Math.abs(net) / span) * 100),
        10,
      );
    });
  });
});
