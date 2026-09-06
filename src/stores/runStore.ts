import { writable, type Writable } from "svelte/store";

/** What a feature's get/refresh channel hands back. */
interface RunsPayload<TRecord> {
  runs: TRecord[];
  diskUsageBytes: number;
}

/** The IPC calls one run feature owns. Passing thunks rather than channel names
 * keeps every call typed against IpcInvokeMap at its own call site. */
interface RunStoreSpec<TRecord> {
  fetch: () => Promise<RunsPayload<TRecord>>;
  /** Drains EE.log bytes already on disk before re-reading the index.
   * See forceEeLogPoll in services/eeLogMonitor.ts for what that cannot recover. */
  refetch: () => Promise<RunsPayload<TRecord>>;
  subscribeSaved: (onRun: (run: TRecord) => void) => () => void;
  removeRun: (id: string) => Promise<{ ok: boolean }>;
  removeRunLog: (id: string) => Promise<TRecord | null>;
}

interface RunStore<TRecord> {
  runs: Writable<TRecord[]>;
  diskUsageBytes: Writable<number>;
  loaded: Writable<boolean>;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Runs land in the index even when their tab is closed, so the push has to be
   * bound for the app's lifetime, not the view's. */
  subscribeSaved: () => () => void;
  /** Apply the record a mutation handed back; null means the id was unknown. */
  patch: (updated: TRecord | null) => void;
  remove: (id: string) => Promise<void>;
  removeLog: (id: string) => Promise<void>;
}

/** The list, disk-usage and push handling every EE.log run feature needs; the
 * feature supplies its own channels and keeps its own exported store names. */
export function createRunStore<TRecord extends { id: string }>(
  spec: RunStoreSpec<TRecord>,
): RunStore<TRecord> {
  const runs = writable<TRecord[]>([]);
  const diskUsageBytes = writable(0);
  const loaded = writable(false);

  async function apply(load: () => Promise<RunsPayload<TRecord>>): Promise<void> {
    const payload = await load();
    runs.set(payload.runs);
    diskUsageBytes.set(payload.diskUsageBytes);
    loaded.set(true);
  }

  function upsert(run: TRecord): void {
    runs.update((list) => {
      const idx = list.findIndex((r) => r.id === run.id);
      if (idx >= 0) return [...list.slice(0, idx), run, ...list.slice(idx + 1)];
      return [run, ...list];
    });
  }

  async function refreshDiskUsage(): Promise<void> {
    try {
      const payload = await spec.fetch();
      diskUsageBytes.set(payload.diskUsageBytes);
    } catch {
      // usage label refresh is best-effort
    }
  }

  return {
    runs,
    diskUsageBytes,
    loaded,
    load: () => apply(spec.fetch),
    refresh: () => apply(spec.refetch),
    subscribeSaved: () => spec.subscribeSaved(upsert),
    patch: (updated) => {
      if (updated) upsert(updated);
    },
    remove: async (id) => {
      const result = await spec.removeRun(id);
      if (result.ok) runs.update((list) => list.filter((r) => r.id !== id));
      await refreshDiskUsage();
    },
    removeLog: async (id) => {
      const updated = await spec.removeRunLog(id);
      if (updated) upsert(updated);
      await refreshDiskUsage();
    },
  };
}
