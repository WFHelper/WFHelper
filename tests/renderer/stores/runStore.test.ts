import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArbiRunRecord, PtRunRecord } from "../../../src/types/ipc.js";

const h = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn() }));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: h.invoke, on: h.on }));

function arbiRun(id: string, extra: Partial<ArbiRunRecord> = {}): ArbiRunRecord {
  return {
    id,
    startedAt: 1,
    endedAt: 2,
    missionName: "Arbitration: Casta Defense (Ceres)",
    node: "Casta Defense (Ceres)",
    missionType: "defense",
    durationSec: 600,
    rotations: 2,
    drones: 1,
    totalEnemies: 40,
    vitusActual: null,
    logFile: null,
    logSizeBytes: 0,
    endReason: "mission-end",
    source: "live",
    stats: null,
    ...extra,
  };
}

function ptRun(id: string, extra: Partial<PtRunRecord> = {}): PtRunRecord {
  return {
    id,
    startedAt: 1,
    endedAt: 2,
    durationSec: 120,
    flightSec: 20,
    shieldSec: 10,
    legSec: 30,
    bodySec: 40,
    pylonSec: 20,
    phases: [],
    solo: true,
    complete: true,
    bugged: false,
    aborted: false,
    logFile: null,
    logSizeBytes: 0,
    endReason: "completed",
    source: "live",
    ...extra,
  };
}

/** Channel -> reply; anything unmapped fails the test loudly. */
function replies(map: Record<string, unknown>): void {
  h.invoke.mockImplementation((channel: string) => {
    if (!(channel in map)) throw new Error(`unexpected channel ${channel}`);
    return Promise.resolve(map[channel]);
  });
}

async function importArbi() {
  vi.resetModules();
  return import("../../../src/stores/arbiRuns.js");
}

async function importPt() {
  vi.resetModules();
  return import("../../../src/stores/ptRuns.js");
}

beforeEach(() => {
  h.invoke.mockReset();
  h.on.mockReset();
});

describe("arbi run store", () => {
  it("loads runs, disk usage and the loaded flag from its own channels", async () => {
    replies({ getArbiRuns: { runs: [arbiRun("a")], diskUsageBytes: 42 } });
    const store = await importArbi();

    expect(get(store.arbiRunsLoaded)).toBe(false);
    await store.loadArbiRuns();

    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["a"]);
    expect(get(store.arbiDiskUsageBytes)).toBe(42);
    expect(get(store.arbiRunsLoaded)).toBe(true);
  });

  it("refresh reads the refresh channel", async () => {
    replies({ refreshArbiRuns: { runs: [arbiRun("b")], diskUsageBytes: 7 } });
    const store = await importArbi();

    await store.refreshArbiRuns();

    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["b"]);
    expect(get(store.arbiDiskUsageBytes)).toBe(7);
  });

  it("prepends a pushed run and replaces one it already holds", async () => {
    replies({ getArbiRuns: { runs: [arbiRun("old")], diskUsageBytes: 0 } });
    const store = await importArbi();
    await store.loadArbiRuns();

    store.subscribeArbiRunSaved();
    const [channel, push] = h.on.mock.calls[0] as [string, (run: ArbiRunRecord) => void];
    expect(channel).toBe("arbi-run-saved");

    push(arbiRun("new"));
    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["new", "old"]);

    push(arbiRun("old", { vitusActual: 90 }));
    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["new", "old"]);
    expect(get(store.arbiRuns)[1].vitusActual).toBe(90);
  });

  it("drops a deleted run and re-reads the disk usage", async () => {
    replies({
      getArbiRuns: { runs: [arbiRun("a"), arbiRun("b")], diskUsageBytes: 100 },
      deleteArbiRun: { ok: true },
    });
    const store = await importArbi();
    await store.loadArbiRuns();

    replies({
      getArbiRuns: { runs: [arbiRun("b")], diskUsageBytes: 30 },
      deleteArbiRun: { ok: true },
    });
    await store.deleteArbiRun("a");

    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["b"]);
    expect(get(store.arbiDiskUsageBytes)).toBe(30);
  });

  it("keeps the run when the delete failed", async () => {
    replies({
      getArbiRuns: { runs: [arbiRun("a")], diskUsageBytes: 5 },
      deleteArbiRun: { ok: false },
    });
    const store = await importArbi();
    await store.loadArbiRuns();

    await store.deleteArbiRun("a");

    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["a"]);
  });

  it("patches the record a mutation returns and ignores a null one", async () => {
    replies({
      getArbiRuns: { runs: [arbiRun("a")], diskUsageBytes: 0 },
      setArbiRunVitus: arbiRun("a", { vitusActual: 120 }),
      setArbiRunNotes: null,
    });
    const store = await importArbi();
    await store.loadArbiRuns();

    await store.updateArbiVitus("a", 120);
    expect(get(store.arbiRuns)[0].vitusActual).toBe(120);

    await store.updateArbiNotes("gone", "note");
    expect(get(store.arbiRuns).map((r) => r.id)).toEqual(["a"]);
  });

  it("survives a failing disk-usage refresh after a log delete", async () => {
    replies({
      getArbiRuns: { runs: [arbiRun("a")], diskUsageBytes: 9 },
      deleteArbiRunLog: arbiRun("a", { logFile: null, logSizeBytes: 0 }),
    });
    const store = await importArbi();
    await store.loadArbiRuns();

    h.invoke.mockImplementation((channel: string) => {
      if (channel === "deleteArbiRunLog") return Promise.resolve(arbiRun("a"));
      return Promise.reject(new Error("offline"));
    });
    await expect(store.deleteArbiRunLog("a")).resolves.toBeUndefined();

    expect(get(store.arbiDiskUsageBytes)).toBe(9);
  });
});

describe("Profit-Taker run store", () => {
  it("drives its own channels and event", async () => {
    replies({ getPtRuns: { runs: [ptRun("p1")], diskUsageBytes: 11 } });
    const store = await importPt();

    await store.loadPtRuns();
    store.subscribePtRunSaved();

    expect(get(store.ptRuns).map((r) => r.id)).toEqual(["p1"]);
    expect(get(store.ptDiskUsageBytes)).toBe(11);
    expect(get(store.ptRunsLoaded)).toBe(true);
    expect(h.on.mock.calls[0][0]).toBe("pt-run-saved");
  });

  it("patches tags from the record the main process returns", async () => {
    replies({
      getPtRuns: { runs: [ptRun("p1")], diskUsageBytes: 0 },
      setPtRunTags: ptRun("p1", { tags: ["fast"] }),
    });
    const store = await importPt();
    await store.loadPtRuns();

    await store.updatePtTags("p1", ["fast"]);

    expect(get(store.ptRuns)[0].tags).toEqual(["fast"]);
  });
});
