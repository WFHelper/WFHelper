import { get } from "svelte/store";
import { inventoryData } from "../stores/data.js";
import { masteryData } from "../stores/mastery.js";
import { statusText } from "../stores/app.js";
import { unwrapInventoryPayload } from "../../config/shared/inventoryPayload.js";
import { invoke } from "./ipc.js";
import type { RawInventoryData } from "../types/inventory.js";

export async function onInventoryLoaded(data: RawInventoryData): Promise<void> {
  const parsedData = unwrapInventoryPayload(data, {
    returnInputOnFailure: true,
  }) as RawInventoryData;

  inventoryData.set(parsedData);

  invoke("getMasteryProgress")
    .then((md) => {
      if (get(inventoryData) === parsedData) masteryData.set(md);
    })
    .catch((err) => console.warn("[Mastery] getMasteryProgress failed:", err));
}

export function setInventoryStatus(count: number): void {
  statusText.set({ key: "app.itemsLoaded", params: { count } });
}
