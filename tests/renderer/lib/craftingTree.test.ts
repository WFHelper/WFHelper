import { describe, expect, it } from "vitest";

import {
  MAX_EXPAND_DEPTH,
  applyCraftingTreeFilters,
  buildCraftingTree,
  canExpandCraftingNode,
  computeCraftingSummary,
  expandCraftingNode,
  expandedChildAncestors,
  filterExpandedChildren,
} from "../../../src/lib/craftingTree.js";
import type { CraftingTreeNode } from "../../../src/lib/craftingTree.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

function item(name: string, recipe?: ItemDbEntry["recipe"]): ItemDbEntry {
  return {
    name,
    uniqueName: `/items/${name}`,
    category: "Weapon",
    productCategory: "Pistols",
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: false,
    keywords: [],
    components: [],
    ...(recipe ? { recipe } : {}),
  };
}

describe("crafting tree", () => {
  it("merges duplicate recipe ingredients into one counted child", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Akbolto": item("Akbolto", {
        blueprintUniqueName: "/blueprints/Akbolto",
        buildPrice: 20_000,
        buildTime: 43_200,
        num: 1,
        ingredients: [
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/resources/OrokinCell", count: 1 },
        ],
      }),
      "/items/Bolto": item("Bolto"),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/Akbolto": item("Akbolto Blueprint"),
    };

    const tree = buildCraftingTree("/items/Akbolto", db, new Map());

    const boltoChildren = tree?.children.filter((child) => child.uniqueName === "/items/Bolto");
    expect(boltoChildren).toHaveLength(1);
    expect(boltoChildren?.[0].count).toBe(2);
  });

  it("needs one blueprint total when the recipe blueprint is reusable", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/AkTwin": item("AkTwin", {
        blueprintUniqueName: "/blueprints/AkTwin",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/Solo", count: 2 }],
      }),
      "/items/Solo": item("Solo", {
        blueprintUniqueName: "/blueprints/Solo",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        reusableBlueprint: true,
        ingredients: [{ uniqueName: "/resources/OrokinCell", count: 1 }],
      }),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/AkTwin": item("AkTwin Blueprint"),
      "/blueprints/Solo": item("Solo Blueprint"),
    };

    const tree = buildCraftingTree("/items/AkTwin", db, new Map([["/blueprints/Solo", 1]]));
    const solo = tree?.children.find((child) => child.uniqueName === "/items/Solo");
    const soloBp = solo?.children.find((child) => child.uniqueName === "/blueprints/Solo");

    expect(solo?.count).toBe(2);
    expect(soloBp?.count).toBe(1);
    expect(soloBp?.missing).toBe(0);
    expect(soloBp?.isBlueprintItem).toBe(true);

    const akBp = tree?.children.find((child) => child.uniqueName === "/blueprints/AkTwin");
    expect(akBp?.count).toBe(1);
  });

  it("does not list a part component and its blueprint as two children", () => {
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisComponent";
    const chassisBp = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/items/CalibanPrime": item("Caliban Prime", {
        blueprintUniqueName: "/blueprints/CalibanPrime",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: item("Caliban Prime Chassis Blueprint", {
        blueprintUniqueName: chassisBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/resources/Rubedo", count: 1600 }],
      }),
      "/resources/Rubedo": item("Rubedo"),
      "/blueprints/CalibanPrime": item("Caliban Prime Blueprint"),
      [chassisBp]: item("Caliban Prime Chassis Blueprint"),
    };

    // The inventory holds the blueprint spelling; the recipe names the component.
    const tree = buildCraftingTree("/items/CalibanPrime", db, new Map([[chassisBp, 3]]));
    const chassisNode = tree?.children.find((child) => child.uniqueName === chassis);

    expect(chassisNode?.owned).toBe(3);
    expect(chassisNode?.children.map((child) => child.uniqueName)).toEqual(["/resources/Rubedo"]);
    // The main blueprint is a separate item and still shows.
    expect(tree?.children.some((child) => child.uniqueName === "/blueprints/CalibanPrime")).toBe(
      true,
    );
  });

  it("stops recursive recipe cycles at the repeated ingredient", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/A": item("A", {
        blueprintUniqueName: "/blueprints/A",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/B", count: 1 }],
      }),
      "/items/B": item("B", {
        blueprintUniqueName: "/blueprints/B",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/A", count: 1 }],
      }),
      "/blueprints/A": item("A Blueprint"),
      "/blueprints/B": item("B Blueprint"),
    };

    const tree = buildCraftingTree("/items/A", db, new Map());
    const repeatedA = tree?.children
      .find((child) => child.uniqueName === "/items/B")
      ?.children.find((child) => child.uniqueName === "/items/A");

    expect(repeatedA?.recipe).toBeNull();
    expect(repeatedA?.children).toHaveLength(0);
  });

  it("scales ingredients by recipe runs when a run yields several units", () => {
    // Real case: Caliban needs 100 Hespazym Alloy; the alloy recipe yields 20
    // per run, so 5 runs consume 1500 Plastids, not 30000.
    const db: Record<string, ItemDbEntry> = {
      "/items/Caliban": item("Caliban", {
        blueprintUniqueName: "/blueprints/Caliban",
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/HespazymAlloy", count: 100 }],
      }),
      "/items/HespazymAlloy": item("Hespazym Alloy", {
        blueprintUniqueName: "/blueprints/HespazymAlloy",
        buildPrice: 200,
        buildTime: 60,
        num: 20,
        reusableBlueprint: true,
        ingredients: [
          { uniqueName: "/resources/Plastids", count: 300 },
          { uniqueName: "/items/Hesperon", count: 20 },
          { uniqueName: "/resources/Morphics", count: 2 },
        ],
      }),
      "/items/Hesperon": item("Hesperon"),
      "/resources/Plastids": item("Plastids"),
      "/resources/Morphics": item("Morphics"),
      "/blueprints/Caliban": item("Caliban Blueprint"),
      "/blueprints/HespazymAlloy": item("Hespazym Alloy Blueprint"),
    };

    const tree = buildCraftingTree("/items/Caliban", db, new Map());
    const alloy = tree?.children.find((child) => child.uniqueName === "/items/HespazymAlloy");
    const byName = (un: string) => alloy?.children.find((child) => child.uniqueName === un);

    expect(alloy?.count).toBe(100);
    expect(byName("/resources/Plastids")?.count).toBe(1500);
    expect(byName("/items/Hesperon")?.count).toBe(100);
    expect(byName("/resources/Morphics")?.count).toBe(10);
    expect(byName("/blueprints/HespazymAlloy")?.count).toBe(1);

    const summary = computeCraftingSummary(tree!);
    // 25000 for Caliban plus 5 alloy runs at 200 credits and 60s each.
    expect(summary.totalCredits).toBe(25_000 + 5 * 200);
    expect(summary.maxBuildTime).toBe(5 * 60);
  });

  it("needs one consumable blueprint per run, not per unit", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Batch": item("Batch", {
        blueprintUniqueName: "/blueprints/Batch",
        buildPrice: 0,
        buildTime: 0,
        num: 10,
        ingredients: [{ uniqueName: "/resources/Plastids", count: 5 }],
      }),
      "/items/Parent": item("Parent", {
        blueprintUniqueName: "/blueprints/Parent",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/Batch", count: 25 }],
      }),
      "/resources/Plastids": item("Plastids"),
      "/blueprints/Batch": item("Batch Blueprint"),
      "/blueprints/Parent": item("Parent Blueprint"),
    };

    const tree = buildCraftingTree("/items/Parent", db, new Map());
    const batch = tree?.children.find((child) => child.uniqueName === "/items/Batch");
    const batchBp = batch?.children.find((child) => child.uniqueName === "/blueprints/Batch");

    // 25 units at 10 per run = 3 runs = 3 blueprints and 15 Plastids.
    expect(batchBp?.count).toBe(3);
    expect(batch?.children.find((child) => child.uniqueName === "/resources/Plastids")?.count).toBe(
      15,
    );
  });
});

