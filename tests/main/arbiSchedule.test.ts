import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

import {
  _checkAlertsForTest,
  _resetArbiScheduleForTest,
  _setEntriesForTest,
  buildScheduleEntries,
  computeDueAlerts,
  filterScheduleWindow,
  initArbiSchedule,
  parseArbysText,
  pruneAlertKeys,
  setFavoriteNode,
  setLeadMinutes,
  setOccurrenceAlert,
  shutdownArbiSchedule,
} from "../../services/arbiSchedule";
import type { RegionTranslation } from "../../services/arbiSchedule";
import type { ArbiScheduleEntry } from "../../config/shared/arbiScheduleTypes";

const TRANSLATION: RegionTranslation = {
  regions: {
    SolNode149: {
      name: "/Lotus/Language/Locations/Casta",
      systemName: "/Lotus/Language/Locations/Ceres",
      missionName: "/Lotus/Language/Missions/MissionName_Defense",
      missionType: "MT_DEFENSE",
      faction: "FC_GRINEER",
    },
    SolNode167: {
      name: "/Lotus/Language/Locations/Oestrus",
      systemName: "/Lotus/Language/Locations/Eris",
      missionName: "/Lotus/Language/Missions/MissionName_Purify",
      missionType: "MT_PURIFY",
      faction: "FC_INFESTATION",
    },
    SolNodeVoid: {
      name: "/Lotus/Language/Locations/MotVoid",
      systemName: "/Lotus/Language/Locations/Void",
      missionType: "MT_SURVIVAL",
      faction: "FC_OROKIN",
    },
  },
  dict: {
    "/Lotus/Language/Locations/Casta": "Casta",
    "/Lotus/Language/Locations/Ceres": "Ceres",
    "/Lotus/Language/Locations/Oestrus": "Oestrus",
    "/Lotus/Language/Locations/Eris": "Eris",
    "/Lotus/Language/Locations/MotVoid": "Mot",
    "/Lotus/Language/Locations/Void": "Void",
    "/Lotus/Language/Missions/MissionName_Defense": "DEFENSE",
    "/Lotus/Language/Missions/MissionName_Purify": "INFESTED SALVAGE",
  },
};

function entry(epochMs: number, nodeId = "SolNode149"): ArbiScheduleEntry {
  return { epochMs, nodeId, node: "Casta (Ceres)", mission: "Defense", faction: "Grineer" };
}

describe("parseArbysText", () => {
  it("parses epoch,nodeId lines and skips garbage", () => {
    const text = [
      "1751980800,SolNode149",
      "1751984400,SolNode167",
      "",
      "not-a-line",
      "abc,SolNode1",
      "-5,SolNode1",
      "1751988000,bad node id!",
    ].join("\n");
    expect(parseArbysText(text)).toEqual([
      { epoch: 1751980800, nodeId: "SolNode149" },
      { epoch: 1751984400, nodeId: "SolNode167" },
    ]);
  });
});

describe("buildScheduleEntries", () => {
  it("resolves node, mission and faction labels from region data", () => {
    const [casta, oestrus] = buildScheduleEntries(
      [
        { epoch: 1751980800, nodeId: "SolNode149" },
        { epoch: 1751984400, nodeId: "SolNode167" },
      ],
      TRANSLATION,
    );
    expect(casta).toEqual({
      epochMs: 1751980800000,
      nodeId: "SolNode149",
      node: "Casta (Ceres)",
      mission: "Defense",
      faction: "Grineer",
    });
    // Uppercase dict label title-cased; community faction label overrides dict.
    expect(oestrus.mission).toBe("Infested Salvage");
    expect(oestrus.faction).toBe("Infested");
  });

  it("falls back to MT_/FC_ prettification and raw nodeId", () => {
    const [mot, unknown] = buildScheduleEntries(
      [
        { epoch: 1, nodeId: "SolNodeVoid" },
        { epoch: 2, nodeId: "SolNode999" },
      ],
      TRANSLATION,
    );
    expect(mot.mission).toBe("Survival"); // no missionName -> MT_SURVIVAL
    expect(mot.faction).toBe("Corrupted"); // FC_OROKIN override
    expect(unknown.node).toBe("SolNode999");
    expect(unknown.mission).toBe("Unknown");
  });
});

describe("filterScheduleWindow", () => {
  it("keeps the active hour and sorts ascending", () => {
    const now = 10_000_000_000;
    const hour = 3_600_000;
    const filtered = filterScheduleWindow(
      [entry(now + hour), entry(now - hour / 2), entry(now - 2 * hour)],
      now,
    );
    expect(filtered.map((e) => e.epochMs)).toEqual([now - hour / 2, now + hour]);
  });
});

