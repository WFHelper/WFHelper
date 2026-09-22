import { describe, expect, it } from "vitest";
import { normalizeRewardPresentation } from "../../config/shared/rewardPresentation";

function presentation() {
  return {
    count: 1,
    slots: [
      null,
      {
        item: {
          name: "Sevagoth Prime Neuroptics Blueprint",
          rarity: "rare",
          ducats: 100,
          partOwnedCount: 3,
          partRequiredCount: 1,
          mastered: false,
          vaulted: true,
          building: true,
          setOwnedCount: 2,
          setRequiredCount: 4,
          setUrlName: "sevagoth_prime_set",
          setParts: [
            {
              name: "Neuroptics",
              imageUrl: "https://assets.wfhelper.com/test.png",
              ownedCount: 3,
              requiredCount: 1,
              isReward: true,
              building: true,
            },
          ],
          privateData: { playerName: "must not persist" },
        },
        price: 245,
        setPrice: 620,
      },
      null,
      null,
    ],
    secret: "must not persist",
  };
}

describe("completed reward presentation boundary", () => {
  it("keeps a canonical market slug containing a hyphen", () => {
    const input = presentation();
    input.slots[1]!.item.setUrlName = "ak-47_prime_set";
    expect(normalizeRewardPresentation(input)?.slots[1]?.item.setUrlName).toBe("ak-47_prime_set");
  });
  it("copies rendered fields with gaps, strips unrelated data and isolates later edits", () => {
    const input = presentation();
    const saved = normalizeRewardPresentation(input);
    expect(saved?.count).toBe(1);
    expect(saved?.slots.map((slot) => slot?.item.name ?? null)).toEqual([
      null,
      "Sevagoth Prime Neuroptics Blueprint",
      null,
      null,
    ]);
    expect(saved?.slots[1]?.item).toMatchObject({
      mastered: false,
      vaulted: true,
      building: true,
      partOwnedCount: 3,
    });
    expect(JSON.stringify(saved)).not.toContain("must not persist");
    input.slots[1]!.item.name = "Replaced";
    input.slots[1]!.item.setParts[0]!.ownedCount = 99;
    expect(saved?.slots[1]?.item.name).toBe("Sevagoth Prime Neuroptics Blueprint");
    expect(saved?.slots[1]?.item.setParts[0]?.ownedCount).toBe(3);
  });

  it("omits the optional flags a scan never resolved", () => {
    const input = presentation();
    const slot = input.slots[1]!;
    const { mastered: _mastered, vaulted: _vaulted, ...item } = slot.item;
    const saved = normalizeRewardPresentation({
      ...input,
      slots: [null, { ...slot, item }, null, null],
    });
    const keys = Object.keys(saved?.slots[1]?.item ?? {});
    expect(saved?.slots[1]?.item.name).toBe("Sevagoth Prime Neuroptics Blueprint");
    expect(keys).not.toContain("mastered");
    expect(keys).not.toContain("vaulted");
  });

  it.each([0, 2, 5, NaN, "1"])(
    "rejects a count inconsistent with the four positional slots: %s",
    (count) => {
      expect(normalizeRewardPresentation({ ...presentation(), count })).toBeNull();
    },
  );

  it("rejects oversized collections and invalid price or item fields", () => {
    const input = presentation();
    expect(normalizeRewardPresentation({ ...input, slots: [...input.slots, null] })).toBeNull();
    const slot = input.slots[1]!;
    for (const price of [-1, NaN, Infinity, "245", 1e10]) {
      expect(
        normalizeRewardPresentation({ ...input, slots: [null, { ...slot, price }, null, null] }),
      ).toBeNull();
    }
    for (const patch of [
      { name: "x".repeat(201) },
      { name: "bad\nname" },
      { mastered: "true" },
      { vaulted: "true" },
      { setParts: Array(7).fill(slot.item.setParts[0]) },
      { setParts: [{ ...slot.item.setParts[0], imageUrl: "file:///private.png" }] },
      { setParts: [{ ...slot.item.setParts[0], ownedCount: Infinity }] },
    ]) {
      expect(
        normalizeRewardPresentation({
          ...input,
          slots: [null, { ...slot, item: { ...slot.item, ...patch } }, null, null],
        }),
      ).toBeNull();
    }
  });
});