const WEAPON = "/Lotus/Weapons/Tenno/LongGun/Sepulcrum";
const WEAPON_BP = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumBlueprint";
const RECEIVER = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumReceiverComponent";
const RECEIVER_BP = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumReceiverBlueprint";
const FORMA = "/Lotus/Types/Items/MiscItems/Forma";
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const ALLOY = "/Lotus/Types/Items/MiscItems/HespazymAlloy";
const ALLOY_BP = "/Lotus/Types/Recipes/Components/HespazymAlloyBlueprint";
const RUBEDO = "/Lotus/Types/Items/MiscItems/Rubedo";
const MORPHICS = "/Lotus/Types/Items/MiscItems/Morphic";

/** A weapon whose receiver is craftable and whose Forma sits behind the leaf rule. */
function expandableDb(): Record<string, ItemDbEntry> {
  return {
    [WEAPON]: item("Sepulcrum", {
      blueprintUniqueName: WEAPON_BP,
      buildPrice: 25_000,
      buildTime: 43_200,
      num: 1,
      ingredients: [
        { uniqueName: RECEIVER, count: 1 },
        { uniqueName: FORMA, count: 3 },
        { uniqueName: ALLOY, count: 100 },
      ],
    }),
    [RECEIVER]: item("Sepulcrum Receiver Blueprint", {
      blueprintUniqueName: RECEIVER_BP,
      buildPrice: 15_000,
      buildTime: 43_200,
      num: 1,
      ingredients: [{ uniqueName: RUBEDO, count: 1500 }],
    }),
    [FORMA]: item("Forma", {
      blueprintUniqueName: FORMA_BP,
      buildPrice: 0,
      buildTime: 86_400,
      num: 1,
      ingredients: [
        { uniqueName: MORPHICS, count: 1 },
        { uniqueName: RUBEDO, count: 500 },
      ],
    }),
    [ALLOY]: item("Hespazym Alloy", {
      blueprintUniqueName: ALLOY_BP,
      buildPrice: 200,
      buildTime: 60,
      num: 20,
      ingredients: [
        { uniqueName: RUBEDO, count: 300 },
        { uniqueName: MORPHICS, count: 2 },
      ],
    }),
    [RUBEDO]: item("Rubedo"),
    [MORPHICS]: item("Morphics"),
    [WEAPON_BP]: item("Sepulcrum Blueprint"),
    [RECEIVER_BP]: item("Sepulcrum Receiver Blueprint"),
    [FORMA_BP]: item("Forma Blueprint"),
    [ALLOY_BP]: item("Hespazym Alloy Blueprint"),
  };
}

