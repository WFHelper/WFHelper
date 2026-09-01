import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readStatResourceDay,
  STAT_RESOURCES,
  STAT_RESOURCES_VERSION,
  writeLegacyStatFields,
  type DailyStatEntry,
} from "../../config/shared/statsTypes";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

const KUVA = "/Lotus/Types/Items/MiscItems/Kuva";
const DUCATS = "/Lotus/Types/Items/MiscItems/PrimeBucks";
const FORMA = "/Lotus/Types/Items/MiscItems/Forma";

function inventory(opts: {
  plat?: number;
  ducats?: number;
  kuva?: number;
  forma?: number;
}): Record<string, unknown> {
  const misc: Array<{ ItemType: string; ItemCount: number }> = [];
  if (opts.ducats !== undefined) misc.push({ ItemType: DUCATS, ItemCount: opts.ducats });
  if (opts.kuva !== undefined) misc.push({ ItemType: KUVA, ItemCount: opts.kuva });
  if (opts.forma !== undefined) misc.push({ ItemType: FORMA, ItemCount: opts.forma });
  return {
    PremiumCredits: opts.plat ?? 100,
    RegularCredits: 1_000_000,
    FusionPoints: 5000,
    MiscItems: misc,
  };
}

function historyPath(): string {
  return path.join(tmpDir, "stats-history.json");
}

function writeHistoryFile(entries: DailyStatEntry[]): void {
  fs.writeFileSync(historyPath(), JSON.stringify({ schemaVersion: 2, entries }, null, 2));
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-resources-test-"));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("stat resource catalog", () => {
  it("keeps the ids the persisted history and display prefs are keyed by", () => {
    const ids = STAT_RESOURCES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["plat", "credits", "endo", "ducats", "aya", "vitus", "kuva"]) {
      expect(ids).toContain(id);
    }
  });

  it("reads the pre-map fields when an entry has no resource map", () => {
    const legacyEntry: DailyStatEntry = {
      date: "2026-01-01",
      platDelta: 12,
      creditsDelta: -50,
      endoDelta: 0,
      ducatsDelta: 7,
      ayaDelta: 0,
      vitusDelta: 3,
      relicsOpened: 2,
      daysPlayed: 1,
      dailyTrades: 1,
      absPlat: 412,
      absDucats: 900,
    };

    expect(readStatResourceDay(legacyEntry, "plat")).toEqual({ delta: 12, abs: 412 });
    expect(readStatResourceDay(legacyEntry, "ducats")).toEqual({ delta: 7, abs: 900 });
    // No abs recorded for this one, and the delta still survives.
    expect(readStatResourceDay(legacyEntry, "vitus")).toEqual({ delta: 3 });
    // Kuva predates nothing, so a pre-map entry simply has no reading.
    expect(readStatResourceDay(legacyEntry, "kuva")).toBeNull();
  });

  it("prefers the resource map over the pre-map fields", () => {
    const entry: DailyStatEntry = {
      date: "2026-01-02",
      platDelta: 1,
      creditsDelta: 0,
      endoDelta: 0,
      ducatsDelta: 0,
      ayaDelta: 0,
      vitusDelta: 0,
      relicsOpened: 0,
      daysPlayed: 1,
      dailyTrades: 0,
      absPlat: 10,
      resourcesVersion: STAT_RESOURCES_VERSION,
      resources: { plat: { delta: 99, abs: 500 }, kuva: { delta: 25_000, abs: 40_000 } },
    };

    expect(readStatResourceDay(entry, "plat")).toEqual({ delta: 99, abs: 500 });
    expect(readStatResourceDay(entry, "kuva")).toEqual({ delta: 25_000, abs: 40_000 });
  });

  it("mirrors a resource back onto the pre-map fields and ignores new ids", () => {
    const entry: DailyStatEntry = {
      date: "2026-01-03",
      platDelta: 0,
      creditsDelta: 0,
      endoDelta: 0,
      ducatsDelta: 0,
      ayaDelta: 0,
      vitusDelta: 0,
      relicsOpened: 0,
      daysPlayed: 1,
      dailyTrades: 0,
    };

    writeLegacyStatFields(entry, "plat", { delta: 8, abs: 108 });
    writeLegacyStatFields(entry, "vitus", { delta: -2 });
    writeLegacyStatFields(entry, "kuva", { delta: 1000, abs: 5000 });

    expect(entry.platDelta).toBe(8);
    expect(entry.absPlat).toBe(108);
    expect(entry.vitusDelta).toBe(-2);
    expect(entry.absVitus).toBeUndefined();
    expect(Object.keys(entry)).not.toContain("kuvaDelta");
  });
});

