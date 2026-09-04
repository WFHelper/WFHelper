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

  it("collects squad member names, deduped, only while a run is active", () => {
    const loadoutLine = (ts: number, name: string) =>
      `${ts.toFixed(3)} Game [Info]: ${name} loadout loader finished.`;
    const result = runParser([
      loadoutLine(15, "OrbiterBoot"),
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      loadoutLine(105, "HostPlayer"),
      loadoutLine(112, "ClientOne"),
      loadoutLine(300, "HostPlayer"),
      rewardLine(400),
      rewardLine(700),
    ]);
    expect(result?.players).toEqual(["HostPlayer", "ClientOne"]);
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
      { index: 1, durationSec: 30, saturationPct: 0 },
      { index: 2, durationSec: 25, saturationPct: 0 },
      { index: 3, durationSec: 30, saturationPct: 0 },
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

// Verbatim EE.log lines for an aborted Oestrus arbitration.
const REAL = {
  pendingElite:
    "158.074 Script [Info]: ThemedSquadOverlay.lua: Pending mission: SolNode167_EliteAlert",
  setSquadCapture: `250.845 Net [Info]: Set squad mission: {"difficulty":1,"name":"SolNode162"}`,
  missionNameSuffix:
    "178.428 Script [Info]: ThemedSquadOverlay.lua: Mission name: Oestrus (Eris) - Arbitration",
  syncConsumables:
    "181.561 Sys [Info]: SyncAutoPopulatedConsumables for mission MT_PURIFY with location SolNode167",
  stateStarted: "184.403 Game [Info]: OnStateStarted, mission type=MT_PURIFY",
  abortDialog:
    "233.756 Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=/Lotus/Language/Menu/AbortMissionConfirm, title= leftItem=/Menu/Confirm_Item_Yes, rightItem=/Menu/Confirm_Item_No)",
  abortConfirmed: "234.503 Script [Info]: TopMenu.lua: Abort: host/no session",
  eomCommit: "234.503 Sys [Info]: EOM missionLocationUnlocked=1",
  captureName: "255.746 Script [Info]: ThemedSquadOverlay.lua: Mission name: Isos (Eris)",
  // EndOfMatch.lua initializes in-mission, about 11s in, so it cannot end a run.
  inMissionEndOfMatch: "432.123 Script [Info]: EndOfMatch.lua: Initialize",
  inMissionSucceeded: "432.123 Script [Info]: EndOfMatch.lua: Mission Succeeded",
  survivalReward: "735.449 Sys [Info]: Created /Lotus/Interface/SurvivalReward.swf",
};

describe("arbi run end + type detection (real EE.log lines)", () => {
  it("parses the node from the '<node> - Arbitration' suffix name format", () => {
    const parser = createArbiParser();
    const event = parser.feedLine(REAL.missionNameSuffix);
    expect(event).toEqual({
      type: "run-start",
      missionName: "Oestrus (Eris) - Arbitration",
      node: "Oestrus (Eris)",
      missionType: "other",
      gameTimeSec: 178.428,
    });
  });

  it("detects an arbi via the _EliteAlert sector when the name lacks the keyword", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.pendingElite);
    const event = parser.feedLine(missionLine(178.428, "Oestrus (Eris)"));
    expect(event?.type).toBe("run-start");
    parser.feedLine(REAL.abortConfirmed);
    const parsed = parser.finalize();
    expect(parsed?.solNode).toBe("SolNode167");
    // The sector was consumed at run start: the next plain mission is not an arbi.
    expect(parser.feedLine(REAL.captureName)).toBeNull();
    expect(parser.isRunActive()).toBe(false);
  });

  it("does not end the run on the abort confirm dialog alone", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    expect(parser.feedLine(REAL.abortDialog)).toBeNull();
    expect(parser.isRunActive()).toBe(true);
  });

  it("ends the run as aborted on a confirmed abort", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    expect(parser.feedLine(REAL.abortConfirmed)).toEqual({ type: "run-end", reason: "aborted" });
  });

  it("ends the run on the EOM inventory commit", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    expect(parser.feedLine(REAL.eomCommit)).toEqual({ type: "run-end", reason: "mission-end" });
  });

  it("does not end the run on in-mission EndOfMatch screens", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    expect(parser.feedLine(REAL.inMissionEndOfMatch)).toBeNull();
    expect(parser.feedLine(REAL.inMissionSucceeded)).toBeNull();
    expect(parser.isRunActive()).toBe(true);
    expect(parser.feedLine(REAL.eomCommit)).toEqual({ type: "run-end", reason: "mission-end" });
  });

  it("counts survival rotation rewards", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Mot (Void)"),
      "110.000 Sys [Info]: SyncAutoPopulatedConsumables for mission MT_SURVIVAL with location SolNode409",
      REAL.survivalReward,
      "1035.500 Sys [Info]: Created /Lotus/Interface/SurvivalReward.swf",
    ]);
    expect(result?.rotations).toBe(2);
  });

  it("ignores the survival reward UI outside survivals", () => {
    // Real interception sequence: SurvivalReward.swf popped 25s before the true
    // DefenseReward and must not eat the rotation via the 30s debounce.
    const result = runParser([
      missionLine(99.488, "Rhea (Saturn) - Arbitration"),
      "103.240 Game [Info]: OnStateStarted, mission type=MT_TERRITORY",
      droneLine(104.75),
      "133.194 Script [Info]: TerritoryMission.lua: Alpha has is now under Enemy control",
      "331.811 Sys [Info]: Created /Lotus/Interface/SurvivalReward.swf",
      droneLine(337.236),
      "356.940 Sys [Info]: Created /Lotus/Interface/DefenseReward.swf",
    ]);
    expect(result?.rotations).toBe(1);
    expect(result?.stats?.rewardTimestamps).toEqual([356.94]);
    // duration runs to the real reward, not the last drone
    expect(result?.durationSec).toBeCloseTo(356.94 - 133.194, 3);
  });

  it("captures the engine mission type and node id", () => {
    const result = runParser([REAL.missionNameSuffix, REAL.syncConsumables, REAL.stateStarted]);
    expect(result?.missionTypeRaw).toBe("MT_PURIFY");
    expect(result?.solNode).toBe("SolNode167");
    expect(result?.missionType).toBe("other");
    expect(result?.stats).toBeNull();
  });

  it("spans duration from StartRound to the end marker when no combat was logged", () => {
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    parser.feedLine(REAL.stateStarted);
    parser.feedLine(REAL.abortConfirmed);
    const result = parser.finalize();
    // 184.403 -> 234.503
    expect(result?.durationSec).toBeCloseTo(50.1, 3);
    expect(result?.runEndSec).toBe(234.503);
  });

  it("ignores a sub-second load-drone window and uses the end marker for duration", () => {
    // Level load can create a few drone agents within milliseconds; that must
    // not count as the combat window of an aborted run.
    const parser = createArbiParser();
    parser.feedLine(REAL.missionNameSuffix);
    parser.feedLine(REAL.stateStarted);
    parser.feedLine(droneLine(200.001));
    parser.feedLine(droneLine(200.002));
    parser.feedLine(droneLine(200.003));
    parser.feedLine(REAL.abortConfirmed);
    const result = parser.finalize();
    // first drone 200.001 -> abort 234.503
    expect(result?.durationSec).toBeCloseTo(34.502, 3);
  });

  it("lets the engine type outrank later wave-line heuristics", () => {
    const result = runParser([
      missionLine(100, "Arbitration: Hydron (Sedna)"),
      REAL.syncConsumables,
      waveLine(110, 1),
    ]);
    expect(result?.missionType).toBe("other");
  });

  it("maps MT_DEFENSE and MT_TERRITORY to full-stats types", () => {
    const defense = runParser([
      missionLine(100, "Arbitration: Olympus (Mars)"),
      "110.000 Sys [Info]: SyncAutoPopulatedConsumables for mission MT_DEFENSE with location SolNode30",
    ]);
    expect(defense?.missionType).toBe("defense");
    expect(defense?.stats).not.toBeNull();

    const interception = runParser([
      missionLine(100, "Arbitration: Olympus (Mars)"),
      "110.000 Game [Info]: OnStateStarted, mission type=MT_TERRITORY",
    ]);
    expect(interception?.missionType).toBe("interception");
  });
});

