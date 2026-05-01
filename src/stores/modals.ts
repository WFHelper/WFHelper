import { writable } from "svelte/store";
import type { ComponentInfo, ParsedItem } from "../types/inventory.js";
import type { RelicGroup } from "../types/relics.js";

interface ActiveComponentState {
  comp: ComponentInfo;
  parentName: string;
}

export const activeItem = writable<ParsedItem | null>(null);
export const activeComponent = writable<ActiveComponentState | null>(null);
export const activeRelic = writable<RelicGroup | null>(null);
