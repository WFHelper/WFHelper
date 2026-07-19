import { describe, expect, it } from "vitest";
import {
  baseZoomForDisplayHeight,
  computeUiZoomFactor,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from "../../config/runtime/uiScale";

describe("baseZoomForDisplayHeight", () => {
  it("scales up on taller displays and down on short ones", () => {
    expect(baseZoomForDisplayHeight(720)).toBe(0.8);
    expect(baseZoomForDisplayHeight(900)).toBe(0.9);
    expect(baseZoomForDisplayHeight(1080)).toBe(1);
    expect(baseZoomForDisplayHeight(1440)).toBe(1.15);
    expect(baseZoomForDisplayHeight(2160)).toBe(1.3);
  });

  it("falls back to 1 when the height is unusable", () => {
    expect(baseZoomForDisplayHeight(0)).toBe(1);
    expect(baseZoomForDisplayHeight(Number.NaN)).toBe(1);
    expect(baseZoomForDisplayHeight(undefined)).toBe(1);
  });
});

describe("computeUiZoomFactor", () => {
  it("multiplies the display base by the user override", () => {
    expect(computeUiZoomFactor(1080, 1)).toBe(1);
    expect(computeUiZoomFactor(1440, 1)).toBe(1.15);
    expect(computeUiZoomFactor(1080, 1.25)).toBe(1.25);
  });

  it("clamps the override to the supported range", () => {
    expect(computeUiZoomFactor(1080, 99)).toBe(UI_SCALE_MAX);
    expect(computeUiZoomFactor(1080, 0.1)).toBe(UI_SCALE_MIN);
    expect(computeUiZoomFactor(1080, "nonsense")).toBe(1);
  });
});
