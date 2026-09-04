import { writable } from "svelte/store";

import { invoke, on } from "../lib/ipc.js";
import type { PtRunRecord } from "../types/ipc.js";

export const ptRuns = writable<PtRunRecord[]>([]);
export const ptDiskUsageBytes = writable(0);
export const ptRunsLoaded = writable(false);

async function fetchPtRuns(channel: "getPtRuns" | "refreshPtRuns"): Promise<void> {
  const payload = await invoke(channel);
  ptRuns.set(payload.runs);
  ptDiskUsageBytes.set(payload.diskUsageBytes);
  ptRunsLoaded.set(true);
}

export function loadPtRuns(): Promise<void> {
  return fetchPtRuns("getPtRuns");
}

/** Refresh button: drains EE.log bytes already on disk before re-reading the index. */
export function refreshPtRuns(): Promise<void> {
  return fetchPtRuns("refreshPtRuns");
}

/** Runs land in the index even when the tab is closed, so the push has to be
 * bound for the app's lifetime, not the view's. */
export function subscribePtRunSaved(): () => void {
  return on("pt-run-saved", (run) => upsertPtRun(run));
}

/** Prepend or replace a run pushed from the main process. */
function upsertPtRun(run: PtRunRecord): void {
  ptRuns.update((runs) => {
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) return [...runs.slice(0, idx), run, ...runs.slice(idx + 1)];
    return [run, ...runs];
  });
}

function patchRun(updated: PtRunRecord | null): void {
  if (updated) upsertPtRun(updated);
}

export async function updatePtTags(id: string, tags: string[]): Promise<void> {
  patchRun(await invoke("setPtRunTags", id, tags));
}

export async function updatePtNotes(id: string, notes: string): Promise<void> {
  patchRun(await invoke("setPtRunNotes", id, notes));
}

export async function deletePtRun(id: string): Promise<void> {
  const result = await invoke("deletePtRun", id);
  if (result.ok) ptRuns.update((runs) => runs.filter((r) => r.id !== id));
  await refreshDiskUsage();
}

export async function deletePtRunLog(id: string): Promise<void> {
  patchRun(await invoke("deletePtRunLog", id));
  await refreshDiskUsage();
}

async function refreshDiskUsage(): Promise<void> {
  try {
    const payload = await invoke("getPtRuns");
    ptDiskUsageBytes.set(payload.diskUsageBytes);
  } catch {
    // usage label refresh is best-effort
  }
}
