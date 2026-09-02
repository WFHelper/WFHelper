import { describe, expect, it } from "vitest";

import { isResizeObserverLoopError } from "../../../src/lib/log.js";

describe("isResizeObserverLoopError", () => {
  it("matches both Chromium loop messages, as a string or an Error", () => {
    expect(isResizeObserverLoopError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(
      isResizeObserverLoopError(
        new Error("ResizeObserver loop completed with undelivered notifications"),
      ),
    ).toBe(true);
  });

  it("tolerates the uncaught prefix, an Error: prefix and a trailing period", () => {
    expect(isResizeObserverLoopError("Uncaught ResizeObserver loop limit exceeded")).toBe(true);
    expect(
      isResizeObserverLoopError(
        "Uncaught Error: ResizeObserver loop completed with undelivered notifications.",
      ),
    ).toBe(true);
    expect(isResizeObserverLoopError("  Error: ResizeObserver loop limit exceeded.  ")).toBe(true);
  });

  it("refuses an unrelated error that merely mentions a ResizeObserver", () => {
    expect(
      isResizeObserverLoopError("Cannot read properties of undefined (reading 'ResizeObserver')"),
    ).toBe(false);
    expect(
      isResizeObserverLoopError("ResizeObserver loop limit exceeded while saving the workspace"),
    ).toBe(false);
    expect(isResizeObserverLoopError("Failed to construct 'ResizeObserver'")).toBe(false);
  });

  it("treats a missing reason as a real error", () => {
    expect(isResizeObserverLoopError(null)).toBe(false);
    expect(isResizeObserverLoopError(undefined)).toBe(false);
  });
});
