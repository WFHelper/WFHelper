import { derived } from "svelte/store";

import { parseArchonShards } from "../lib/inventory/archonShards.js";
import { inventoryData } from "./data.js";

/** Frame uniqueName -> the owned copies carrying shards, parsed once per push.
 *  Inventory draws thousands of cards, so each one looks up here instead of
 *  reparsing the raw payload. */
export const archonShardsBySuit = derived(
  inventoryData,
  ($inv) => parseArchonShards($inv).bySuitType,
);
