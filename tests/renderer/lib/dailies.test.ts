import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "../../../src/i18n/en.js";
import {
  BUILTIN_TASKS,
  addCustomTask,
  expiryPeriodKey,
  loadTracker,
  pruneDynamicProgress,
  removeCustomTask,
  saveTracker,
  setTrackerCount,
  setTrackerPeriod,
  setTrackerTarget,
  toggleTrackerHidden,
  trackerCount,
  trackerGroup,
  trackerList,
  trackerPeriodKey,
  type TrackerExpiries,
  type TrackerState,
} from "../../../src/lib/world/dailies.js";

const NOW = Date.parse("2026-08-24T12:00:00Z");

const NO_EXPIRIES: TrackerExpiries = {
  sortie: null,
  archon: null,
  steelPath: null,
  descendia: null,
  calendar1999: null,
  baro: null,
  darvo: null,
  varzia: null,
};

function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const mem = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  return mem;
}

function emptyState(): TrackerState {
  return { progress: {}, hidden: [], periods: {}, custom: [], seq: 0 };
}

describe("trackerPeriodKey", () => {
  it("holds one key for the whole UTC day and flips at the daily reset", () => {
    const morning = trackerPeriodKey("daily", new Date("2026-08-24T01:00:00Z"), NO_EXPIRIES);
    const evening = trackerPeriodKey("daily", new Date("2026-08-24T23:59:00Z"), NO_EXPIRIES);
    const nextDay = trackerPeriodKey("daily", new Date("2026-08-25T00:01:00Z"), NO_EXPIRIES);

    expect(morning).toBe(evening);
    expect(nextDay).not.toBe(morning);
  });

  it("holds one key across the week and flips at Monday 00:00 UTC", () => {
    // 2026-08-24 is a Monday, so the window runs to the following Monday.
    const monday = trackerPeriodKey("weekly", new Date("2026-08-24T00:01:00Z"), NO_EXPIRIES);
    const sunday = trackerPeriodKey("weekly", new Date("2026-08-30T23:59:00Z"), NO_EXPIRIES);
    const nextMonday = trackerPeriodKey("weekly", new Date("2026-08-31T00:01:00Z"), NO_EXPIRIES);

    expect(monday).toBe(sunday);
    expect(nextMonday).not.toBe(monday);
  });

  it("computes the 4-day vendor grids from their anchors without world data", () => {
    // Wiki anchors: Tenet boundaries fall on Aug 19/23/27 2026, Coda on Aug 20/24/28.
    const now = new Date("2026-08-24T12:00:00Z");
    expect(trackerPeriodKey("tenet", now, NO_EXPIRIES)).toBe("tenet:2026-08-27T00:00:00.000Z");
    expect(trackerPeriodKey("coda", now, NO_EXPIRIES)).toBe("coda:2026-08-28T00:00:00.000Z");
    const nextTenet = trackerPeriodKey("tenet", new Date("2026-08-27T00:01:00Z"), NO_EXPIRIES);
    expect(nextTenet).toBe("tenet:2026-08-31T00:00:00.000Z");
  });

  it("keys expiry-driven periods off the world-state window", () => {
    const now = new Date("2026-08-24T10:00:00Z");
    const first = trackerPeriodKey("baro", now, { ...NO_EXPIRIES, baro: "2026-08-28T14:00:00Z" });
    const second = trackerPeriodKey("baro", now, { ...NO_EXPIRIES, baro: "2026-09-11T14:00:00Z" });

    expect(first).not.toBe(second);
  });

  it("returns null while the expiry is unknown so progress is not cleared blind", () => {
    expect(trackerPeriodKey("archon", new Date(), NO_EXPIRIES)).toBeNull();
    expect(expiryPeriodKey("nw", null)).toBeNull();
    expect(expiryPeriodKey("nw", "2026-08-25T00:00:00Z")).toBe("nw:2026-08-25T00:00:00Z");
  });
});

describe("trackerGroup", () => {
  it("routes vendors, weekly rotations and daily tasks to their sections", () => {
    expect(trackerGroup("baro")).toBe("vendors");
    expect(trackerGroup("darvo")).toBe("vendors");
    expect(trackerGroup("varzia")).toBe("vendors");
    expect(trackerGroup("archon")).toBe("weekly");
    expect(trackerGroup("steelPath")).toBe("weekly");
    expect(trackerGroup("weekly")).toBe("weekly");
    expect(trackerGroup("sortie")).toBe("daily");
    expect(trackerGroup("daily")).toBe("daily");
  });
});

