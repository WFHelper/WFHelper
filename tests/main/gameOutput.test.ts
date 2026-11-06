import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rects: [] as Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    placed: boolean;
  }>,
  bounds: null as null | { x: number; y: number; width: number; height: number },
  compositorOutput: null as string | null,
}));

vi.mock("../../services/layerShell", () => ({
  layerOutputRects: () => state.rects,
}));

vi.mock("../../services/warframeStatus", () => ({
  getWarframeWindowBoundsLinux: vi.fn(async () => state.bounds),
}));

vi.mock("../../services/waylandCompositor", () => ({
  resolveGameOutput: vi.fn(async () => state.compositorOutput),
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn() }),
}));

import { resolveOutputForGame } from "../../services/gameOutput";

function output(name: string, x: number, y: number, width: number, height: number) {
  return { name, x, y, width, height, scale: 1, placed: true };
}

describe("resolveOutputForGame", () => {
  beforeEach(() => {
    state.rects = [];
    state.bounds = null;
    state.compositorOutput = null;
  });

  it("matches the unique monitor size when XWayland flattens the window origin", async () => {
    state.rects = [output("1080p", 0, 0, 1920, 1080), output("1440p", 1920, 0, 2560, 1440)];
    // XWayland reports the 1440p game at (0, 0), placing its center on the
    // 1080p output in compositor coordinates.
    state.bounds = { x: 0, y: 0, width: 2560, height: 1440 };

    await expect(resolveOutputForGame()).resolves.toBe("1440p");
  });

  it("uses center containment when multiple outputs have the same size", async () => {
    state.rects = [output("left", 0, 0, 1920, 1080), output("right", 1920, 0, 1920, 1080)];
    state.bounds = { x: 1920, y: 0, width: 1920, height: 1080 };

    await expect(resolveOutputForGame()).resolves.toBe("right");
  });

  it("prefers a center-matching output with the same size when center matches overlap", async () => {
    state.rects = [
      output("overlapping-other", 0, 0, 2560, 1440),
      output("size-and-center", 0, 0, 1920, 1080),
      output("same-size-away", 4000, 0, 1920, 1080),
    ];
    state.bounds = { x: 0, y: 0, width: 1920, height: 1080 };

    await expect(resolveOutputForGame()).resolves.toBe("size-and-center");
  });

  it("uses center containment for windowed bounds with no exact size match", async () => {
    state.rects = [output("1080p", 0, 0, 1920, 1080), output("1440p", 1920, 0, 2560, 1440)];
    state.bounds = { x: 2100, y: 200, width: 800, height: 600 };

    await expect(resolveOutputForGame()).resolves.toBe("1440p");
  });

  it("returns null for one output or missing game bounds when IPC has no answer", async () => {
    state.rects = [output("only", 0, 0, 1920, 1080)];
    state.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    await expect(resolveOutputForGame()).resolves.toBeNull();

    state.rects = [output("left", 0, 0, 1920, 1080), output("right", 1920, 0, 1920, 1080)];
    state.bounds = null;
    await expect(resolveOutputForGame()).resolves.toBeNull();
  });
});
