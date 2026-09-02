import { describe, expect, it } from "vitest";

import { titleCase } from "../../../config/shared/textNormalize.js";

describe("titleCase", () => {
  it("capitalises each word over a lowercased base", () => {
    expect(titleCase("cambion")).toBe("Cambion");
    expect(titleCase("EXTERMINATION")).toBe("Extermination");
    expect(titleCase("bounty rescue")).toBe("Bounty Rescue");
    expect(titleCase("MOBILE_DEFENSE".replace(/_/g, " "))).toBe("Mobile Defense");
    expect(titleCase("")).toBe("");
  });

  it("treats a hyphen as a word break and an apostrophe as none", () => {
    expect(titleCase("zariman ten-zero")).toBe("Zariman Ten-Zero");
    expect(titleCase("KAHL'S GARRISON")).toBe("Kahl's Garrison");
  });
});
