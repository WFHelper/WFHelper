import { describe, it, expect } from "vitest";
import { normalizeErrorMessage } from "../../config/shared/errors";

describe("normalizeErrorMessage", () => {
  it.each([
    [new Error("boom"), "boom"],
    [new TypeError("bad type"), "bad type"],
    [{ message: "duck" }, "duck"],
    [{ message: "  trimmed  " }, "trimmed"],
    ["something broke", "something broke"],
    ["  spaced  ", "spaced"],
    // Prefer .message over toString()
    [{ message: "from message", toString: () => "from toString" }, "from message"],
  ])("extracts a usable message from %o", (input, expected) => {
    expect(normalizeErrorMessage(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    42,
    true,
    {},
    new Error(""),
    { message: "" },
    { message: "   " },
    { message: 123 },
    { message: null },
    "",
    "   ",
  ])("falls back to 'Unknown error' for %o", (input) => {
    expect(normalizeErrorMessage(input)).toBe("Unknown error");
  });

  it("uses the caller-supplied fallback when provided", () => {
    expect(normalizeErrorMessage(null, "Custom fallback")).toBe("Custom fallback");
    expect(normalizeErrorMessage(undefined, "Oops")).toBe("Oops");
  });
});
