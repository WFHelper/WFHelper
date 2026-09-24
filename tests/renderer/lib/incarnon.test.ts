import { describe, expect, it } from "vitest";

import {
  buildIncarnonWeapons,
  filterIncarnon,
  incarnonByName,
  incarnonFor,
  summarizeIncarnon,
  type IncarnonWeapon,
} from "../../../src/lib/incarnon.js";
import { CIRCUIT_HARD_ROTATION } from "../../../src/lib/world.js";
import type { ItemDbEntry, RawInventoryData } from "../../../src/types/inventory.js";
import {
  ACK,
  ACK_ADAPTER,
  BRATON,
  CIRCUIT_DB,
  CIRCUIT_INVENTORY,
  LATO,
  LATO_ADAPTER,
  PHENMOR,
  TORID,
  TORID_ADAPTER,
} from "../../fixtures/world/circuitFixture.js";

const LAETUM = "/Lotus/Weapons/Tenno/Zariman/Pistols/HeavyPistol/ZarimanHeavyPistol";
const LAETUM_BP = "/Lotus/Types/Recipes/Weapons/ZarimanHeavyPistolBlueprint";
const ONOS = "/Lotus/Weapons/Thanotech/EntratiWristGun/EntratiWristGunWeapon";

const DB: Record<string, ItemDbEntry> = {
  ...CIRCUIT_DB,
  [LAETUM]: {
    name: "Laetum",
    imageUrl: "laetum.png",
    category: "Weapon",
    productCategory: "Pistols",
    incarnon: true,
  },
  [LAETUM_BP]: { name: "Laetum Blueprint", buildsProduct: LAETUM },
  [ONOS]: { name: "Onos", imageUrl: "onos.png", category: "Weapon", productCategory: "Pistols" },
};

const INVENTORY: RawInventoryData = {
  ...CIRCUIT_INVENTORY,
  LongGuns: [...(CIRCUIT_INVENTORY.LongGuns ?? []), { ItemType: PHENMOR }],
  Pistols: [{ ItemType: LATO }, { ItemType: ONOS }],
  Recipes: [{ ItemType: LAETUM_BP, ItemCount: 1 }],
  EvolutionProgress: [
    // Genesis progress is keyed on the base weapon even when a variant holds the adapter.
    { ItemType: BRATON, Rank: 4, Progress: 0 },
    { ItemType: ONOS, Rank: 1, Progress: 12 },
    { ItemType: PHENMOR, Rank: 0, Progress: 30 },
    { ItemType: "/Lotus/Unknown/Thing", Rank: 2, Progress: 0 },
    { ItemType: TORID, Rank: "x" },
  ],
};

function byName(weapons: IncarnonWeapon[], name: string): IncarnonWeapon {
  const weapon = weapons.find((w) => w.name === name);
  if (!weapon) throw new Error(`missing ${name}`);
  return weapon;
}

