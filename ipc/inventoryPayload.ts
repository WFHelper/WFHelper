import { createRuntimeRequire } from "./runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 1);
const inventoryPayloadShared = requireRuntime<SharedInventoryPayloadModule>(
  "config/shared/inventoryPayload.cjs",
);

type SharedInventoryPayloadModule = {
  hasInventoryShape: (value: unknown) => boolean;
  unwrapInventoryPayload: (
    value: unknown,
    options?: {
      returnInputOnFailure?: boolean;
      maxDepth?: number;
      onParseError?: (error: unknown) => void;
    },
  ) => unknown;
};

const { hasInventoryShape, unwrapInventoryPayload } = inventoryPayloadShared;

export { hasInventoryShape, unwrapInventoryPayload };
