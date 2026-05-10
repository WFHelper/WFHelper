import { beforeAll, describe, expect, it } from "vitest";

import * as itemDb from "../../services/itemDatabase";
import * as masteryHelper from "../../services/masteryHelper";
import { MAX_ITEM_RANK, XP_PER_RANK } from "../../config/game/constants";

describe("mastery progress", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("uses account XP history so forma-reset mastered gear is not in progress", () => {
    const acceltraPrime = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: acceltraPrime, XP: 0 }],
      XPInfo: [{ ItemType: acceltraPrime, XP: MAX_ITEM_RANK * XP_PER_RANK }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === acceltraPrime);

    expect(item?.rank).toBe(0);
    expect(item?.status).toBe("mastered");
    expect(progress.stats.inProgress).toBe(0);
  });

  it("only marks unmastered owned gear below its max rank as in progress", () => {
    const acceltraPrime = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: acceltraPrime, XP: XP_PER_RANK }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === acceltraPrime);

    expect(item?.rank).toBe(1);
    expect(item?.status).toBe("progress");
  });

  it("includes hidden mastery items represented by the Warframe profile", () => {
    const names = new Set(masteryHelper.getAllMasterableItems().map((item) => item.name));

    expect([...names]).toEqual(
      expect.arrayContaining(["Mote Amp", "Plexus", "Venari", "Venari Prime", "Sirocco"]),
    );
  });
});