function childOf(node: CraftingTreeNode | null | undefined, uniqueName: string) {
  return node?.children.find((child) => child.uniqueName === uniqueName);
}

/** A card the tree handed out with no children of its own yet. */
function looseNode(uniqueName: string, name: string): CraftingTreeNode {
  return {
    uniqueName,
    name,
    imageUrl: null,
    count: 1,
    owned: 0,
    missing: 1,
    isCraftable: false,
    recipe: null,
    usedFor: [],
    children: [],
  };
}

describe("crafting tree expansion", () => {
  it("marks resource nodes with their own recipe as expandable, resources without one not", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const forma = childOf(tree, FORMA)!;
    const rubedo = childOf(childOf(tree, RECEIVER), RUBEDO)!;

    expect(forma.children).toHaveLength(0);
    expect(canExpandCraftingNode(forma, db, [WEAPON])).toBe(true);
    expect(canExpandCraftingNode(rubedo, db, [WEAPON, RECEIVER])).toBe(false);
  });

  it("gives no chevron to a node the tree already expanded", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const receiver = childOf(tree, RECEIVER)!;

    expect(receiver.children.length).toBeGreaterThan(0);
    expect(canExpandCraftingNode(receiver, db, [WEAPON])).toBe(false);
  });

  it("never expands a blueprint back into the item it hangs under", () => {
    const db = expandableDb();
    // Blueprint entries carry buildsProduct, not a recipe of their own.
    db[WEAPON_BP] = { ...db[WEAPON_BP], buildsProduct: WEAPON };
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const weaponBp = childOf(tree, WEAPON_BP)!;

    expect(weaponBp.isBlueprintItem).toBe(true);
    expect(canExpandCraftingNode(weaponBp, db, [WEAPON])).toBe(false);
    expect(expandCraftingNode(weaponBp, db, new Map(), [WEAPON])).toEqual([]);
  });

  it("roots a blueprint node through buildsProduct instead of its own entry", () => {
    const db = expandableDb();
    db[FORMA_BP] = { ...db[FORMA_BP], buildsProduct: FORMA };
    const loose: CraftingTreeNode = {
      uniqueName: FORMA_BP,
      name: "Forma Blueprint",
      imageUrl: null,
      count: 1,
      owned: 0,
      missing: 1,
      isCraftable: false,
      recipe: null,
      usedFor: [],
      children: [],
    };

    expect(canExpandCraftingNode(loose, db, [WEAPON])).toBe(true);
    const children = expandCraftingNode(loose, db, new Map(), [WEAPON]);
    // The blueprint builds the product it was expanded into, so it must not
    // hang under itself.
    expect(children.map((child) => child.uniqueName).sort()).toEqual([MORPHICS, RUBEDO].sort());
    // The blueprint entry itself must stay recipe-free; parseFoundry scans that field.
    expect(db[FORMA_BP].recipe).toBeUndefined();
  });

  it("resolves the sub-recipe only when the node is expanded", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const forma = childOf(tree, FORMA)!;

    expect(forma.children).toHaveLength(0);
    expect(forma.recipe).toBeNull();

    const children = expandCraftingNode(forma, db, new Map(), [WEAPON]);
    expect(children.map((child) => child.uniqueName).sort()).toEqual(
      [FORMA_BP, MORPHICS, RUBEDO].sort(),
    );
    // Expanding builds nothing into the node the tree already handed out.
    expect(forma.children).toHaveLength(0);
  });

  it("divides expanded requirements by the recipe yield", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const alloy = childOf(tree, ALLOY)!;

    expect(alloy.count).toBe(100);
    const children = expandCraftingNode(alloy, db, new Map(), [WEAPON]);
    const byName = (un: string) => children.find((child) => child.uniqueName === un);

    // 100 units at 20 per run = 5 runs: 5 blueprints, 1500 Rubedo, 10 Morphics.
    expect(byName(ALLOY_BP)?.count).toBe(5);
    expect(byName(RUBEDO)?.count).toBe(1500);
    expect(byName(MORPHICS)?.count).toBe(10);
  });

  it("lists a sub-blueprint once, under the alias the inventory holds", () => {
    const db = expandableDb();
    // The recipe names the component; the owned pile is the blueprint spelling.
    db[FORMA] = {
      ...db[FORMA],
      recipe: { ...db[FORMA].recipe!, blueprintUniqueName: FORMA_BP },
    };
    const tree = buildCraftingTree(WEAPON, db, new Map([[FORMA_BP, 2]]))!;
    const forma = childOf(tree, FORMA)!;

    const children = expandCraftingNode(forma, db, new Map([[FORMA_BP, 2]]), [WEAPON]);
    const blueprints = children.filter((child) => child.uniqueName === FORMA_BP);
    expect(blueprints).toHaveLength(1);
    expect(blueprints[0].owned).toBe(2);
    expect(blueprints[0].isBlueprintItem).toBe(true);
  });

  it("does not repeat a component and its blueprint alias in one expansion", () => {
    const db = expandableDb();
    const componentSpelling = "/Lotus/Types/Items/MiscItems/WidgetComponent";
    const blueprintSpelling = "/Lotus/Types/Items/MiscItems/WidgetBlueprint";
    db[WEAPON] = {
      ...db[WEAPON],
      recipe: {
        ...db[WEAPON].recipe!,
        ingredients: [{ uniqueName: componentSpelling, count: 1 }],
      },
    };
    db[componentSpelling] = item("Widget", {
      blueprintUniqueName: blueprintSpelling,
      buildPrice: 0,
      buildTime: 0,
      num: 1,
      ingredients: [{ uniqueName: RUBEDO, count: 10 }],
    });
    db[blueprintSpelling] = item("Widget Blueprint");

    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const widget = childOf(tree, componentSpelling)!;
    const children = expandCraftingNode(widget, db, new Map(), [WEAPON]);

    expect(children.map((child) => child.uniqueName)).toEqual([RUBEDO]);
  });

  it("shows the recipe of a resource opened as its own tree root", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(FORMA, db, new Map())!;

    // The leaf rule only stops recursion into a resource, never blanks its own tree.
    expect(tree.children.map((child) => child.uniqueName).sort()).toEqual(
      [FORMA_BP, MORPHICS, RUBEDO].sort(),
    );
    expect(tree.isCraftable).toBe(true);
  });

  it("expands one level per click so the depth cap can count them", () => {
    const chain = ["A", "B", "C", "D", "E"].map((id) => `/Lotus/Types/Items/MiscItems/Link${id}`);
    const db: Record<string, ItemDbEntry> = {
      [WEAPON]: item("Sepulcrum", {
        blueprintUniqueName: WEAPON_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chain[0], count: 1 }],
      }),
      [WEAPON_BP]: item("Sepulcrum Blueprint"),
    };
    chain.forEach((uniqueName, index) => {
      const next = chain[index + 1];
      db[uniqueName] = next
        ? item(`Link ${index}`, {
            blueprintUniqueName: `${uniqueName}Blueprint`,
            buildPrice: 0,
            buildTime: 0,
            num: 1,
            ingredients: [{ uniqueName: next, count: 1 }],
          })
        : item(`Link ${index}`);
      db[`${uniqueName}Blueprint`] = item(`Link ${index} Blueprint`);
    });

    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    let node = childOf(tree, chain[0])!;
    let ancestors = [WEAPON];
    let levels = 0;

    while (canExpandCraftingNode(node, db, ancestors) && levels < MAX_EXPAND_DEPTH) {
      const children = expandCraftingNode(node, db, new Map(), ancestors);
      // Each call resolves exactly one level; grandchildren stay unresolved.
      expect(children.every((child) => child.children.length === 0)).toBe(true);
      ancestors = [...ancestors, node.uniqueName];
      node = children.find((child) => child.uniqueName === chain[levels + 1])!;
      levels += 1;
    }

    expect(MAX_EXPAND_DEPTH).toBe(3);
    expect(levels).toBe(3);
    expect(node.uniqueName).toBe(chain[3]);
    // Still craftable at the cap - that is where the modal escape hatch takes over.
    expect(canExpandCraftingNode(node, db, ancestors)).toBe(true);
  });
});