describe("computeDueAlerts", () => {
  const now = 20_000_000_000;
  const inLead = entry(now + 3 * 60_000); // starts in 3 min
  const outsideLead = entry(now + 30 * 60_000, "SolNode167");
  const started = entry(now - 1);
  const alerts = { occurrences: [], favoriteNodes: [], minutesBefore: 5 };

  it("fires belled occurrences inside the lead window only", () => {
    const key = `${inLead.epochMs}:${inLead.nodeId}`;
    const due = computeDueAlerts(
      [inLead, outsideLead, started],
      { ...alerts, occurrences: [key, `${outsideLead.epochMs}:${outsideLead.nodeId}`] },
      new Set(),
      now,
    );
    expect(due.map((d) => d.key)).toEqual([key]);
  });

  it("fires favorites for every occurrence and respects firedKeys", () => {
    const favAlerts = { ...alerts, favoriteNodes: ["SolNode149"] };
    expect(computeDueAlerts([inLead], favAlerts, new Set(), now)).toHaveLength(1);
    const key = `${inLead.epochMs}:${inLead.nodeId}`;
    expect(computeDueAlerts([inLead], favAlerts, new Set([key]), now)).toHaveLength(0);
  });

  it("never fires for already-started or unbelled entries", () => {
    expect(computeDueAlerts([started, inLead], alerts, new Set(), now)).toHaveLength(0);
  });
});

describe("pruneAlertKeys", () => {
  it("drops keys older than the retention window", () => {
    const now = 30_000_000_000;
    const fresh = `${now - 60_000}:SolNode1`;
    const stale = `${now - 3 * 3_600_000}:SolNode1`;
    expect(pruneAlertKeys([fresh, stale, "junk"], now)).toEqual([fresh]);
  });
});

describe("arbiSchedule service (disk persistence + alert sweep)", () => {
  let notify: ReturnType<typeof vi.fn<(title: string, body: string) => void>>;
  let notificationsEnabled: boolean;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbi-sched-test-"));
    notify = vi.fn<(title: string, body: string) => void>();
    notificationsEnabled = true;
    _resetArbiScheduleForTest();
    initArbiSchedule({ notify, notificationsEnabled: () => notificationsEnabled });
  });

  afterEach(() => {
    shutdownArbiSchedule();
    _resetArbiScheduleForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and sanitizes alert prefs", () => {
    expect(setOccurrenceAlert("1751980800000:SolNode149", true)).toMatchObject({
      occurrences: ["1751980800000:SolNode149"],
    });
    expect(setFavoriteNode("SolNode167", true)).toMatchObject({ favoriteNodes: ["SolNode167"] });
    expect(setLeadMinutes(10)).toMatchObject({ minutesBefore: 10 });
    expect(setLeadMinutes(0)).toBeNull();
    expect(setLeadMinutes(500)).toBeNull();
    expect(setOccurrenceAlert("garbage", true)).toBeNull();

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-sched-alerts.json"), "utf8"));
    expect(raw).toMatchObject({
      occurrences: ["1751980800000:SolNode149"],
      favoriteNodes: ["SolNode167"],
      minutesBefore: 10,
    });
  });

  it("fires a due one-shot bell once and consumes it", () => {
    const soon = entry(Date.now() + 2 * 60_000);
    _setEntriesForTest([soon], Date.now());
    setOccurrenceAlert(`${soon.epochMs}:${soon.nodeId}`, true);

    _checkAlertsForTest();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("Arbitration Alert");
    expect(notify.mock.calls[0][1]).toContain("Casta (Ceres)");

    _checkAlertsForTest();
    expect(notify).toHaveBeenCalledTimes(1);

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-sched-alerts.json"), "utf8"));
    expect(raw.occurrences).toEqual([]);
    expect(raw.firedKeys).toEqual([`${soon.epochMs}:${soon.nodeId}`]);
  });

  it("keeps favorites armed for future occurrences after firing one", () => {
    const soon = entry(Date.now() + 2 * 60_000);
    const later = entry(Date.now() + 4 * 60_000);
    _setEntriesForTest([soon, later], Date.now());
    setFavoriteNode(soon.nodeId, true);

    _checkAlertsForTest();
    // Both occurrences are already inside the default 5-min lead window.
    expect(notify).toHaveBeenCalledTimes(2);
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-sched-alerts.json"), "utf8"));
    expect(raw.favoriteNodes).toEqual([soon.nodeId]);
  });

  it("leaves bells unconsumed while the master toggle is off", () => {
    const soon = entry(Date.now() + 2 * 60_000);
    _setEntriesForTest([soon], Date.now());
    const key = `${soon.epochMs}:${soon.nodeId}`;
    setOccurrenceAlert(key, true);

    notificationsEnabled = false;
    _checkAlertsForTest();
    expect(notify).not.toHaveBeenCalled();

    notificationsEnabled = true;
    _checkAlertsForTest();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