const stateLine = (ts: number, state: string) =>
  `${ts.toFixed(3)} Script [Info]: SentientArtifactMission.lua: Disruption: State change: ${state}`;
const mtLine = (ts: number, mt: string) =>
  `${ts.toFixed(3)} Game [Info]: OnStateStarted, mission type=${mt}`;

describe("disruption runs", () => {
  it("types MT_ARTIFACT as disruption and counts rounds, not reward popups", () => {
    const run = runParser([
      missionLine(100, "Apollo (Lua) - Arbitration"),
      mtLine(101, "MT_ARTIFACT"),
      stateLine(110, "ARTIFACT_ROUND"),
      droneLine(150),
      enemyLine(160, "ButcherAgent", 4),
      // Disruption spams the survival reward UI; it must not count as a rotation.
      `200.000 Sys [Info]: Created /Lotus/Interface/SurvivalReward.swf`,
      `260.000 Sys [Info]: Created /Lotus/Interface/SurvivalReward.swf`,
      stateLine(400, "ARTIFACT_ROUND_DONE"),
      stateLine(401, "REWARDS (host)"),
      stateLine(420, "INTERVAL"),
      stateLine(440, "ARTIFACT_ROUND"),
      droneLine(500),
      stateLine(700, "ARTIFACT_ROUND_DONE"),
    ]);

    expect(run?.missionType).toBe("disruption");
    expect(run?.missionTypeRaw).toBe("MT_ARTIFACT");
    expect(run?.rotations).toBe(2);
    expect(run?.hostTelemetry).toBe(true);
    // Four conduits per round drive the vitus model.
    expect(run?.stats?.wavesPerRotation).toBe(4);
    expect(run?.stats?.waves).toEqual([
      { index: 1, durationSec: 290, saturationPct: 0 },
      { index: 2, durationSec: 260, saturationPct: 0 },
    ]);
    // The interval between rounds is downtime, not fight time.
    expect(run?.stats?.preciseStartSec).toBe(110);
  });
});

