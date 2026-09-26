import { describe, expect, it } from "vitest";

import { Canvas, GAP, type Rect } from "./frameCanvas";
import { findWindowInFrame, mapLogicalRect } from "../../services/gameWindowLocate";

function search(canvas: Canvas, request: Parameters<typeof findWindowInFrame>[2]) {
  return findWindowInFrame(canvas.pixels, canvas, request);
}

function expectNear(actual: Rect | null, expected: Rect): void {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual!.x - expected.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual!.y - expected.y)).toBeLessThanOrEqual(1);
  expect(actual!.width).toBe(expected.width);
  expect(actual!.height).toBe(expected.height);
}

// niri defaults: 16 px gaps, a 4 px focus ring drawn in the gap.
const HALF_LEFT: Rect = { x: 16, y: 16, width: 936, height: 1048 };
const HALF_RIGHT: Rect = { x: 968, y: 16, width: 936, height: 1048 };

describe("findWindowInFrame", () => {
  it("finds a tiled game beside a narrower terminal, across a gap", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    const game: Rect = { x: 632, y: 46, width: 1272, height: 1018 };
    canvas.fill({ x: 0, y: 0, width: 1920, height: 30 }, [51, 51, 51]);
    canvas.terminal({ x: 16, y: 46, width: 600, height: 1018 });
    canvas.game(game);

    const found = search(canvas, { width: game.width, height: game.height });

    expectNear(found.rect, game);
  });

  it("finds the game's inner edge when the focus ring surrounds it", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    const game: Rect = { x: 664, y: 16, width: 1240, height: 1048 };
    canvas.terminal({ x: 16, y: 16, width: 632, height: 1048 });
    canvas.game(game);
    canvas.ring(game);

    expectNear(search(canvas, { width: game.width, height: game.height }).rect, game);
  });

  it("tells two same-size tiles apart by their column order", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal(HALF_LEFT);
    canvas.ring(HALF_LEFT);
    canvas.game(HALF_RIGHT);
    const size = { width: 936, height: 1048 };

    expectNear(
      search(canvas, { ...size, sameSize: { columns: [1, 2], index: 1 } }).rect,
      HALF_RIGHT,
    );
    expectNear(
      search(canvas, { ...size, sameSize: { columns: [1, 2], index: 0 } }).rect,
      HALF_LEFT,
    );
  });

  it("refuses to guess when two of three same-size tiles show", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal(HALF_LEFT);
    canvas.ring(HALF_LEFT);
    canvas.game(HALF_RIGHT);

    const found = search(canvas, {
      width: 936,
      height: 1048,
      sameSize: { columns: [1, 2, 3], index: 1 },
    });

    expect(found.rect).toBeNull();
  });

  // niri's default: every new column is half the output, so the game and its
  // neighbour share a size; niri reports columns [1..4] with two on screen.
  it("picks the focused game among visible same-size tiles by its focus ring", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.game(HALF_LEFT);
    canvas.game(HALF_RIGHT);
    canvas.ring(HALF_RIGHT);
    const request = { width: 936, height: 1048, sameSize: { columns: [1, 2, 3, 4], index: 3 } };

    expect(search(canvas, request).rect).toBeNull();
    const found = search(canvas, { ...request, gameFocused: true });
    expectNear(found.rect, HALF_RIGHT);
    expect(found.verdict).toContain("focus ring");
  });

  it("refuses the focus ring tie-break when every gap is colourful", () => {
    const canvas = new Canvas(1920, 1080, [40, 120, 200]);
    canvas.game(HALF_LEFT);
    canvas.game(HALF_RIGHT);
    canvas.ring(HALF_RIGHT);

    const found = search(canvas, {
      width: 936,
      height: 1048,
      sameSize: { columns: [1, 2, 3, 4], index: 3 },
      gameFocused: true,
    });

    expect(found.rect).toBeNull();
  });

  it("does not pass off the only visible twin as the game", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    // The game's edges vanish into a gap of its colour; the ringed terminal
    // left of it could as well be the game with its twin scrolled away.
    canvas.terminal(HALF_LEFT);
    canvas.ring(HALF_LEFT);
    canvas.fill(HALF_RIGHT, GAP);

    const found = search(canvas, {
      width: 936,
      height: 1048,
      sameSize: { columns: [1, 2], index: 1 },
    });

    expect(found.rect).toBeNull();
    expect(found.verdict).toContain("same-size");
  });

  it("takes a lone match when a same-size neighbour would leave the focused game no room", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.game(HALF_RIGHT);

    const found = search(canvas, {
      width: 936,
      height: 1048,
      sameSize: { columns: [1, 2], index: 1 },
      gameFocused: true,
    });

    expectNear(found.rect, HALF_RIGHT);
    expect(found.verdict).toContain("lone match");
  });

  // niri keeps the focused column in view, not the others: here the game's left
  // neighbour shows at the right and the game is scrolled off past the frame.
  it("takes no lone match while the game is unfocused", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal(HALF_RIGHT);
    canvas.ring(HALF_RIGHT);

    const found = search(canvas, {
      width: 936,
      height: 1048,
      sameSize: { columns: [1, 2], index: 1 },
    });

    expect(found.rect).toBeNull();
    expect(found.verdict).toContain("not focused");
  });

  it("finds nothing in a busy frame", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.noise();

    const found = search(canvas, { width: 936, height: 917 });

    expect(found.rect).toBeNull();
  });

  it("finds nothing on a regular grid, where every cell looks like the window", () => {
    const canvas = new Canvas(1920, 1080, [240, 240, 240]);
    for (let x = 0; x < 1920; x += 24)
      canvas.fill({ x, y: 0, width: 1, height: 1080 }, [90, 90, 90]);
    for (let y = 0; y < 1080; y += 24)
      canvas.fill({ x: 0, y, width: 1920, height: 1 }, [90, 90, 90]);

    expect(search(canvas, { width: 960, height: 720 }).rect).toBeNull();
  });

  it("finds nothing when no window of that size is there", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal({ x: 16, y: 16, width: 1888, height: 1048 });

    expect(search(canvas, { width: 936, height: 917 }).rect).toBeNull();
  });

  it("settles a maximized column inside a narrow range", () => {
    const canvas = new Canvas(1920, 1080, GAP);
    const game: Rect = { x: 16, y: 46, width: 1888, height: 1018 };
    canvas.fill({ x: 0, y: 0, width: 1920, height: 30 }, [51, 51, 51]);
    canvas.game(game);

    const found = search(canvas, {
      width: game.width,
      height: game.height,
      area: { minX: 0, maxX: 32, minY: 0, maxY: 62 },
    });

    expectNear(found.rect, game);
  });

  it("works on a physical frame at 1.5x", () => {
    const canvas = new Canvas(2880, 1620, GAP);
    const game: Rect = { x: 1452, y: 24, width: 1404, height: 1572 };
    canvas.terminal({ x: 24, y: 24, width: 1404, height: 1572 });
    canvas.game(game);
    canvas.ring(game, 6);

    const found = search(canvas, {
      width: 1404,
      height: 1572,
      sameSize: { columns: [1, 2], index: 1 },
      gameFocused: true,
    });

    expectNear(found.rect, game);
  });
});

describe("mapLogicalRect", () => {
  it("scales a logical rect by the frame over the output's logical size", () => {
    const space = { x: 1920, y: 0, scaleX: 1.5, scaleY: 1.5 };
    expect(
      mapLogicalRect({ x: 2600, y: 100, width: 1000, height: 600 }, space, {
        width: 3840,
        height: 2160,
      }),
    ).toEqual({ x: 1020, y: 150, width: 1500, height: 900 });
  });

  it("refuses a rect that lies partly outside the frame", () => {
    const space = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    const frame = { width: 1920, height: 1080 };
    expect(mapLogicalRect({ x: 1500, y: 0, width: 936, height: 1048 }, space, frame)).toBeNull();
    expect(mapLogicalRect({ x: 2000, y: 0, width: 936, height: 1048 }, space, frame)).toBeNull();
  });

  it("clips a rect that overshoots the frame by a rounding pixel", () => {
    const space = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    expect(
      mapLogicalRect({ x: -1, y: 0, width: 1921, height: 1080 }, space, {
        width: 1920,
        height: 1080,
      }),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
