import { describe, expect, it } from "vitest";

import { nextSpan } from "../../../../src/lib/layout/plan.js";
import type { SectionSpan } from "../../../../src/lib/layout/types.js";

const SPANS: readonly SectionSpan[] = [1, 2, "full"];

// vitest cannot compile `.svelte`, so LayoutSection's guard is mirrored here:
// `$: spanLocked = nextSpan(span, descriptor?.minSpan) === span`.
function spanLocked(span: SectionSpan, minSpan?: SectionSpan): boolean {
  return nextSpan(span, minSpan) === span;
}

describe("span cycle affordance", () => {
  // A section pinned to the widest span cycles back onto itself, so the button
  // is a control that can never change anything.
  it("locks a section pinned to the widest span", () => {
    expect(spanLocked("full", "full")).toBe(true);
  });

  it("locks exactly the fixed points of the cycle", () => {
    const locked: string[] = [];
    for (const span of SPANS) {
      for (const minSpan of [undefined, ...SPANS]) {
        if (spanLocked(span, minSpan)) locked.push(`${String(span)}/${String(minSpan)}`);
      }
    }
    expect(locked).toEqual(["full/full"]);
  });

  it("leaves an unconstrained section cycleable at every width", () => {
    expect(SPANS.map((span) => spanLocked(span))).toEqual([false, false, false]);
  });

  it("stays live for a stored span below its own floor", () => {
    expect(spanLocked(1, "full")).toBe(false);
    expect(spanLocked(1, 2)).toBe(false);
  });
});