describe("trackerCount", () => {
  it("clears a count recorded in an earlier period", () => {
    const state = setTrackerCount(emptyState(), "netracells", "weekly:old", 3);

    expect(trackerCount(state, "netracells", "weekly:old", NOW)).toBe(3);
    expect(trackerCount(state, "netracells", "weekly:new", NOW)).toBe(0);
  });

  it("keeps a still-open window when the period is unknown", () => {
    const state = setTrackerCount(emptyState(), "sortie", "sortie:2026-08-25T12:00:00Z", 1);

    expect(trackerCount(state, "sortie", null, NOW)).toBe(1);
  });

  it("retires a closed window when the period is unknown", () => {
    const state = setTrackerCount(emptyState(), "sortie", "sortie:2026-08-23T12:00:00Z", 1);

    expect(trackerCount(state, "sortie", null, NOW)).toBe(0);
  });

  it("keeps a Baro tick mid-visit, whose key holds the activation not an expiry", () => {
    const state = setTrackerCount(emptyState(), "baro", "baro:2026-08-21T14:00:00Z", 1);

    expect(trackerCount(state, "baro", null, NOW)).toBe(1);
  });

  it("keeps the stored count when the key carries no usable expiry", () => {
    const malformed = setTrackerCount(emptyState(), "sortie", "not-a-key", 1);
    const blank = setTrackerCount(emptyState(), "sortie", "", 1);

    expect(trackerCount(malformed, "sortie", null, NOW)).toBe(1);
    expect(trackerCount(blank, "sortie", null, NOW)).toBe(1);
  });

  it("never goes below zero", () => {
    const state = setTrackerCount(emptyState(), "spIncursions", "daily:x", -4);

    expect(trackerCount(state, "spIncursions", "daily:x", NOW)).toBe(0);
  });
});

describe("pruneDynamicProgress", () => {
  it("drops rotated Nightwave and alert rows but keeps built-ins", () => {
    let state = setTrackerCount(emptyState(), "nw:old-act", "nw:a", 1);
    state = setTrackerCount(state, "nw:live-act", "nw:b", 1);
    state = setTrackerCount(state, "alert:gone", "alert:c", 1);
    state = setTrackerCount(state, "netracells", "weekly:x", 2);

    const pruned = pruneDynamicProgress(state, new Set(["nw:live-act", "netracells"]));

    expect(Object.keys(pruned.progress).sort()).toEqual(["netracells", "nw:live-act"]);
  });

  it("returns the same object when nothing is stale", () => {
    const state = setTrackerCount(emptyState(), "nw:live", "nw:a", 1);

    expect(pruneDynamicProgress(state, new Set(["nw:live"]))).toBe(state);
  });

  it("drops everything for an empty live set, which is why the caller must skip it", () => {
    const state = setTrackerCount(emptyState(), "nw:act", "nw:a", 1);

    expect(pruneDynamicProgress(state, new Set()).progress["nw:act"]).toBeUndefined();
    // Skipping the call is the only thing that keeps progress across a world-state outage.
    expect(state.progress["nw:act"]).toEqual({ key: "nw:a", count: 1 });
  });
});

describe("custom tasks", () => {
  it("adds a task under a fresh id and never reuses it after removal", () => {
    const added = addCustomTask(emptyState(), "  Kuva farm  ", "weekly");
    const [task] = added.custom;

    expect(task.label).toBe("Kuva farm");
    expect(task.period).toBe("weekly");

    const reAdded = addCustomTask(removeCustomTask(added, task.id), "Other", "daily");
    expect(reAdded.custom[0].id).not.toBe(task.id);
  });

  it("ignores a blank label", () => {
    const state = emptyState();
    expect(addCustomTask(state, "   ", "daily")).toBe(state);
  });

  it("retargets only custom tasks and clamps the value", () => {
    let state = addCustomTask(emptyState(), "Kuva farm", "daily");
    const id = state.custom[0].id;
    state = setTrackerTarget(state, id, 250);

    expect(state.custom[0].target).toBe(99);
    expect(setTrackerTarget(state, id, 0).custom[0].target).toBe(1);
  });

  it("drops progress, hidden state and the period override with the task", () => {
    let state = addCustomTask(emptyState(), "Kuva farm", "daily");
    const id = state.custom[0].id;
    state = setTrackerCount(state, id, "daily:x", 1);
    state = toggleTrackerHidden(state, id);
    state = setTrackerPeriod(state, id, "weekly");

    const removed = removeCustomTask(state, id);

    expect(removed.custom).toEqual([]);
    expect(removed.progress[id]).toBeUndefined();
    expect(removed.hidden).not.toContain(id);
    expect(removed.periods[id]).toBeUndefined();
  });

  it("leaves the state untouched when the id is not a custom task", () => {
    const state = emptyState();
    expect(removeCustomTask(state, "sortie")).toBe(state);
  });
});

