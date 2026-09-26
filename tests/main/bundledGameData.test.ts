import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Pins the loader to the two packages' file layout, so a dependency bump that
// moves or empties a file the app reads fails here instead of blanking names.
const requested = vi.hoisted(() => ({
  exports: new Set<string>(),
  dicts: new Set<string>(),
  categories: new Set<string>(),
}));

vi.mock("../../services/bundledGameData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/bundledGameData")>();
  return {
    ...actual,
    readPepExport: (name: string) => {
      requested.exports.add(name);
      return actual.readPepExport(name);
    },
    readPepDict: (locale: string) => {
      requested.dicts.add(locale);
      return actual.readPepDict(locale);
    },
    readWfcdItems: (categories: readonly string[]) => {
      for (const category of categories) requested.categories.add(category);
      return actual.readWfcdItems(categories);
    },
  };
});

import {
  listPepExports,
  readPepDict,
  readPepExport,
  readWfcdItems,
  scanPepExport,
} from "../../services/bundledGameData";
import { GAME_LOCALES } from "../../services/gameLocale";
import * as itemDb from "../../services/itemDatabase";
import { getRelicDatabase } from "../../services/relicService";

// The item database maps it for completeness; the package has never shipped it.
const ABSENT_EXPORTS = new Set(["ExportMisc"]);
const WFCD_DATA = path.join(path.dirname(require.resolve("@wfcd/items")), "data", "json");

let exportNames: string[] = [];
let dictLocales: string[] = [];
let wfcdCategories: string[] = [];
let wfcdFilesRead: string[] = [];

const readFileSpy = vi.spyOn(fs, "readFileSync");

function values(table: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return Object.values(table ?? {}).filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object",
  );
}

function wfcdLeftOutOfInstaller(): { files: Set<string>; folders: Set<string> } {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ) as {
    build: { files: string[] };
  };
  const prefix = "!node_modules/@wfcd/items/data/json/";
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const pattern of pkg.build.files.filter((p) => p.startsWith(prefix))) {
    const rest = pattern.slice(prefix.length);
    const folder = /^([\w-]+)\/\*\*$/.exec(rest)?.[1];
    if (folder) folders.add(folder);
    const names = /^\{([\w,-]+)\}\.json$/.exec(rest)?.[1] ?? /^([\w-]+)\.json$/.exec(rest)?.[1];
    for (const name of names?.split(",") ?? []) files.add(name);
  }
  return { files, folders };
}

beforeAll(() => {
  itemDb.buildDatabase();
  getRelicDatabase();
  wfcdFilesRead = readFileSpy.mock.calls
    .map(([file]) => (typeof file === "string" ? path.relative(WFCD_DATA, file) : ".."))
    .filter((file) => !file.startsWith("..") && !path.isAbsolute(file));
  readFileSpy.mockRestore();
  exportNames = [...requested.exports];
  dictLocales = [...requested.dicts];
  wfcdCategories = [...requested.categories];
});

describe("bundled relic data", () => {
  it("has the relics of the 2026-09-24 update and keeps dropping ones unvaulted", () => {
    const { groups } = getRelicDatabase();
    expect(groups["Axi C12"]?.qualities.intact?.rewards.length).toBe(6);
    expect(groups["Axi C12"]?.vaulted).toBe(false);
    expect(groups["Lith A13"]?.vaulted).toBe(false);
  });
});