describe("expanded child ancestors", () => {
  it("adds the product a blueprint expansion roots through", () => {
    const db = expandableDb();
    db[FORMA_BP] = { ...db[FORMA_BP], buildsProduct: FORMA };
    const blueprint = looseNode(FORMA_BP, "Forma Blueprint");

    const path = expandedChildAncestors(blueprint, db, [WEAPON]);
    expect(path).toEqual([WEAPON, FORMA_BP, FORMA]);
    // The pair must not re-offer itself one level down.
    expect(canExpandCraftingNode(looseNode(FORMA, "Forma"), db, path)).toBe(false);
    expect(canExpandCraftingNode(blueprint, db, path)).toBe(false);
  });

  it("adds no product for a blueprint whose product carries no recipe", () => {
    const db = expandableDb();
    const trophy = "/Lotus/Types/Items/Decor/Trophy";
    db[trophy] = item("Trophy");
    db[WEAPON_BP] = { ...db[WEAPON_BP], buildsProduct: trophy };
    const blueprint = looseNode(WEAPON_BP, "Sepulcrum Blueprint");

    // Nothing to expand, so nothing was rooted through: an ancestor for the
    // product would block a sibling the expansion never touched.
    expect(expandCraftingNode(blueprint, db, new Map(), [WEAPON])).toEqual([]);
    expect(expandedChildAncestors(blueprint, db, [WEAPON])).toEqual([WEAPON, WEAPON_BP]);
  });

  it("lists a node that carries its own recipe once", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;

    expect(expandedChildAncestors(childOf(tree, FORMA)!, db, [WEAPON])).toEqual([WEAPON, FORMA]);
  });
});

