import { writable } from "svelte/store";
import type { MasteryData } from "../types/inventory.js";

export const masteryData = writable<MasteryData | null>(null);
