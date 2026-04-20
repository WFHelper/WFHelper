import { writable } from "svelte/store";
import type { ComponentInfo, ParsedItem } from "../types/inventory.js";
import type { RelicGroup } from "../types/relics.js";

export interface ActiveComponentState {
  comp: ComponentInfo;
  parentName: string;
}

export const activeItem = writable<ParsedItem | null>(null);
export const activeComponent = writable<ActiveComponentState | null>(null);
export const activeRelic = writable<RelicGroup | null>(null);

/** When set alongside activeItem, opens the item detail modal with crafting tree visible. */
export const openWithCraftingTree = writable(false);