describe("joining a mission in progress", () => {
  it("starts a run on the client load when no mission-name line follows", () => {
    const parser = createArbiParser();
    parser.feedLine(
      "2040.984 Script [Info]: ThemedSquadOverlay.lua: Cached mission name=Apollo (Lua) - Arbitration (SolNode308)",
    );
    const event = parser.feedLine(
      '2047.451 Script [Info]: ThemedSquadOverlay.lua: LoadLevelMsg received. Client joining mission in-progress: {"name":"SolNode308_EliteAlert"}',
    );

    expect(event).toEqual({
      type: "run-start",
      missionName: "Apollo (Lua) - Arbitration",
      node: "Apollo (Lua)",
      missionType: "other",
      gameTimeSec: 2047.451,
    });
    // The later "Client loaded" line must not open a second run.
    expect(
      parser.feedLine(
        '2051.361 Script [Info]: Client loaded {"name":"SolNode308_EliteAlert"} with MissionInfo:',
      ),
    ).toBeNull();
    parser.feedLine(droneLine(2100));
    expect(parser.finalize()?.solNode).toBe("SolNode308");
  });

  it("ignores a client load for a normal, non-arbitration mission", () => {
    const parser = createArbiParser();
    const event = parser.feedLine(
      '100.000 Script [Info]: ThemedSquadOverlay.lua: Client loaded {"name":"SolNode308"} with MissionInfo:',
    );
    expect(event).toBeNull();
    expect(parser.isRunActive()).toBe(false);
  });
});

describe("cadence intervals", () => {
  const sleepLine = (ts: number) =>
    `${ts.toFixed(3)} Script [Info]: WaveDefend.lua: _SleepBetweenWaves`;

  it("records reward pauses and tick-stream stalls", () => {
    const parsed = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      waveLine(110, 1),
      droneLine(120),
      droneLine(130),
      sleepLine(140),
      waveStartLine(160, 2),
      droneLine(170),
      tickLine(200, 5),
      tickLine(210, 6),
      // 90s without a tick line: a load screen or host stall, not gameplay.
      tickLine(300, 7),
      rewardLine(400),
      waveStartLine(430, 4),
      droneLine(440),
      rewardLine(700),
    ]);

    expect(parsed?.stats?.pauseIntervals).toEqual([
      { start: 140, end: 160 },
      { start: 400, end: 430 },
    ]);
    expect(parsed?.stats?.idleIntervals).toEqual([{ start: 210, end: 300 }]);
  });

  it("closes a reward pause the log never unpauses", () => {
    const parsed = runParser([
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      waveLine(110, 1),
      droneLine(120),
      rewardLine(400),
      waveStartLine(430, 4),
      droneLine(440),
      rewardLine(700),
      droneLine(750),
    ]);

    expect(parsed?.stats?.pauseIntervals).toEqual([
      { start: 400, end: 430 },
      { start: 700, end: 750 },
    ]);
  });
});

const spawnPointLine = (ts: number, point: string, x: number, y: number, z: number) =>
  `${ts.toFixed(3)} Script [Info]: WaveDefend.lua: Spawned a /Npc/ShieldLancer10 @ Vector(1, 2, 3), ` +
  `spawn point: ${point} @ Vector(${x}, ${y}, ${z}), total spawned in current wave: 1`;

