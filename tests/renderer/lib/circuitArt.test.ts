import { describe, expect, it } from "vitest";

import {
  buildFeaturedPrimes,
  circuitChoiceKey,
  circuitChoices,
  resolveCircuitChoices,
  resolveVendorItems,
} from "../../../src/lib/world.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

const TORID = "/Lotus/Weapons/Tenno/LongGuns/Torid";
const ADAPTER = "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Primary/ToridIncarnonUnlocker";
const EXCALIBUR = "/Lotus/Powersuits/Excalibur/Excalibur";
const ASH = "/Lotus/Powersuits/Ninja/Ninja";
const ASH_PRIME = "/Lotus/Powersuits/Ninja/NinjaPrime";

const DB: Record<string, ItemDbEntry> = {
  [TORID]: { name: "Torid", imageUrl: "torid-base.png", category: "Primary" },
  [ADAPTER]: {
    name: "Torid Incarnon Genesis",
    imageUrl: "torid-incarnon.png",
    category: "Misc",
  },
  [`${ADAPTER}Blueprint`]: {
    name: "Torid Incarnon Genesis Blueprint",
    imageUrl: "torid-incarnon-bp.png",
  },
  [EXCALIBUR]: { name: "Excalibur", imageUrl: "excalibur.png", category: "Warframe" },
  [ASH]: { name: "Ash", imageUrl: "ash.png", category: "Warframe" },
  [ASH_PRIME]: { name: "Ash Prime", imageUrl: "ash-prime.png", category: "Warframe" },
};

describe("circuit choice art", () => {
  it("shows the Incarnon Genesis art for a Steel Path weapon", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, null);

    expect(torid.imageUrl).toBe("torid-incarnon.png");
    expect(torid.uniqueName).toBe(TORID);
  });

  // One name field cannot serve both the English join key and the label the view
  // draws, so the circuit row has to carry each separately.
  it("carries the localized name without losing the English one", () => {
    const localized: Record<string, ItemDbEntry> = {
      ...DB,
      [TORID]: { ...DB[TORID], displayName: "토리드" },
    };

    const [torid] = resolveCircuitChoices(["Torid"], localized, null);

    expect(torid.name).toBe("Torid");
    expect(torid.displayName).toBe("토리드");
  });

  it("does not mark an adapter owned just because the weapon is", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, { LongGuns: [{ ItemType: TORID }] });

    expect(torid.owned).toBe(false);
  });

  it("marks the adapter owned from a spare unlocker in MiscItems", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, {
      MiscItems: [{ ItemType: ADAPTER }],
    });

    expect(torid.owned).toBe(true);
  });

  it("marks the adapter owned when installed on a weapon variant", () => {
    const PRIME_TORID = "/Lotus/Weapons/Tenno/LongGuns/PrimeTorid";
    const db = {
      ...DB,
      [PRIME_TORID]: {
        name: "Torid Prime",
        imageUrl: "torid-prime.png",
        category: "Primary" as const,
      },
    };
    const installed = resolveCircuitChoices(["Torid"], db, {
      LongGuns: [{ ItemType: PRIME_TORID, Features: 547 }],
    });
    const uninstalled = resolveCircuitChoices(["Torid"], db, {
      LongGuns: [{ ItemType: PRIME_TORID, Features: 35 }],
    });

    expect(installed[0].owned).toBe(true);
    expect(uninstalled[0].owned).toBe(false);
  });

  it("tracks vendor-strip adapter stock the same way", () => {
    const [without] = resolveVendorItems([ADAPTER], DB, { LongGuns: [{ ItemType: TORID }] });
    const [withSpare] = resolveVendorItems([ADAPTER], DB, { MiscItems: [{ ItemType: ADAPTER }] });

    expect(without.owned).toBe(false);
    expect(withSpare.owned).toBe(true);
  });

  it("leaves warframes on their own portrait", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, null);

    expect(frame.imageUrl).toBe("excalibur.png");
  });

  it("matches warframestat's 'And' spelling against DE's '&' names", () => {
    const ACK = "/Lotus/Weapons/Tenno/Melee/Sword/AckAndBrunt";
    const db = { ...DB, [ACK]: { name: "Ack & Brunt", imageUrl: "ack.png", category: "Melee" } };

    const [ack] = resolveCircuitChoices(["Ack And Brunt"], db, null);

    expect(ack.uniqueName).toBe(ACK);
    expect(ack.name).toBe("Ack & Brunt");
    expect(ack.imageUrl).toBe("ack.png");
  });
});