describe("crafting tree expansion against owned copies", () => {
  it("expands only the copies the node still needs", () => {
    const owned = new Map([[FORMA, 1]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const forma = childOf(tree, FORMA)!;

    expect(forma.count).toBe(3);
    expect(forma.owned).toBe(1);

    const children = expandCraftingNode(forma, db, owned, [WEAPON]);
    const byName = (un: string) => children.find((child) => child.uniqueName === un);

    // Two runs, not three: the copy already in the inventory is not built again.
    expect(byName(RUBEDO)?.count).toBe(1000);
    expect(byName(MORPHICS)?.count).toBe(2);
    expect(byName(FORMA_BP)?.count).toBe(2);
  });

  it("gives a fully owned node no chevron and no bill", () => {
    const owned = new Map([[FORMA, 3]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const forma = childOf(tree, FORMA)!;

    expect(canExpandCraftingNode(forma, db, [WEAPON])).toBe(false);
    expect(expandCraftingNode(forma, db, owned, [WEAPON])).toEqual([]);
  });
});

describe("crafting tree filters", () => {
  const PART = "/Lotus/Types/Recipes/WeaponRecipes/WidgetComponent";
  const PART_BP = "/Lotus/Types/Recipes/WeaponRecipes/WidgetSubBlueprint";

  function blueprintOnlyDb(): Record<string, ItemDbEntry> {
    return {
      [WEAPON]: item("Sepulcrum", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: PART, count: 1 }],
      }),
      [PART]: item("Widget", {
        blueprintUniqueName: PART_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [],
      }),
      [PART_BP]: item("Widget Blueprint"),
    };
  }

  it("gives no chevron to a node whose children a filter removed", () => {
    const db = blueprintOnlyDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    expect(childOf(tree, PART)?.children.map((child) => child.uniqueName)).toEqual([PART_BP]);

    const filtered = applyCraftingTreeFilters(tree, {
      hideCompleted: false,
      hideBlueprints: true,
    })!;
    const part = childOf(filtered, PART)!;

    expect(part.children).toHaveLength(0);
    expect(part.childrenHidden).toBe(true);
    // Without the flag the card would re-show the blueprint through expansion.
    expect(canExpandCraftingNode(part, db, [WEAPON])).toBe(false);
  });

  it("keeps a node expandable when the filter removed nothing", () => {
    const db = blueprintOnlyDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const filtered = applyCraftingTreeFilters(tree, {
      hideCompleted: false,
      hideBlueprints: false,
    })!;

    expect(childOf(filtered, PART)?.childrenHidden).toBeUndefined();
  });

  it("hides blueprints in a lazily expanded level too", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const children = expandCraftingNode(childOf(tree, FORMA)!, db, new Map(), [WEAPON]);

    expect(children.some((child) => child.uniqueName === FORMA_BP)).toBe(true);
    const shown = filterExpandedChildren(children, {
      hideCompleted: false,
      hideBlueprints: true,
    });
    expect(shown.map((child) => child.uniqueName).sort()).toEqual([MORPHICS, RUBEDO].sort());
  });

  it("hides completed rows in a lazily expanded level too", () => {
    const owned = new Map([[RUBEDO, 5000]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const children = expandCraftingNode(childOf(tree, FORMA)!, db, owned, [WEAPON]);

    const shown = filterExpandedChildren(children, {
      hideCompleted: true,
      hideBlueprints: false,
    });
    expect(shown.some((child) => child.uniqueName === RUBEDO)).toBe(false);
    expect(shown.some((child) => child.uniqueName === MORPHICS)).toBe(true);
  });
});
