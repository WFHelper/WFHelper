import { describe, expect, it, vi } from "vitest";

import { RELIC_REWARD_ITEMS } from "../../config/shared/ipcChannels";
import { createOverlayScanController } from "../../ipc/overlay/scan";

const PARENT = "/Lotus/Powersuits/Odalisk/ProteaPrime";
const RECIPES = "/Lotus/Types/Recipes/WarframeRecipes";
const CHASSIS = `${RECIPES}/ProteaPrimeChassisComponent`;

const FORMA = "/Lotus/Types/Items/MiscItems/Forma";
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";

// The set lists parts as ...Component; the inventory holds the ...Blueprint recipes.
const ITEM_DB: Record<string, Record<string, unknown>> = {
  [FORMA]: { uniqueName: FORMA, name: "Forma", category: "Misc" },
  [FORMA_BP]: { uniqueName: FORMA_BP, name: "Forma Blueprint", componentOf: FORMA },
  [CHASSIS]: { uniqueName: CHASSIS, name: "Protea Prime Chassis Blueprint", componentOf: PARENT },
  [PARENT]: {
    uniqueName: PARENT,
    name: "Protea Prime",
    category: "Warframe",
    components: [
      { name: "Blueprint", uniqueName: `${RECIPES}/ProteaPrimeBlueprint`, itemCount: 1 },
      { name: "Chassis", uniqueName: CHASSIS, itemCount: 1 },
      { name: "Neuroptics", uniqueName: `${RECIPES}/ProteaPrimeHelmetComponent`, itemCount: 1 },
      { name: "Systems", uniqueName: `${RECIPES}/ProteaPrimeSystemsComponent`, itemCount: 1 },
      {
        name: "Orokin Cell",
        uniqueName: "/Lotus/Types/Items/MiscItems/OrokinCell",
        itemCount: 5,
        tradable: false,
      },
    ],
  },
};

vi.mock("../../services/itemDatabase", () => ({
  localizedNameFields: () => ({}),
  lookupItem: (uniqueName: string) => ITEM_DB[uniqueName] || null,
  lookupItemByNameOrSlug: (name: string) =>
    Object.values(ITEM_DB).find((entry) => entry.name === name) || null,
  isReusableBlueprint: () => false,
  getAllItems: () => ITEM_DB,
}));

const noop = () => {};

async function scanWithInventory(
  recipes: Array<{ ItemType: string; ItemCount: number }>,
  pendingRecipes: Array<{ ItemType: string }> = [],
  extraInventory: Record<string, unknown> = {},
  rewardName = "Protea Prime Chassis Blueprint",
  poolFields: Record<string, unknown> = {},
) {
  const events: Array<{ channel: string; payload: unknown }> = [];

  const controller = createOverlayScanController({
    log: { info: noop, warn: noop, error: noop },
    rewardScanner: {
      scanRewardsDetailed: async () => ({
        items: [{ name: rewardName, ...poolFields }],
        meta: null,
      }),
    },
    ctx: {
      overlaySettings: {},
      overlayWindow: null,
      currentInventoryData: {
        MiscItems: [],
        Recipes: recipes,
        PendingRecipes: pendingRecipes,
        ...extraInventory,
      },
    },
    windows: {
      setAnchorMeta: noop,
      getAnchorMeta: () => null,
      positionOverlayWindow: noop,
      sendOverlayEvent: (channel: string, payload?: unknown) => events.push({ channel, payload }),
      scheduleOverlayAutoHide: noop,
      clearOverlayAutoHideTimer: noop,
      createOverlayWindow: noop,
    },
  });

  await controller.dispatchRewardScan("manual");
  const items = events.find((event) => event.channel === RELIC_REWARD_ITEMS)?.payload;
  return (Array.isArray(items) ? items[0] : null) as Record<string, unknown> | null;
}

