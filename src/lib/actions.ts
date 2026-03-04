import { get } from "svelte/store";
import { inventoryData } from "../stores/data.js";
import { masteryData } from "../stores/mastery.js";
import { currentView, statusText } from "../stores/app.js";
import { relicDb, relicOwnedCounts } from "../stores/relics.js";
import { parseOwnedRelics } from "./relic.js";
import { unwrapInventoryPayload } from "./inventoryPayload.js";
import { ipc } from "./ipc.js";
import type { RawInventoryData } from "../types/inventory.js";

export async function onInventoryLoaded(data: RawInventoryData): Promise<void> {
  const parsedData = unwrapInventoryPayload(data);

  inventoryData.set(parsedData);
  currentView.set("inventory");

  const db = get(relicDb);
  if (db) {
    relicOwnedCounts.set(parseOwnedRelics(parsedData, db));
  }

  ipc
    .getMasteryProgress()
    .then((md) => masteryData.set(md))
    .catch((err) => console.warn("[Mastery] getMasteryProgress failed:", err));
}

export function setInventoryStatus(count: number): void {
  statusText.set(`${count} items loaded`);
}
