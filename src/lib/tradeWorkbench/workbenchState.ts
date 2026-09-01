import { writable, type Readable } from "svelte/store";

import { invoke, on } from "../ipc.js";
import type { WorkbenchState } from "../../../config/shared/tradeWorkbenchTypes.js";

// Lazy start: the inventory banner and the Bulk Sell modal are the only
// consumers, so nothing is fetched until one of them is on screen.
const store = writable<WorkbenchState | null>(null, (set) => {
  void invoke("workbenchGetState").then(set);
  return on("workbench-state", set);
});

export const workbenchState: Readable<WorkbenchState | null> = { subscribe: store.subscribe };

/** Adopt the state an invoke returned ahead of the next main-process push. */
export function setWorkbenchState(state: WorkbenchState): void {
  store.set(state);
}
