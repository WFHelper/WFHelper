// Reads single JSON files from the two bundled data packages instead of their
// entry points: warframe-public-export-plus parses all 15 language dictionaries
// (62.6 MB) at require(), @wfcd/items every category file for any new Items().

import fs from "node:fs";
import path from "node:path";

import { asRecord } from "../config/shared/objectValidation";
import type { ComponentEntry, DropEntry } from "./types/gameData";

const PEP_PACKAGE = "warframe-public-export-plus";
const WFCD_PACKAGE = "@wfcd/items";
const PEP_EXPORT_NAME = /^Export[A-Za-z]+$/;
const PEP_LOCALE = /^[a-z]{2}$/;
const WFCD_CATEGORY = /^[A-Za-z-]+$/;

interface WfcdRelicReward {
  chance?: number;
  rarity?: string;
  item?: {
    uniqueName?: string;
    name?: string;
    imageName?: string;
    ducats?: number;
    warframeMarket?: { id?: string; urlName?: string; url_name?: string };
  };
}

/** The @wfcd/items fields the app reads; the package typings are a wide union. */
export interface WfcdItem {
  uniqueName: string;
  name: string;
  category?: string;
  type?: string;
  description?: string;
  productCategory?: string;
  imageName?: string;
  wikiaThumbnail?: string;
  wikiaUrl?: string;
  masteryReq?: number;
  masterable?: boolean;
  tradable?: boolean;
  vaulted?: boolean;
  exalted?: boolean;
  tags?: string[];
  ducats?: number;
  drops?: DropEntry[];
  components?: ComponentEntry[];
  rewards?: WfcdRelicReward[];
}

// Left out of the installer by package.json build.files.
const WFCD_UNSHIPPED = new Set([
  "Enemy",
  "Glyphs",
  "Node",
  "Quests",
  "Railjack",
  "SentinelWeapons",
  "Sigils",
  "Skins",
]);
const WFCD_COMPONENTS = "Components";

const packageRoots = new Map<string, string>();
// Parsed once per process, as require() and the @wfcd readJson cache did. WFCD
// items reach callers as shallow copies like the package makes, so nested arrays
// such as drops and rewards are still shared: replace them, never mutate them.
const pepFiles = new Map<string, unknown>();
const wfcdCategories = new Map<string, WfcdItem[]>();

// Both packages export only ".", so "<pkg>/package.json" does not resolve; the
// entry file's folder is the package root, inside app.asar as well.
function packageRoot(name: string): string {
  let root = packageRoots.get(name);
  if (!root) {
    root = path.dirname(require.resolve(name));
    packageRoots.set(name, root);
  }
  return root;
}

function readPepFile(file: string, keep = true): unknown {
  if (pepFiles.has(file)) return pepFiles.get(file);
  const full = path.join(packageRoot(PEP_PACKAGE), file);
  const value: unknown = fs.existsSync(full)
    ? JSON.parse(fs.readFileSync(full, "utf8"))
    : undefined;
  if (keep) pepFiles.set(file, value);
  return value;
}

/** One table such as "ExportWeapons", or undefined when the package ships none. */
export function readPepExport(name: string): Record<string, unknown> | undefined {
  if (!PEP_EXPORT_NAME.test(name)) return undefined;
  return asRecord(readPepFile(`${name}.json`)) ?? undefined;
}

/** Like readPepExport, but a table nobody has cached yet is parsed and then dropped. */
export function scanPepExport(name: string): Record<string, unknown> | undefined {
  if (!PEP_EXPORT_NAME.test(name)) return undefined;
  return asRecord(readPepFile(`${name}.json`, false)) ?? undefined;
}

/** DE's string table for one language code, or undefined when not shipped. */
export function readPepDict(locale: string): Readonly<Record<string, string>> | undefined {
  if (!PEP_LOCALE.test(locale)) return undefined;
  const dict = asRecord(readPepFile(`dict.${locale}.json`));
  return dict ? (dict as Record<string, string>) : undefined;
}

/** Every Export table name, in the order the package entry loads them. */
export function listPepExports(): string[] {
  return fs
    .readdirSync(packageRoot(PEP_PACKAGE))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => PEP_EXPORT_NAME.test(name))
    .sort();
}

function wfcdDataDir(): string {
  return path.join(packageRoot(WFCD_PACKAGE), "data", "json");
}

function readWfcdCategory(category: string): WfcdItem[] {
  const cached = wfcdCategories.get(category);
  if (cached) return cached;
  if (!WFCD_CATEGORY.test(category)) return [];
  const file = path.join(wfcdDataDir(), `${category}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${WFCD_PACKAGE} ${category}.json is not a list`);
  const items = parsed as WfcdItem[];
  wfcdCategories.set(category, items);
  return items;
}

// The package's resolve catalog, minus the files the installer leaves out.
function readWfcdCatalog(): Map<string, WfcdItem> {
  const catalog = new Map<string, WfcdItem>();
  for (const entry of readWfcdCategory(WFCD_COMPONENTS)) {
    if (entry?.uniqueName) catalog.set(entry.uniqueName, entry);
  }
  for (const file of fs.readdirSync(wfcdDataDir())) {
    if (!file.endsWith(".json")) continue;
    const category = file.slice(0, -".json".length);
    if (category === WFCD_COMPONENTS || WFCD_UNSHIPPED.has(category)) continue;
    for (const item of readWfcdCategory(category)) catalog.set(item.uniqueName, item);
  }
  return catalog;
}

function copyWfcdItem(raw: WfcdItem): WfcdItem {
  const item = { ...raw };
  if (Array.isArray(raw.components)) item.components = raw.components.map((c) => ({ ...c }));
  return item;
}

// Since 1.1276 components are { uniqueName, itemCount } refs; the package expands
// them in load order, so a ref to a loaded item copies that item as it is then.
function resolveWfcdComponents(items: readonly WfcdItem[]): void {
  let catalog: Map<string, WfcdItem> | undefined;
  for (const item of items) {
    if (!item.components?.length) continue;
    item.components = item.components.map((ref) => {
      if (!ref?.uniqueName || ref.name || ref.imageName || ref.drops) return ref;
      if (!catalog) {
        catalog = readWfcdCatalog();
        for (const loaded of items) catalog.set(loaded.uniqueName, loaded);
      }
      const entry = catalog.get(ref.uniqueName);
      if (!entry) return ref;
      const component: ComponentEntry & { parentUniqueNames?: unknown } = {
        ...entry,
        itemCount: typeof ref.itemCount === "number" ? ref.itemCount : 1,
      };
      delete component.parentUniqueNames;
      return component;
    });
  }
}

/** What `new Items({ category })` yields: the categories concatenated with
 *  "Components" last, component refs resolved, then sorted by name and uniqueName. */
export function readWfcdItems(categories: readonly string[]): WfcdItem[] {
  const ordered = categories.filter((category) => category !== WFCD_COMPONENTS);
  if (categories.includes(WFCD_COMPONENTS)) ordered.push(WFCD_COMPONENTS);
  const items: WfcdItem[] = [];
  for (const category of ordered) {
    for (const item of readWfcdCategory(category)) items.push(copyWfcdItem(item));
  }
  resolveWfcdComponents(items);
  return items.sort(
    (a, b) => a.name.localeCompare(b.name) || a.uniqueName.localeCompare(b.uniqueName),
  );
}
