import { writable } from "svelte/store";

import { invoke, on } from "../lib/ipc.js";
import type { ArbiRunRecord } from "../types/ipc.js";

export const arbiRuns = writable<ArbiRunRecord[]>([]);
export const arbiDiskUsageBytes = writable(0);
export const arbiRunsLoaded = writable(false);
/** Run id the Arbi view should open on next mount (set by the overlay's Details button). */
export const pendingArbiRunId = writable<string | null>(null);

async function fetchArbiRuns(channel: "getArbiRuns" | "refreshArbiRuns"): Promise<void> {
  const payload = await invoke(channel);
  arbiRuns.set(payload.runs);
  arbiDiskUsageBytes.set(payload.diskUsageBytes);
  arbiRunsLoaded.set(true);
}

export function loadArbiRuns(): Promise<void> {
  return fetchArbiRuns("getArbiRuns");
}

/** Refresh button: drains EE.log bytes already on disk before re-reading the index.
 * See forceEeLogPoll in services/eeLogMonitor.ts for what that cannot recover. */
export function refreshArbiRuns(): Promise<void> {
  return fetchArbiRuns("refreshArbiRuns");
}

/** Runs land in the index even when the Arbitrations tab is closed, so the
 * push has to be bound for the app's lifetime, not the view's. */
export function subscribeArbiRunSaved(): () => void {
  return on("arbi-run-saved", (run) => upsertArbiRun(run));
}

/** Prepend or replace a run pushed from the main process. */
function upsertArbiRun(run: ArbiRunRecord): void {
  arbiRuns.update((runs) => {
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) return [...runs.slice(0, idx), run, ...runs.slice(idx + 1)];
    return [run, ...runs];
  });
}

function patchRun(updated: ArbiRunRecord | null): void {
  if (updated) upsertArbiRun(updated);
}

export async function updateArbiVitus(id: string, vitus: number | null): Promise<void> {
  patchRun(await invoke("setArbiRunVitus", id, vitus));
}

export async function updateArbiTags(id: string, tags: string[]): Promise<void> {
  patchRun(await invoke("setArbiRunTags", id, tags));
}

export async function updateArbiNotes(id: string, notes: string): Promise<void> {
  patchRun(await invoke("setArbiRunNotes", id, notes));
}

export async function deleteArbiRun(id: string): Promise<void> {
  const result = await invoke("deleteArbiRun", id);
  if (result.ok) arbiRuns.update((runs) => runs.filter((r) => r.id !== id));
  await refreshDiskUsage();
}

export async function deleteArbiRunLog(id: string): Promise<void> {
  patchRun(await invoke("deleteArbiRunLog", id));
  await refreshDiskUsage();
}

async function refreshDiskUsage(): Promise<void> {
  try {
    const payload = await invoke("getArbiRuns");
    arbiDiskUsageBytes.set(payload.diskUsageBytes);
  } catch {
    // usage label refresh is best-effort
  }
}
