import type { RawInventoryData } from "../types/inventory.js";

import {
  hasInventoryShape as sharedHasInventoryShape,
  unwrapInventoryPayload as sharedUnwrap,
} from "../../config/shared/inventoryPayload.js";

export function hasInventoryShape(data: unknown): data is RawInventoryData {
  return sharedHasInventoryShape(data);
}

export function unwrapInventoryPayload(data: RawInventoryData): RawInventoryData {
  return sharedUnwrap(data, { returnInputOnFailure: true }) as RawInventoryData;
}
