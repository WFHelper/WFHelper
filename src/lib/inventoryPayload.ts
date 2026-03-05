import type { RawInventoryData } from "../types/inventory.js";

import inventoryPayloadShared from "../../config/shared/inventoryPayload.cjs";

type SharedInventoryPayloadModule = {
  hasInventoryShape: (value: unknown) => boolean;
  unwrapInventoryPayload: (
    value: unknown,
    options?: { returnInputOnFailure?: boolean; maxDepth?: number },
  ) => unknown;
};

const { hasInventoryShape: sharedHasInventoryShape, unwrapInventoryPayload: sharedUnwrap } =
  inventoryPayloadShared as SharedInventoryPayloadModule;

export function hasInventoryShape(data: unknown): data is RawInventoryData {
  return sharedHasInventoryShape(data);
}

export function unwrapInventoryPayload(data: RawInventoryData): RawInventoryData {
  return sharedUnwrap(data, { returnInputOnFailure: true }) as RawInventoryData;
}