describe("statsTracker resource recording", () => {
  it("tracks a Kuva delta and still writes the pre-map fields", async () => {
    const tracker = await import("../../services/statsTracker");

    tracker.onInventoryData(inventory({ plat: 100, ducats: 300, kuva: 12_000 }));
    tracker.onInventoryData(inventory({ plat: 130, ducats: 260, kuva: 24_500 }));

    const entry = tracker.getHistory().at(-1);
    expect(entry?.resourcesVersion).toBe(STAT_RESOURCES_VERSION);
    expect(entry?.resources?.kuva).toEqual({ delta: 12_500, abs: 24_500 });
    // A downgraded build reads these, so they must track the map exactly.
    expect(entry?.platDelta).toBe(30);
    expect(entry?.absPlat).toBe(130);
    expect(entry?.ducatsDelta).toBe(-40);
    expect(entry?.absDucats).toBe(260);

    const session = tracker.getCurrentSession();
    expect(session.resources.kuva).toEqual({ delta: 12_500, current: 24_500 });
    expect(session.platDelta).toBe(30);
    expect(session.currentPlat).toBe(130);
  });

  it("reads a resource missing from a reported MiscItems array as zero", async () => {
    const tracker = await import("../../services/statsTracker");

    tracker.onInventoryData(inventory({ plat: 100 }));

    const entry = tracker.getHistory().at(-1);
    expect(entry?.resources?.plat).toEqual({ delta: 0, abs: 100 });
    // DE drops the row once the count hits zero, so an absent row is a zero.
    expect(entry?.resources?.kuva).toEqual({ delta: 0, abs: 0 });
    // A top-level field the payload never carried stays unreported.
    expect(entry?.resources?.regalAya).toBeUndefined();
  });

  it("keeps the delta and abs when a resource is spent to zero", async () => {
    const tracker = await import("../../services/statsTracker");

    tracker.onInventoryData(inventory({ plat: 100, forma: 3 }));
    tracker.onInventoryData(inventory({ plat: 100, forma: 1 }));
    expect(tracker.getHistory().at(-1)?.resources?.forma).toEqual({ delta: -2, abs: 1 });

    tracker.onInventoryData(inventory({ plat: 100 }));
    expect(tracker.getHistory().at(-1)?.resources?.forma).toEqual({ delta: -3, abs: 0 });
  });

  it("resumes the day's delta after a restart that finds the resource at zero", async () => {
    const first = await import("../../services/statsTracker");
    first.onInventoryData(inventory({ plat: 100, forma: 3 }));
    first.onInventoryData(inventory({ plat: 100 }));
    expect(first.getHistory().at(-1)?.resources?.forma).toEqual({ delta: -3, abs: 0 });

    vi.resetModules();
    const restarted = await import("../../services/statsTracker");
    restarted.loadHistory();
    restarted.onInventoryData(inventory({ plat: 100 }));

    expect(restarted.getHistory().at(-1)?.resources?.forma).toEqual({ delta: -3, abs: 0 });
  });

  it("treats a payload with no MiscItems array as unknown, not as zero", async () => {
    const tracker = await import("../../services/statsTracker");

    tracker.onInventoryData(inventory({ plat: 100, forma: 3 }));
    tracker.onInventoryData(inventory({ plat: 100, forma: 1 }));
    tracker.onInventoryData({ PremiumCredits: 100 });

    // Nothing was reported for Forma, so the last known reading stands.
    expect(tracker.getHistory().at(-1)?.resources?.forma).toEqual({ delta: -2, abs: 1 });
  });

  it("resumes per-resource deltas from a map entry after a restart", async () => {
    const first = await import("../../services/statsTracker");
    first.onInventoryData(inventory({ plat: 100, kuva: 10_000 }));
    first.onInventoryData(inventory({ plat: 150, kuva: 15_000 }));
    expect(first.getHistory().at(-1)?.resources?.kuva?.delta).toBe(5000);

    vi.resetModules();
    const restarted = await import("../../services/statsTracker");
    restarted.loadHistory();
    // Fresh baseline: this reading alone is worth nothing, the resumed total stands.
    restarted.onInventoryData(inventory({ plat: 150, kuva: 15_000 }));
    expect(restarted.getCurrentSession().resources.kuva.delta).toBe(5000);

    restarted.onInventoryData(inventory({ plat: 160, kuva: 17_000 }));
    const entry = restarted.getHistory().at(-1);
    expect(entry?.resources?.kuva?.delta).toBe(7000);
    expect(entry?.resources?.kuva?.abs).toBe(17_000);
    expect(entry?.platDelta).toBe(60);
  });

  it("resumes from a history file written before the resource map", async () => {
    writeHistoryFile([
      {
        date: todayStr(),
        platDelta: 40,
        creditsDelta: 0,
        endoDelta: 0,
        ducatsDelta: 11,
        ayaDelta: 0,
        vitusDelta: 0,
        relicsOpened: 0,
        daysPlayed: 1,
        dailyTrades: 0,
        absPlat: 140,
        absDucats: 311,
      },
    ]);

    const tracker = await import("../../services/statsTracker");
    tracker.loadHistory();
    tracker.onInventoryData(inventory({ plat: 140, ducats: 311, kuva: 900 }));
    tracker.onInventoryData(inventory({ plat: 145, ducats: 311, kuva: 1400 }));

    const entry = tracker.getHistory().at(-1);
    expect(entry?.platDelta).toBe(45);
    expect(entry?.resources?.plat).toEqual({ delta: 45, abs: 145 });
    expect(entry?.ducatsDelta).toBe(11);
    // Kuva had no pre-map field, so it starts counting from this session.
    expect(entry?.resources?.kuva).toEqual({ delta: 500, abs: 1400 });
  });

  it("re-baselines every resource at midnight and keeps the finished day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 30, 12, 0, 0));

    const tracker = await import("../../services/statsTracker");
    tracker.onInventoryData(inventory({ plat: 100, kuva: 10_000 }));
    tracker.onInventoryData(inventory({ plat: 180, kuva: 16_000 }));

    vi.setSystemTime(new Date(2026, 7, 31, 0, 5, 0));
    tracker.onInventoryData(inventory({ plat: 180, kuva: 16_000 }));

    const history = tracker.getHistory();
    const finished = history.find((e) => e.date === "2026-08-30");
    const fresh = history.find((e) => e.date === "2026-08-31");
    expect(finished?.resources?.kuva?.delta).toBe(6000);
    expect(finished?.platDelta).toBe(80);
    expect(fresh?.resources?.kuva).toEqual({ delta: 0, abs: 16_000 });
    expect(fresh?.platDelta).toBe(0);

    tracker.onInventoryData(inventory({ plat: 175, kuva: 16_400 }));
    const after = tracker.getHistory().find((e) => e.date === "2026-08-31");
    expect(after?.resources?.kuva?.delta).toBe(400);
    expect(after?.platDelta).toBe(-5);
    // The finished day must not move when a later day accumulates.
    expect(tracker.getHistory().find((e) => e.date === "2026-08-30")?.platDelta).toBe(80);
  });
});