describe("bundled game data loader", () => {
  it("resolves every table the item and relic databases read", () => {
    expect(exportNames).toEqual(expect.arrayContaining(["ExportRecipes", "ExportDojoRecipes"]));
    for (const name of exportNames.filter((n) => !ABSENT_EXPORTS.has(n))) {
      expect(Object.keys(readPepExport(name) ?? {}).length, name).toBeGreaterThan(0);
    }
    expect(dictLocales).toEqual(["en"]);
    expect(wfcdCategories).toEqual(expect.arrayContaining(["Relics", "Warframes", "Mods"]));
    for (const category of wfcdCategories) {
      expect(readWfcdItems([category]).length, category).toBeGreaterThan(0);
    }
  });

  it("keeps the fields the databases read from the export tables", () => {
    const dict = readPepDict("en") ?? {};
    const weapons = values(readPepExport("ExportWeapons"));
    const named = weapons.filter((w) => typeof w.name === "string" && w.name.startsWith("/"));
    const resolved = named.filter((w) => dict[String(w.name)]);
    expect(resolved.length / named.length).toBeGreaterThan(0.95);

    expect(values(readPepExport("ExportRelics")).some((r) => r.era && r.category)).toBe(true);
    expect(
      values(readPepExport("ExportRecipes")).some(
        (r) => typeof r.resultType === "string" && Array.isArray(r.ingredients),
      ),
    ).toBe(true);
    expect(values(readPepExport("ExportSentinels")).some((s) => s.defaultWeapon)).toBe(true);
    const dojo = readPepExport("ExportDojoRecipes")?.research;
    expect(Object.keys(dojo && typeof dojo === "object" ? dojo : {}).length).toBeGreaterThan(0);
  });

  it("keeps the fields the databases read from @wfcd/items", () => {
    const items = readWfcdItems(wfcdCategories);
    expect(items.every((i) => typeof i.uniqueName === "string" && typeof i.name === "string")).toBe(
      true,
    );
    const drops = items.flatMap((i) => (i.components ?? []).flatMap((c) => c.drops ?? []));
    expect(drops.length).toBeGreaterThan(1000);
    expect(drops.every((d) => typeof d.location === "string" && typeof d.chance === "number")).toBe(
      true,
    );

    const relics = readWfcdItems(["Relics"]);
    expect(relics.every((r) => r.category === "Relics")).toBe(true);
    const rewards = relics.flatMap((r) => r.rewards ?? []);
    expect(rewards.length).toBeGreaterThan(10_000);
    expect(rewards.every((r) => typeof r.item?.name === "string")).toBe(true);
  });

  it("loads the dictionary of every selectable game language on its own", () => {
    for (const locale of GAME_LOCALES) {
      const dict = readPepDict(locale) ?? {};
      expect(dict["/Lotus/Language/Items/BlueprintAndItem"], locale).toMatch(/\|ITEM\|/);
    }
  });

  it("scans a table without keeping it, but reuses a table already kept", () => {
    const unread = listPepExports().find((name) => !requested.exports.has(name));
    if (!unread) throw new Error("every table was read through the cache");
    const scanned = scanPepExport(unread);
    expect(Object.keys(scanned ?? {}).length).toBeGreaterThan(0);
    expect(scanPepExport(unread)).not.toBe(scanned);
    const kept = readPepExport("ExportWeapons");
    expect(scanPepExport("ExportWeapons")).toBe(kept);
  });

  it("lists the same tables the package entry loads", () => {
    const entry = path.join(
      path.dirname(require.resolve("warframe-public-export-plus")),
      "index.js",
    );
    const source = fs.readFileSync(entry, "utf8");
    const loaded = [...source.matchAll(/require\("\.\/(Export\w+)\.json"\)/g)].map((m) => m[1]);
    expect(loaded.length).toBeGreaterThan(40);
    expect(listPepExports()).toEqual(loaded);
  });

  it("orders @wfcd/items exactly like the package constructor", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Items = require("@wfcd/items") as new (options: {
      category: string[];
    }) => Array<{ uniqueName: string; category?: string }>;
    const fromPackage = new Items({ category: wfcdCategories });

    expect(readWfcdItems(wfcdCategories).map((i) => i.uniqueName)).toEqual(
      fromPackage.map((i) => i.uniqueName),
    );
    expect(readWfcdItems(["Relics"]).map((i) => i.uniqueName)).toEqual(
      fromPackage.filter((i) => i.category === "Relics").map((i) => i.uniqueName),
    );
  });

  it("resolves @wfcd/items components exactly like the package constructor", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Items = require("@wfcd/items") as new (options: { category: string[] }) => unknown[];
    for (const categories of [wfcdCategories, ["Relics"], ["Warframes"], ["Components", "Gear"]]) {
      const ours = readWfcdItems(categories);
      const theirs = [...new Items({ category: categories })];
      expect(ours.length, categories.join()).toBe(theirs.length);
      const differing = ours
        .filter((item, i) => JSON.stringify(item) !== JSON.stringify(theirs[i]))
        .map((item) => item.uniqueName);
      expect(differing, categories.join()).toEqual([]);
    }
  });

  it("hands out copies, so a caller's edits never reach the next call", () => {
    const categories = ["Warframes", "Relics"];
    const before = JSON.stringify(readWfcdItems(categories));
    for (const item of readWfcdItems(categories)) {
      for (const component of item.components ?? []) component.drops = [];
      item.components = [];
      item.drops = [];
      item.vaulted = !item.vaulted;
    }
    expect(JSON.stringify(readWfcdItems(categories))).toBe(before);
  });

  it("never packs or reads the @wfcd/items data the app leaves unused", () => {
    const { files, folders } = wfcdLeftOutOfInstaller();
    const subfolders = fs
      .readdirSync(WFCD_DATA, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(subfolders.filter((folder) => !folders.has(folder))).toEqual([]);
    expect(files).toContain("Enemy");
    expect(files).not.toContain("Components");

    expect(wfcdFilesRead).toContain("Components.json");
    const unshipped = wfcdFilesRead.filter(
      (file) => files.has(path.basename(file, ".json")) || path.dirname(file) !== ".",
    );
    expect(unshipped).toEqual([]);
  });
});
