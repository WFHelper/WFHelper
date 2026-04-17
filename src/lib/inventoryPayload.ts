import type { RawInventoryData } from "../types/inventory.js";
import {
  hasInventoryShape as _hasShape,
  unwrapInventoryPayload as _unwrap,
} from "../../config/shared/inventoryPayload.js";

export const hasInventoryShape = (data: unknown): data is RawInventoryData => _hasShape(data);
export const unwrapInventoryPayload = (data: RawInventoryData): RawInventoryData =>
  _unwrap(data, { returnInputOnFailure: true }) as RawInventoryData;
