// Reads single JSON files from the two bundled data packages. Their entry points
// parse everything at require(): warframe-public-export-plus all 15 language
// dictionaries (62.6 MB), @wfcd/items its unused 52 MB i18n table.

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
  ducats?: number;
  drops?: DropEntry[];
  components?: ComponentEntry[];
  rewards?: WfcdRelicReward[];
}

const packageRoots = new Map<string, string>();
// Parsed once per process and shared by every caller, as require() and the
// @wfcd readJson cache did: callers must treat the objects as read-only.
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

function readWfcdCategory(category: string): WfcdItem[] {
  const cached = wfcdCategories.get(category);
  if (cached) return cached;
  if (!WFCD_CATEGORY.test(category)) return [];
  const file = path.join(packageRoot(WFCD_PACKAGE), "data", "json", `${category}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${WFCD_PACKAGE} ${category}.json is not a list`);
  const items = parsed as WfcdItem[];
  wfcdCategories.set(category, items);
  return items;
}

/** What `new Items({ category })` yields: the categories concatenated, then
 *  sorted by name and uniqueName. */
export function readWfcdItems(categories: readonly string[]): WfcdItem[] {
  const items: WfcdItem[] = [];
  for (const category of categories) {
    for (const item of readWfcdCategory(category)) items.push(item);
  }
  return items.sort(
    (a, b) => a.name.localeCompare(b.name) || a.uniqueName.localeCompare(b.uniqueName),
  );
}