describe("buildIncarnonWeapons", () => {
  const weapons = buildIncarnonWeapons(DB, INVENTORY, [
    "Braton",
    "Lato",
    "Skana",
    "Paris",
    "Kunai",
  ]);

  it("lists every Circuit Genesis weapon even when the item DB lacks it", () => {
    const genesis = weapons.filter((w) => w.kind === "genesis");
    const rotationCount = CIRCUIT_HARD_ROTATION.flat().length;

    expect(genesis).toHaveLength(rotationCount);
    const kunai = byName(weapons, "Kunai");
    expect(kunai.uniqueName).toBe("");
    expect(kunai.status).toBe("missing");
  });

  it("reads an adapter installed on a variant as unlocked with its evolution", () => {
    const braton = byName(weapons, "Braton");

    expect(braton).toMatchObject({
      uniqueName: BRATON,
      imageUrl: "braton-incarnon.png",
      slot: "primary",
      weaponOwned: true,
      unlocked: true,
      evolution: 5,
      circuitWeeks: 0,
      status: "unlocked",
    });
  });

  it("counts spare adapters without calling them installed", () => {
    const torid = byName(weapons, "Torid");

    expect(torid).toMatchObject({
      uniqueName: TORID,
      adapterCount: 2,
      weaponOwned: true,
      unlocked: false,
      status: "adapter",
    });
    expect(torid.evolution).toBeUndefined();
  });

  it("counts only positive adapter stacks as spares", () => {
    const stale = buildIncarnonWeapons(DB, {
      MiscItems: [
        { ItemType: TORID_ADAPTER, ItemCount: 0 },
        { ItemType: LATO_ADAPTER, ItemCount: -1 },
        { ItemType: ACK_ADAPTER },
      ],
    });

    expect(stale.filter((w) => w.adapterCount > 0 || w.status !== "missing")).toEqual([]);
  });

  it("keeps an owned weapon without an adapter missing", () => {
    const lato = byName(weapons, "Lato");

    expect(lato).toMatchObject({
      uniqueName: LATO,
      slot: "secondary",
      weaponOwned: true,
      adapterCount: 0,
      status: "missing",
    });
  });

  it("uses the English base name for a symbol-spelled weapon", () => {
    const ack = byName(weapons, "Ack & Brunt");

    expect(ack.uniqueName).toBe(ACK);
    expect(ack.slot).toBe("melee");
  });

  it("places each Genesis weapon in the Steel Path rotation", () => {
    expect(byName(weapons, "Boar").circuitWeeks).toBe(1);
    expect(byName(weapons, "Vectis").circuitWeeks).toBe(8);
  });

  it("counts Circuit weeks from the live Steel Path choices and wraps around", () => {
    const lastWeek = buildIncarnonWeapons(DB, null, [
      "Vectis",
      "Stug",
      "Ballistica",
      "Destreza",
      "Obex",
    ]);

    expect(byName(lastWeek, "Obex").circuitWeeks).toBe(0);
    expect(byName(lastWeek, "Braton").circuitWeeks).toBe(1);
    expect(byName(lastWeek, "Dera").circuitWeeks).toBe(8);
  });

  it("marks only the live picks when the rotation cannot be placed", () => {
    const unplaced = buildIncarnonWeapons(DB, null, ["Braton"]);

    expect(unplaced.filter((w) => w.circuitWeeks !== undefined).map((w) => w.name)).toEqual([
      "Braton",
    ]);
    expect(byName(unplaced, "Braton").circuitWeeks).toBe(0);
  });

  it("adds native Incarnon weapons from the item DB flag and from EvolutionProgress", () => {
    const natives = weapons.filter((w) => w.kind === "native").map((w) => w.name);

    expect(natives.sort()).toEqual(["Laetum", "Onos", "Phenmor"]);
    expect(byName(weapons, "Phenmor")).toMatchObject({
      weaponOwned: true,
      unlocked: true,
      evolution: 1,
      status: "unlocked",
    });
    expect(byName(weapons, "Onos")).toMatchObject({ slot: "secondary", evolution: 2 });
  });

  it("flags a native blueprint only while the weapon itself is missing", () => {
    const laetum = byName(weapons, "Laetum");

    expect(laetum).toMatchObject({ status: "missing", blueprintOwned: true, weaponOwned: false });
    expect(byName(weapons, "Phenmor").blueprintOwned).toBeUndefined();
  });

  it("sorts Genesis before native, then by slot and name", () => {
    const kinds = weapons.map((w) => w.kind);
    expect(kinds.indexOf("native")).toBe(kinds.lastIndexOf("genesis") + 1);
    const primaries = weapons.filter((w) => w.kind === "genesis" && w.slot === "primary");
    const names = primaries.map((w) => w.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("returns every weapon missing without an inventory", () => {
    const empty = buildIncarnonWeapons(DB, null);

    expect(empty.every((w) => w.status === "missing" && !w.weaponOwned)).toBe(true);
    expect(empty.some((w) => w.circuitWeeks !== undefined)).toBe(false);
  });
});

describe("incarnon helpers", () => {
  const weapons = buildIncarnonWeapons(DB, INVENTORY, []);

  it("summarizes and filters by status", () => {
    const summary = summarizeIncarnon(weapons);

    expect(summary).toEqual({
      total: weapons.length,
      unlocked: filterIncarnon(weapons, "unlocked").length,
    });
    expect(filterIncarnon(weapons, "adapter").map((w) => w.name)).toEqual(["Torid"]);
    expect(filterIncarnon(weapons, "all")).toHaveLength(weapons.length);
  });

  it("looks Circuit choice names up in either spelling", () => {
    const lookup = incarnonByName(weapons);

    expect(incarnonFor(lookup, "Ack And Brunt")?.uniqueName).toBe(ACK);
    expect(incarnonFor(lookup, "Excalibur")).toBeNull();
  });
});