describe("overlay set progress", () => {
  it("counts set parts the inventory holds under their blueprint names", async () => {
    const item = await scanWithInventory([
      { ItemType: `${RECIPES}/ProteaPrimeBlueprint`, ItemCount: 11 },
      { ItemType: `${RECIPES}/ProteaPrimeChassisBlueprint`, ItemCount: 5 },
      { ItemType: `${RECIPES}/ProteaPrimeHelmetBlueprint`, ItemCount: 2 },
    ]);

    const parts = item?.setParts as Array<{ ownedCount: number }>;

    expect(item?.partOwnedCount).toBe(5);
    expect(item?.setOwnedCount).toBe(3);
    expect(item?.setRequiredCount).toBe(4);
    expect(parts.map((part) => part.ownedCount)).toEqual([11, 5, 2, 0]);
  });

  it("marks the reward and its part as building while the foundry holds it", async () => {
    const item = await scanWithInventory(
      [
        { ItemType: `${RECIPES}/ProteaPrimeChassisBlueprint`, ItemCount: 1 },
        { ItemType: `${RECIPES}/ProteaPrimeHelmetBlueprint`, ItemCount: 1 },
      ],
      [{ ItemType: `${RECIPES}/ProteaPrimeChassisBlueprint` }],
    );

    const parts = item?.setParts as Array<{ building: boolean; ownedCount: number }>;

    expect(item?.building).toBe(true);
    expect(item?.partOwnedCount).toBe(0);
    expect(parts.map((part) => part.building)).toEqual([false, true, false, false]);
    expect(item?.setOwnedCount).toBe(1);
  });

  it("leaves the building flag off when nothing is in the foundry", async () => {
    const item = await scanWithInventory([
      { ItemType: `${RECIPES}/ProteaPrimeChassisBlueprint`, ItemCount: 1 },
    ]);

    const parts = item?.setParts as Array<{ building: boolean }>;

    expect(item?.building).toBeUndefined();
    expect(parts.every((part) => part.building === false)).toBe(true);
  });

  it("leaves genuinely missing parts at zero", async () => {
    const item = await scanWithInventory([
      { ItemType: `${RECIPES}/ProteaPrimeChassisBlueprint`, ItemCount: 1 },
    ]);

    expect(item?.setOwnedCount).toBe(1);
    expect(item?.completeSetCount).toBe(0);
  });
});

describe("overlay mastery status", () => {
  it("marks rewards whose equipment is mastered", async () => {
    // Suits use 1000 affinity per rank squared: 30^2 * 1000 = rank 30.
    const item = await scanWithInventory([], [], { Suits: [{ ItemType: PARENT, XP: 900_000 }] });

    expect(item?.mastered).toBe(true);
  });

  it("marks rewards whose equipment is unmastered, leveling or missing", async () => {
    const leveling = await scanWithInventory([], [], {
      Suits: [{ ItemType: PARENT, XP: 400_000 }],
    });
    const missing = await scanWithInventory([]);

    expect(leveling?.mastered).toBe(false);
    expect(missing?.mastered).toBe(false);
  });

  it("adds no mastery flag to rewards without masterable equipment", async () => {
    const item = await scanWithInventory([], [], {}, "Forma Blueprint");

    expect(item?.mastered).toBeUndefined();
    expect(item?.partOwnedCount).toBe(0);
  });
});

describe("overlay set chip", () => {
  it("offers no set for a reward whose parent has no tradable parts", async () => {
    // Forma Blueprint builds into Forma; forma_set is no warframe.market item,
    // so the chip could only ever sit at "Set ...".
    const item = await scanWithInventory([], [], {}, "Forma Blueprint");

    expect(item?.setName).toBeUndefined();
    expect(item?.setUrlName).toBeUndefined();
    expect(item?.setParts).toBeUndefined();
  });

  it("keeps the set of a reward built from several tradable parts", async () => {
    const item = await scanWithInventory([]);

    expect(item?.setName).toBe("Protea Prime Set");
    expect(item?.setUrlName).toBe("protea_prime_set");
    expect((item?.setParts as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("overlay vaulting", () => {
  it("passes the relic pool's vaulting through to the card", async () => {
    for (const vaulted of [true, false]) {
      const item = await scanWithInventory([], [], {}, "Protea Prime Chassis Blueprint", {
        vaulted,
      });
      expect(item?.vaulted).toBe(vaulted);
    }
  });

  it("omits vaulting the pool never resolved", async () => {
    const unknown = await scanWithInventory([], [], {}, "Protea Prime Chassis Blueprint");
    const malformed = await scanWithInventory([], [], {}, "Protea Prime Chassis Blueprint", {
      vaulted: "yes",
    });

    expect("vaulted" in (unknown ?? {})).toBe(false);
    expect("vaulted" in (malformed ?? {})).toBe(false);
  });
});
