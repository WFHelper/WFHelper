import { describe, expect, it } from "vitest";

import {
  fallbackNameFromUniqueName,
  sanitizeDisplayName,
} from "../../config/shared/displayName";

describe("sanitizeDisplayName", () => {
  it("strips any leading DE bracket marker, not just <ARCHWING>", () => {
    expect(sanitizeDisplayName("<ARCHWING> Amesha")).toBe("Amesha");
    expect(sanitizeDisplayName("<CREDITS> 15000")).toBe("15000");
    expect(sanitizeDisplayName("<ENDO> Endo")).toBe("Endo");
    expect(sanitizeDisplayName("<ARCHWING> Odonata Prime")).toBe("Odonata Prime");
  });

  it("leaves normal names untouched and trims", () => {
    expect(sanitizeDisplayName("Braton Prime")).toBe("Braton Prime");
    expect(sanitizeDisplayName("  Soma  ")).toBe("Soma");
    expect(sanitizeDisplayName(null)).toBe("");
  });

  it("does not touch a mid-string angle bracket", () => {
    expect(sanitizeDisplayName("Foo <bar> Baz")).toBe("Foo <bar> Baz");
  });

  it("keeps a bare marker rather than returning a blank name", () => {
    expect(sanitizeDisplayName("<CREDITS>")).toBe("<CREDITS>");
    expect(sanitizeDisplayName("<ARCHWING>")).toBe("<ARCHWING>");
    expect(sanitizeDisplayName("  <ENDO>  ")).toBe("<ENDO>");
  });
});

describe("fallbackNameFromUniqueName", () => {
  it("spaces out camelCase path segments", () => {
    expect(fallbackNameFromUniqueName("/Lotus/Weapons/Tenno/LongGuns/BratonPrime")).toBe(
      "Braton Prime",
    );
  });

  it("drops the trailing Name artifact from /Lotus/Language keys", () => {
    expect(fallbackNameFromUniqueName("/Lotus/Language/Narmer/ArchonCrystalGreenName")).toBe(
      "Archon Crystal Green",
    );
    expect(fallbackNameFromUniqueName("/Lotus/Language/Narmer/ArchonCrystalAmarMythicName")).toBe(
      "Archon Crystal Amar Mythic",
    );
  });

  it("keeps a trailing 'Name' segment when it is a real item path, not a Language key", () => {
    // Non-Language paths are left alone (no such real items today, but the guard
    // proves the strip is scoped to localization keys).
    expect(fallbackNameFromUniqueName("/Lotus/Types/Items/SomethingName")).toBe("Something Name");
  });

  it("returns Unknown for empty input", () => {
    expect(fallbackNameFromUniqueName("")).toBe("Unknown");
    expect(fallbackNameFromUniqueName(null)).toBe("Unknown");
  });
});
