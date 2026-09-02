import { describe, expect, it } from "vitest";

import { exportCustomCss, importCustomCss } from "../../../../src/lib/customCss/portable.js";
import { CUSTOM_CSS_MAX_BYTES } from "../../../../src/lib/customCss/sanitize.js";

describe("exportCustomCss", () => {
  it("writes a versioned envelope", () => {
    const text = exportCustomCss({ css: ".x{}", enabled: true, updatedAt: 12 });
    expect(JSON.parse(text)).toEqual({ version: 1, css: ".x{}", enabled: true, updatedAt: 12 });
  });

  it("coerces a state that lost its shape", () => {
    const text = exportCustomCss({
      css: null as unknown as string,
      enabled: 1 as unknown as boolean,
      updatedAt: Number.NaN,
    });
    expect(JSON.parse(text)).toEqual({ version: 1, css: "", enabled: false, updatedAt: 0 });
  });
});

describe("importCustomCss", () => {
  it("rejects a non-string", () => {
    expect(importCustomCss(null)).toEqual({ ok: false, reason: "notText" });
  });

  it("rejects text over the cap", () => {
    expect(importCustomCss("a".repeat(CUSTOM_CSS_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "tooLarge",
    });
  });

  it("accepts a plain stylesheet", () => {
    expect(importCustomCss(".x { color: red; }")).toEqual({
      ok: true,
      css: ".x { color: red; }",
      enabled: null,
    });
  });

  it("round-trips an exported envelope", () => {
    const text = exportCustomCss({ css: ".x{}", enabled: true, updatedAt: 12 });
    expect(importCustomCss(text)).toEqual({ ok: true, css: ".x{}", enabled: true });
  });

  it("rejects an envelope whose css is not text", () => {
    expect(importCustomCss(JSON.stringify({ version: 1, css: 5 }))).toEqual({
      ok: false,
      reason: "notText",
    });
  });

  it("rejects an envelope whose css is over the cap", () => {
    const payload = JSON.stringify({ version: 1, css: "a".repeat(CUSTOM_CSS_MAX_BYTES + 1) });
    // The envelope itself is larger than the cap, so the outer guard fires first.
    expect(importCustomCss(payload)).toEqual({ ok: false, reason: "tooLarge" });
  });
});