const SUBSUMED_INVENTORY = {
  InfestedFoundry: { ConsumedSuits: [{ s: EXCALIBUR }] },
};

describe("subsumed circuit frames", () => {
  it("keeps a subsumed frame owned and flags it", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, SUBSUMED_INVENTORY);

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBe(true);
  });

  it("leaves a frame held in Suits unflagged", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, {
      Suits: [{ ItemType: EXCALIBUR }],
    });

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBeUndefined();
  });

  it("never flags a weapon", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, SUBSUMED_INVENTORY);

    expect(torid.subsumed).toBeUndefined();
  });

  it("flags vendor stock the same way", () => {
    const [frame] = resolveVendorItems([EXCALIBUR], DB, SUBSUMED_INVENTORY);

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBe(true);
  });

  // DE writes the consumed suit under ItemType as well as `s`, and the path only
  // names the frame ("Ninja" for Ash), so the flag has to survive both.
  it("reads a consumed suit written as ItemType", () => {
    const [frame] = resolveVendorItems([ASH], DB, {
      InfestedFoundry: { ConsumedSuits: [{ ItemType: ASH }] },
    });

    expect(frame.subsumed).toBe(true);
  });

  it("leaves a Prime unflagged when only its base frame was fed", () => {
    const [frame] = resolveVendorItems([ASH_PRIME], DB, {
      InfestedFoundry: { ConsumedSuits: [{ s: ASH }] },
    });

    expect(frame.subsumed).toBeUndefined();
    expect(frame.owned).toBe(false);
  });

  it("flags the Prime that was itself fed", () => {
    const [frame] = resolveVendorItems([ASH_PRIME], DB, {
      InfestedFoundry: { ConsumedSuits: [{ s: ASH_PRIME }] },
    });

    expect(frame.subsumed).toBe(true);
    expect(frame.owned).toBe(true);
  });
});

describe("Prime Resurgence strip", () => {
  const varzia = { inventory: [{ uniqueName: ASH_PRIME, item: "Ash Prime" }] };

  it("marks a subsumed frame like the circuit and vendor strips", () => {
    const [prime] = buildFeaturedPrimes(
      varzia,
      { InfestedFoundry: { ConsumedSuits: [{ s: ASH_PRIME }] } },
      DB,
    );

    expect(prime.subsumed).toBe(true);
    expect(prime.owned).toBe(true);
  });

  it("leaves an unfed Prime alone", () => {
    const [prime] = buildFeaturedPrimes(
      varzia,
      { InfestedFoundry: { ConsumedSuits: [{ s: ASH }] } },
      DB,
    );

    expect(prime.subsumed).toBeUndefined();
    expect(prime.owned).toBe(false);
  });
});

describe("circuit choice extraction", () => {
  const wd = {
    duviriCycle: {
      choices: [
        { category: "normal", choices: ["Excalibur"] },
        { category: "hard", choices: ["Torid"] },
      ],
    },
  };

  it("picks the requested category", () => {
    expect(circuitChoices(wd as never, "normal")).toEqual(["Excalibur"]);
    expect(circuitChoices(wd as never, "hard")).toEqual(["Torid"]);
  });

  it("reads a missing group as no data", () => {
    expect(circuitChoices(null, "normal")).toEqual([]);
    expect(circuitChoices(wd as never, "nope")).toEqual([]);
  });
});

describe("circuitChoiceKey", () => {
  it("keys resolved choices on the uniqueName", () => {
    expect(circuitChoiceKey({ uniqueName: TORID, name: "Torid" })).toBe(TORID);
  });

  it("falls back to the name so an empty item DB yields distinct keys", () => {
    const choices = resolveCircuitChoices(["Torid", "Boltor"], {}, null);
    const keys = choices.map(circuitChoiceKey);
    expect(choices.every((choice) => choice.uniqueName === "")).toBe(true);
    expect(new Set(keys).size).toBe(choices.length);
  });
});