describe("spawn points", () => {
  it("aggregates by id and keeps the spawn point's own vector, rounded", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      spawnPointLine(91, "/Layer1/Layer1/NpcSpawnPoint37", 50.25, 98.0789, 53),
      spawnPointLine(92, "/Layer1/Layer1/NpcSpawnPoint37", 50.25, 98.0789, 53),
      spawnPointLine(93, "/Layer1/Layer1/NpcSpawnPoint177", 117, 106.75, 29),
      droneLine(100),
    ]);

    expect(result?.stats?.spawnPoints).toEqual([
      { id: "/Layer1/Layer1/NpcSpawnPoint37", x: 50.3, y: 98.1, z: 53, count: 2 },
      { id: "/Layer1/Layer1/NpcSpawnPoint177", x: 117, y: 106.8, z: 29, count: 1 },
    ]);
  });

  it("ignores spawn lines logged before the run starts", () => {
    const result = runParser([
      spawnPointLine(10, "/Layer1/NpcSpawnPoint1", 1, 2, 3),
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(90, 1),
      spawnPointLine(91, "/Layer1/NpcSpawnPoint2", 4, 5, 6),
      droneLine(100),
    ]);

    expect(result?.stats?.spawnPoints).toEqual([
      { id: "/Layer1/NpcSpawnPoint2", x: 4, y: 5, z: 6, count: 1 },
    ]);
  });

  it("caps distinct points but keeps counting the ones it already knows", () => {
    const lines = [missionLine(80, "Arbitration: Casta Defense (Ceres)"), waveLine(90, 1)];
    for (let i = 0; i < 305; i++) {
      lines.push(spawnPointLine(100 + i, `/Layer1/NpcSpawnPoint${i}`, i, 0, i));
    }
    lines.push(spawnPointLine(500, "/Layer1/NpcSpawnPoint0", 0, 0, 0));
    lines.push(droneLine(510));

    const points = runParser(lines)?.stats?.spawnPoints ?? [];
    expect(points).toHaveLength(300);
    expect(points[0]).toEqual({ id: "/Layer1/NpcSpawnPoint0", x: 0, y: 0, z: 0, count: 2 });
    expect(points.some((p) => p.id === "/Layer1/NpcSpawnPoint300")).toBe(false);
  });

  it("emits an empty list for interception, which logs no spawn points", () => {
    const result = runParser([
      missionLine(99, "Rhea (Saturn) - Arbitration"),
      "103.240 Game [Info]: OnStateStarted, mission type=MT_TERRITORY",
      droneLine(120),
      "133.194 Script [Info]: TerritoryMission.lua: Alpha has is now under Enemy control",
      "356.940 Sys [Info]: Created /Lotus/Interface/DefenseReward.swf",
    ]);

    expect(result?.missionType).toBe("interception");
    expect(result?.stats?.spawnPoints).toEqual([]);
  });
});

describe("window saturation", () => {
  it("scores each wave over its own window", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(100, 1),
      tickLine(100, 20),
      tickLine(110, 2),
      tickLine(120, 2),
      sleep3Line(130),
      waveLine(140, 2),
      tickLine(140, 20),
      tickLine(150, 20),
      tickLine(160, 20),
      sleep3Line(165),
      droneLine(170),
    ]);

    const waves = result?.stats?.waves ?? [];
    expect(waves.map((w) => w.durationSec)).toEqual([30, 25]);
    expect(waves[0].saturationPct).toBeCloseTo(100 / 3, 6);
    expect(waves[1].saturationPct).toBeCloseTo(100, 6);
  });

  it("scores one rotation window per reward and drops paused segments", () => {
    const result = runParser([
      missionLine(80, "Arbitration: Casta Defense (Ceres)"),
      waveLine(100, 1),
      tickLine(100, 20),
      tickLine(110, 20),
      tickLine(120, 2),
      rewardLine(130),
      waveStartLine(140, 2),
      tickLine(140, 20),
      tickLine(150, 2),
      tickLine(160, 2),
      rewardLine(200),
      droneLine(210),
    ]);

    expect(result?.stats?.rewardTimestamps).toEqual([130, 200]);
    const pct = result?.stats?.rotationSaturationPct ?? [];
    expect(pct).toHaveLength(result?.stats?.rewardTimestamps.length ?? 0);
    expect(pct[0]).toBeCloseTo(200 / 3, 6);
    // Without the [130,140] pause exclusion this window would read 33.3%.
    expect(pct[1]).toBeCloseTo(50, 6);
  });
});
