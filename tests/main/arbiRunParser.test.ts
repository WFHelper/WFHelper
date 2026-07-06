import { describe, expect, it } from "vitest";

import { createArbiParser } from "../../services/arbiRunParser";
import type { ArbiParsedRun } from "../../services/arbiRunParser";

const missionLine = (ts: number, name: string) =>
  `${ts.toFixed(3)} Script [Info]: ThemedSquadOverlay.lua: Mission name: ${name}`;
const droneLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent7`;
const enemyLine = (ts: number, name: string, tick: number) =>
  `${ts.toFixed(3)} AI [Info]: OnAgentCreated /Npc/${name}3 pos MonitoredTicking ${tick}`;
const rewardLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: Created /Lotus/Interface/DefenseReward.swf`;
const tickLine = (ts: number, count: number) =>
  `${ts.toFixed(3)} AI [Info]: NpcManager status MonitoredTicking ${count}`;
const waveLine = (ts: number, wave: number) =>
  `${ts.toFixed(3)} Script [Info]: WaveDefend.lua: Defense wave: ${wave}`;
const waveStartLine = (ts: number, wave: number) =>
  `${ts.toFixed(3)} Script [Info]: WaveDefend.lua: Starting wave ${wave} (32 simultaneous)`;
const sleep3Line = (ts: number) =>
  `${ts.toFixed(3)} Script [Info]: WaveDefend.lua: _SleepBetweenWaves(3)`;
const countdownLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: Created /Lotus/Interface/ProjectionsCountdown.swf`;

function runParser(lines: string[]): ArbiParsedRun | null {
  const parser = createArbiParser();
  for (const line of lines) parser.feedLine(line);
  return parser.finalize();
}

describe("arbi run detection", () => {
  it("starts a run on an arbitration mission name", () => {
    const parser = createArbiParser();
    const event = parser.feedLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"));
    expect(event).toEqual({
      type: "run-start",
      missionName: "Arbitration: Casta Defense (Ceres)",
      node: "Casta Defense (Ceres)",
      missionType: "defense",
      gameTimeSec: 100,
    });
    expect(parser.isRunActive()).toBe(true);
  });

  it("ignores non-arbitration missions when idle", () => {
    const parser = createArbiParser();
    expect(parser.feedLine(missionLine(100, "Casta (Ceres)"))).toBeNull();
    expect(parser.isRunActive()).toBe(false);
  });

  it("classifies interception and mirror defense", () => {
    const parser = createArbiParser();
    const inter = parser.feedLine(missionLine(1, "Arbitration: Berehynia Interception (Sedna)"));
    expect(inter?.type === "run-start" && inter.missionType).toBe("interception");
    parser.reset();
    const mirror = parser.feedLine(missionLine(1, "Arbitration: Tyana Pass (Mars)"));
    expect(mirror?.type === "run-start" && mirror.missionType).toBe("defense");
  });

  it("classifies unknown modes as other with null stats", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Olympus (Mars)"),
      rewardLine(400),
      rewardLine(700),
    ]);
    expect(result?.missionType).toBe("other");
    expect(result?.stats).toBeNull();
    expect(result?.rotations).toBe(2);
  });

  it("upgrades other to defense when wave lines appear", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Hydron (Sedna)"),
      waveLine(110, 1),
      droneLine(150),
      droneLine(200),
    ]);
    expect(result?.missionType).toBe("defense");
    expect(result?.stats).not.toBeNull();
  });

  it("ends the run on a new mission name", () => {
    const parser = createArbiParser();
    parser.feedLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"));
    const event = parser.feedLine(missionLine(900, "Cetus (Earth)"));
    expect(event).toEqual({ type: "run-end", reason: "new-mission" });
  });

  it("ignores host-migration replays of the mission name", () => {
    const parser = createArbiParser();
    parser.feedLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"));
    parser.feedLine(droneLine(500));
    expect(parser.feedLine(missionLine(300, "Arbitration: Casta Defense (Ceres)"))).toBeNull();
    expect(parser.isRunActive()).toBe(true);
    const event = parser.feedLine(missionLine(600, "Arbitration: Casta Defense (Ceres)"));
    expect(event).toEqual({ type: "run-end", reason: "new-mission" });
  });
});

describe("arbi run counting", () => {
  it("counts drones separately from enemies and skips excluded agents", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      droneLine(110),
      droneLine(120),
      enemyLine(130, "GrineerLancerAgent", 5),
      enemyLine(131, "GrineerLancerAgent", 6),
      `132.000 AI [Info]: OnAgentCreated /Npc/TurretAgent3 MonitoredTicking 7`,
    ]);
    expect(result?.drones).toBe(2);
    // 2 valid enemy spawns + 2 drones; turret excluded
    expect(result?.totalEnemies).toBe(4);
  });

  it("excludes agents whose tick counter never advances", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      enemyLine(110, "DecorativeAgent", 5),
      enemyLine(111, "DecorativeAgent", 5),
      enemyLine(112, "DecorativeAgent", 5),
      enemyLine(113, "RealAgent", 5),
    ]);
    // Decorative suspected non-ticking on every pair, never confirmed; Real never suspected.
    expect(result?.totalEnemies).toBe(1);
  });

  it("skips spam lines entirely", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      `110.000 Game [Warning]: OnAgentCreated /Npc/GrineerLancerAgent3 MonitoredTicking 5`,
      `111.000 AI [Info]: OnAgentCreated /Npc/LancerAgent3 DamagePct MonitoredTicking 6`,
    ]);
    expect(result?.totalEnemies).toBe(0);
  });

  it("debounces rotation rewards within 30s", () => {
    const close = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      rewardLine(400),
      rewardLine(420),
    ]);
    expect(close?.rotations).toBe(1);
    const apart = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      rewardLine(400),
      rewardLine(440),
    ]);
    expect(apart?.rotations).toBe(2);
  });
});

describe("arbi run stats", () => {
  it("computes duration from precise start to last activity", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      droneLine(100),
      droneLine(130),
    ]);
    expect(result?.durationSec).toBe(40);
    expect(result?.stats?.preciseStartSec).toBe(90);
    expect(result?.stats?.avgDroneIntervalSec).toBe(30);
  });

  it("falls back to the first drone when no precise start exists", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Berehynia Interception (Sedna)"),
      droneLine(100),
      droneLine(150),
    ]);
    expect(result?.durationSec).toBe(50);
  });

  it("builds the saturation histogram from tick samples", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      tickLine(100, 2),
      tickLine(110, 16),
      tickLine(120, 5),
      droneLine(130),
    ]);
    const buckets = result?.stats?.saturationBuckets ?? [];
    expect(buckets).toHaveLength(10);
    expect(buckets[0].label).toBe("0-2");
    expect(buckets[0].pct).toBeCloseTo(50, 6);
    expect(buckets[5].label).toBe("15-17");
    expect(buckets[5].pct).toBeCloseTo(50, 6);
    expect(buckets[9].label).toBe("27+");
  });

  it("excludes paused segments from saturation", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      tickLine(100, 2),
      `105.000 Script [Info]: WaveDefend.lua: _SleepBetweenWaves(10)`,
      tickLine(110, 16),
      waveStartLine(115, 2),
      tickLine(120, 5),
      droneLine(130),
    ]);
    const buckets = result?.stats?.saturationBuckets ?? [];
    // segment starting at 110 falls inside the [105,115] pause and is dropped
    expect(buckets[0].pct).toBeCloseTo(100, 6);
    expect(buckets[5].pct).toBe(0);
  });

  it("computes wave durations including the every-3rd-wave countdown path", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(100, 1),
      sleep3Line(130),
      waveLine(140, 2),
      sleep3Line(165),
      waveLine(170, 3),
      countdownLine(205),
      droneLine(210),
    ]);
    expect(result?.stats?.waves).toEqual([
      { index: 1, durationSec: 30 },
      { index: 2, durationSec: 25 },
      { index: 3, durationSec: 30 },
    ]);
  });

  it("computes the vitus model from rotations and drones", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      droneLine(100),
      rewardLine(400),
    ]);
    expect(result?.stats?.expectedVitusMean).toBeGreaterThan(0);
    expect(result?.stats?.wavesPerRotation).toBe(3);
  });

  it("returns null when finalizing with no active run", () => {
    const parser = createArbiParser();
    expect(parser.finalize()).toBeNull();
  });
});