describe("trackerList", () => {
  it("applies a user period override to a built-in task", () => {
    const state = setTrackerPeriod(emptyState(), "palladino", "daily");
    const task = trackerList(state).find((entry) => entry.id === "palladino");

    expect(task?.period).toBe("daily");
    expect(BUILTIN_TASKS.find((entry) => entry.id === "palladino")?.period).toBe("weekly");
  });

  it("appends custom tasks after the built-ins", () => {
    const state = addCustomTask(emptyState(), "Kuva farm", "daily");
    const list = trackerList(state);

    expect(list).toHaveLength(BUILTIN_TASKS.length + 1);
    expect(list[list.length - 1].label).toBe("Kuva farm");
  });

  it("labels every built-in from the catalogue and custom tasks from their own text", () => {
    const state = addCustomTask(emptyState(), "Kuva farm", "daily");
    const unlabelled = trackerList(state).filter(
      (task) => !(task.label ?? (task.labelKey ? en[task.labelKey] : "")),
    );

    expect(unlabelled.map((task) => task.id)).toEqual([]);
  });
});

describe("persistence", () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips progress, overrides and custom tasks", () => {
    let state = addCustomTask(emptyState(), "Kuva farm", "weekly");
    state = setTrackerCount(state, "netracells", "weekly:x", 2);
    state = toggleTrackerHidden(state, "deepArchimedea");
    saveTracker(state);

    expect(loadTracker()).toEqual(state);
  });

  it("falls back to an empty state on corrupt storage", () => {
    stubStorage({ "world-dailies": "{not json" });

    expect(loadTracker()).toEqual(emptyState());
  });

  it("carries ergoGlast progress and hidden state to palladino", () => {
    stubStorage({
      "world-dailies": JSON.stringify({
        progress: { ergoGlast: { key: "weekly:x", count: 1 } },
        hidden: ["ergoGlast"],
        periods: { ergoGlast: "weekly" },
        custom: [],
        seq: 0,
      }),
    });

    const state = loadTracker();
    expect(state.progress["palladino"]).toEqual({ key: "weekly:x", count: 1 });
    expect(state.progress["ergoGlast"]).toBeUndefined();
    expect(state.hidden).toEqual(["palladino"]);
    expect(state.periods["palladino"]).toBe("weekly");
    expect(state.periods["ergoGlast"]).toBeUndefined();
  });

  it("drops malformed entries instead of failing the load", () => {
    stubStorage({
      "world-dailies": JSON.stringify({
        progress: { good: { key: "daily:x", count: 2 }, bad: { key: 5, count: "3" } },
        hidden: ["sortie", 7],
        periods: { sortie: "weekly", clem: "hourly" },
        custom: [{ id: "custom:1", label: "Kuva farm" }, { id: "custom:2" }],
        seq: 1,
      }),
    });

    const state = loadTracker();

    expect(Object.keys(state.progress)).toEqual(["good"]);
    expect(state.hidden).toEqual(["sortie"]);
    expect(state.periods).toEqual({ sortie: "weekly" });
    expect(state.custom).toEqual([
      { id: "custom:1", label: "Kuva farm", period: "daily", target: 1 },
    ]);
  });

  it("recovers a usable seq when the stored one is missing", () => {
    stubStorage({
      "world-dailies": JSON.stringify({
        custom: [{ id: "custom:1", label: "Kuva farm", period: "daily", target: 1 }],
      }),
    });

    expect(loadTracker().seq).toBe(1);
  });
});
