import { describe, it, expect } from "vitest";

const { normalizeErrorMessage } = require("../../config/shared/errors.cjs");

// ---------------------------------------------------------------------------
// normalizeErrorMessage
// ---------------------------------------------------------------------------
describe("normalizeErrorMessage", () => {
  it("extracts .message from Error instances", () => {
    expect(normalizeErrorMessage(new Error("boom"))).toBe("boom");
    expect(normalizeErrorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("extracts .message from duck-typed error objects", () => {
    expect(normalizeErrorMessage({ message: "duck" })).toBe("duck");
    expect(normalizeErrorMessage({ message: "  trimmed  " })).toBe("trimmed");
  });

  it("handles plain string errors", () => {
    expect(normalizeErrorMessage("something broke")).toBe("something broke");
    expect(normalizeErrorMessage("  spaced  ")).toBe("spaced");
  });

  it("returns fallback for non-error values", () => {
    expect(normalizeErrorMessage(null)).toBe("Unknown error");
    expect(normalizeErrorMessage(undefined)).toBe("Unknown error");
    expect(normalizeErrorMessage(42)).toBe("Unknown error");
    expect(normalizeErrorMessage(true)).toBe("Unknown error");
    expect(normalizeErrorMessage({})).toBe("Unknown error");
  });

  it("returns fallback for empty .message", () => {
    expect(normalizeErrorMessage(new Error(""))).toBe("Unknown error");
    expect(normalizeErrorMessage({ message: "" })).toBe("Unknown error");
    expect(normalizeErrorMessage({ message: "   " })).toBe("Unknown error");
  });

  it("returns fallback for empty string errors", () => {
    expect(normalizeErrorMessage("")).toBe("Unknown error");
    expect(normalizeErrorMessage("   ")).toBe("Unknown error");
  });

  it("uses custom fallback when provided", () => {
    expect(normalizeErrorMessage(null, "Custom fallback")).toBe("Custom fallback");
    expect(normalizeErrorMessage(undefined, "Oops")).toBe("Oops");
  });

  it("ignores non-string .message properties", () => {
    expect(normalizeErrorMessage({ message: 123 })).toBe("Unknown error");
    expect(normalizeErrorMessage({ message: null })).toBe("Unknown error");
    expect(normalizeErrorMessage({ message: undefined })).toBe("Unknown error");
  });

  it("prefers .message over String() representation", () => {
    const err = { message: "from message", toString: () => "from toString" };
    expect(normalizeErrorMessage(err)).toBe("from message");
  });
});
