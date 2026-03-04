import { get } from "svelte/store";
import { inventoryData } from "../stores/data.js";
import { masteryData } from "../stores/mastery.js";
import { currentView, statusText } from "../stores/app.js";
import { relicDb, relicOwnedCounts } from "../stores/relics.js";
import { parseOwnedRelics } from "./relic.js";
import { ipc } from "./ipc.js";
import type { RawInventoryData } from "../types/inventory.js";

function hasInventoryShape(data: unknown): data is RawInventoryData {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return Boolean(
    Array.isArray(record.Suits) ||
    Array.isArray(record.Upgrades) ||
    Array.isArray(record.Arcanes) ||
    Array.isArray(record.LevelKeys) ||
    Array.isArray(record.MiscItems),
  );
}

function unwrapInventoryPayload(data: RawInventoryData): RawInventoryData {
  let current: unknown = data;

  for (let i = 0; i < 4; i += 1) {
    if (hasInventoryShape(current)) return current;
    if (!current || typeof current !== "object") return data;

    const record = current as Record<string, unknown>;
    const next =
      record.InventoryJson ??
      record.inventoryJson ??
      record.inventory_json ??
      record.payload ??
      record.data;

    if (typeof next === "string") {
      try {
        current = JSON.parse(next) as unknown;
        continue;
      } catch (error) {
        console.error("[actions] Failed to parse nested inventory payload:", error);
        return data;
      }
    }

    if (next && typeof next === "object") {
      current = next;
      continue;
    }

    return (current as RawInventoryData) || data;
  }

  return (current as RawInventoryData) || data;
}

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
