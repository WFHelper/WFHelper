import { beforeAll, describe, expect, it } from "vitest";

const itemDb = require("../../services/itemDatabase.js");
const masteryHelper = require("../../services/masteryHelper.js");

describe("mastery category overrides", () => {
  let allMasterable: Array<{
    name: string;
    category: string;
    debugReason?: string;
    keywords?: string[];
  }> = [];

  beforeAll(() => {
    itemDb.buildDatabase();
    allMasterable = masteryHelper.getAllMasterableItems();
  });

  it("places hound companions under Companions instead of Secondary", () => {
    const bhaira = allMasterable.find((item) => item.name === "Bhaira Hound");

    expect(bhaira).toBeTruthy();
    expect(bhaira?.category).toBe("Companions");
    expect(bhaira?.debugReason).toContain("cat:override:pets");
  });

  it("places K-Drive boards under Misc instead of Secondary", () => {
    const badBaby = allMasterable.find((item) => item.name === "Bad Baby");

    expect(badBaby).toBeTruthy();
    expect(badBaby?.category).toBe("Misc");
    expect(badBaby?.debugReason).toContain("cat:override:k-drive");
  });

  it("tags K-Drive boards with searchable k-drive keywords", () => {
    const badBaby = allMasterable.find((item) => item.name === "Bad Baby");

    expect(badBaby).toBeTruthy();
    expect(badBaby?.keywords).toEqual(expect.arrayContaining(["k-drive", "kdrive"]));
  });
});
