import { describe, it, expect } from "vitest";

const { WFM_HEADERS, WFM_ASSET_BASE, normalizeWfmSlug } = require("../../config/shared/wfm.cjs");

// ---------------------------------------------------------------------------
// WFM_HEADERS
// ---------------------------------------------------------------------------
describe("WFM_HEADERS", () => {
  it("contains the expected keys", () => {
    expect(WFM_HEADERS).toEqual({
      Platform: "pc",
      Language: "en",
      Crossplay: "true",
      Accept: "application/json",
    });
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(WFM_HEADERS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WFM_ASSET_BASE
// ---------------------------------------------------------------------------
describe("WFM_ASSET_BASE", () => {
  it("is the warframe.market static assets URL", () => {
    expect(WFM_ASSET_BASE).toBe("https://warframe.market/static/assets/");
  });

  it("ends with a trailing slash", () => {
    expect(WFM_ASSET_BASE.endsWith("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeWfmSlug
// ---------------------------------------------------------------------------
describe("normalizeWfmSlug", () => {
  it("lowercases and trims", () => {
    expect(normalizeWfmSlug("  Frost Prime  ")).toBe("frost_prime");
  });

  it("replaces spaces and special characters with underscores", () => {
    expect(normalizeWfmSlug("Ash Prime Set")).toBe("ash_prime_set");
    expect(normalizeWfmSlug("Primed Flow!")).toBe("primed_flow");
  });

  it("strips ASCII apostrophe", () => {
    expect(normalizeWfmSlug("Loki's Decoy")).toBe("lokis_decoy");
  });

  it("treats unicode curly quotes as non-alphanumeric (underscore)", () => {
    // U+2019 (right single quote) and U+2018 (left single quote) are NOT in
    // the strip list, so they become underscores via the [^a-z0-9]+ rule.
    expect(normalizeWfmSlug("Loki\u2019s Decoy")).toBe("loki_s_decoy");
    expect(normalizeWfmSlug("Loki\u2018s Decoy")).toBe("loki_s_decoy");
  });

  it("collapses multiple non-alphanumeric runs to single underscore", () => {
    expect(normalizeWfmSlug("a -- b ++ c")).toBe("a_b_c");
  });

  it("strips leading and trailing underscores", () => {
    expect(normalizeWfmSlug("_test_")).toBe("test");
    expect(normalizeWfmSlug("___abc___")).toBe("abc");
  });

  it("returns null for non-string input", () => {
    expect(normalizeWfmSlug(null)).toBeNull();
    expect(normalizeWfmSlug(undefined)).toBeNull();
    expect(normalizeWfmSlug(42)).toBeNull();
    expect(normalizeWfmSlug({})).toBeNull();
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(normalizeWfmSlug("")).toBeNull();
    expect(normalizeWfmSlug("   ")).toBeNull();
  });

  it("returns null for strings that become empty after normalization", () => {
    expect(normalizeWfmSlug("!!!")).toBeNull();
    expect(normalizeWfmSlug("---")).toBeNull();
  });

  it("handles typical WFM slugs passthrough", () => {
    expect(normalizeWfmSlug("nikana_prime_set")).toBe("nikana_prime_set");
    expect(normalizeWfmSlug("serration")).toBe("serration");
  });
});
