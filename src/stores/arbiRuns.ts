import { writable } from "svelte/store";

import { invoke, on } from "../lib/ipc.js";
import { createRunStore } from "./runStore.js";
import type { ArbiRunRecord } from "../types/ipc.js";

const store = createRunStore<ArbiRunRecord>({
  fetch: () => invoke("getArbiRuns"),
  refetch: () => invoke("refreshArbiRuns"),
  subscribeSaved: (onRun) => on("arbi-run-saved", onRun),
  removeRun: (id) => invoke("deleteArbiRun", id),
  removeRunLog: (id) => invoke("deleteArbiRunLog", id),
});

export const arbiRuns = store.runs;
export const arbiDiskUsageBytes = store.diskUsageBytes;
export const arbiRunsLoaded = store.loaded;
/** Run id the Arbi view should open on next mount (set by the overlay's Details button). */
export const pendingArbiRunId = writable<string | null>(null);

export const loadArbiRuns = store.load;
export const refreshArbiRuns = store.refresh;
export const subscribeArbiRunSaved = store.subscribeSaved;
export const deleteArbiRun = store.remove;
export const deleteArbiRunLog = store.removeLog;

export async function updateArbiVitus(id: string, vitus: number | null): Promise<void> {
  store.patch(await invoke("setArbiRunVitus", id, vitus));
}

export async function updateArbiTags(id: string, tags: string[]): Promise<void> {
  store.patch(await invoke("setArbiRunTags", id, tags));
}

export async function updateArbiNotes(id: string, notes: string): Promise<void> {
  store.patch(await invoke("setArbiRunNotes", id, notes));
}
