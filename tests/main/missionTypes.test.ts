import { describe, expect, it } from "vitest";

import {
  FISSURE_MISSION_TYPES,
  MISSION_TYPE_LABELS,
  missionTypeMatches,
} from "../../config/shared/missionTypes";

describe("MISSION_TYPE_LABELS", () => {
  it("uses DE's mission-type meanings", () => {
    expect(MISSION_TYPE_LABELS.MT_TERRITORY).toBe("Interception");
    expect(MISSION_TYPE_LABELS.MT_PURIFY).toBe("Infested Salvage");
    expect(MISSION_TYPE_LABELS.MT_ARTIFACT).toBe("Disruption");
    expect(MISSION_TYPE_LABELS.MT_CORRUPTION).toBe("Void Flood");
    expect(MISSION_TYPE_LABELS.MT_ARMAGEDDON).toBe("Void Armageddon");
    expect(MISSION_TYPE_LABELS.MT_EXTERMINATION).toBe("Exterminate");
  });

  it("drops enum keys DE never emits", () => {
    for (const invented of [
      "MT_INTERCEPTION",
      "MT_EXCAVATION",
      "MT_NEST",
      "MT_SECTOR",
      "MT_VOID_FLOOD",
      "MT_VOID_ARMAGEDDON",
    ]) {
      expect(MISSION_TYPE_LABELS[invented]).toBeUndefined();
    }
  });
});

describe("FISSURE_MISSION_TYPES", () => {
  it("offers only mission types a fissure can run", () => {
    expect(FISSURE_MISSION_TYPES).toContain("Void Flood");
    expect(FISSURE_MISSION_TYPES).toContain("Alchemy");
    expect(FISSURE_MISSION_TYPES).toContain("Assault");
    expect(FISSURE_MISSION_TYPES).toContain("Infested Salvage");
    expect(FISSURE_MISSION_TYPES).toContain("Interception");
    expect(FISSURE_MISSION_TYPES).not.toContain("any");
  });

  it("keeps the two mission types the old dropdown offered", () => {
    // Saved rules render read-only and match by label, so dropping either only
    // costs the user the ability to create that rule again.
    expect(FISSURE_MISSION_TYPES).toContain("Assassination");
    expect(FISSURE_MISSION_TYPES).toContain("Defection");
  });

  it("includes the railjack-only void storm missions", () => {
    expect(FISSURE_MISSION_TYPES).toContain("Skirmish");
    expect(FISSURE_MISSION_TYPES).toContain("Volatile");
    expect(FISSURE_MISSION_TYPES).toContain("Orphix");
  });

  it("has no duplicates", () => {
    expect(new Set(FISSURE_MISSION_TYPES).size).toBe(FISSURE_MISSION_TYPES.length);
  });
});

describe("missionTypeMatches", () => {
  it("treats any and an empty rule as a wildcard", () => {
    expect(missionTypeMatches("any", "Interception")).toBe(true);
    expect(missionTypeMatches("", "Interception")).toBe(true);
  });

  it("ignores case and padding", () => {
    expect(missionTypeMatches("interception", "Interception")).toBe(true);
    expect(missionTypeMatches("MOBILE DEFENSE", " Mobile  Defense ")).toBe(true);
  });

  it("matches a rule saved with the old Extermination wording", () => {
    expect(missionTypeMatches("Extermination", "Exterminate")).toBe(true);
    expect(missionTypeMatches("Exterminate", "Extermination")).toBe(true);
    expect(missionTypeMatches("Exterminate", "Exterminate")).toBe(true);
  });

  it("does not match a different mission", () => {
    expect(missionTypeMatches("Defense", "Mobile Defense")).toBe(false);
    expect(missionTypeMatches("Infested Salvage", "Interception")).toBe(false);
  });
});
