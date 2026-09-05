import { invoke, on } from "../lib/ipc.js";
import { createRunStore } from "./runStore.js";
import type { PtRunRecord } from "../types/ipc.js";

const store = createRunStore<PtRunRecord>({
  fetch: () => invoke("getPtRuns"),
  refetch: () => invoke("refreshPtRuns"),
  subscribeSaved: (onRun) => on("pt-run-saved", onRun),
  removeRun: (id) => invoke("deletePtRun", id),
  removeRunLog: (id) => invoke("deletePtRunLog", id),
});

export const ptRuns = store.runs;
export const ptDiskUsageBytes = store.diskUsageBytes;
export const ptRunsLoaded = store.loaded;

export const loadPtRuns = store.load;
export const refreshPtRuns = store.refresh;
export const subscribePtRunSaved = store.subscribeSaved;
export const deletePtRun = store.remove;
export const deletePtRunLog = store.removeLog;

export async function updatePtTags(id: string, tags: string[]): Promise<void> {
  store.patch(await invoke("setPtRunTags", id, tags));
}

export async function updatePtNotes(id: string, notes: string): Promise<void> {
  store.patch(await invoke("setPtRunNotes", id, notes));
}
