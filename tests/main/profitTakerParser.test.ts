import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProfitTakerParser } from "../../services/profitTakerParser";
import type { PtParsedRun } from "../../services/profitTakerParser";

const FIXTURES = path.join(__dirname, "..", "fixtures", "pt");

/** Times come straight from EE.log floats; a millisecond of slack is plenty. */
const TOL = 0.01;

function parseAll(lines: readonly string[]): PtParsedRun[] {
  const parser = createProfitTakerParser();
  const runs: PtParsedRun[] = [];
  for (const line of lines) {
    const event = parser.feedLine(line);
    if (event?.type !== "run-end") continue;
    const parsed = parser.finalize();
    if (parsed) runs.push(parsed);
    parser.feedLine(line);
  }
  if (parser.isRunActive()) {
    const parsed = parser.finalize();
    if (parsed) runs.push(parsed);
  }
  return runs;
}

function parseFixture(name: string): PtParsedRun[] {
  return parseAll(fs.readFileSync(path.join(FIXTURES, name), "utf-8").split(/\r?\n/));
}

const ts = (value: number) => value.toFixed(3);
const sessionLine = (t: number) =>
  `${ts(t)} Script [Info]: EidolonMP.lua: Session map string: /Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyFour`;
const elevatorLine = (t: number) =>
  `${ts(t)} Script [Info]: EidolonMP.lua: EIDOLONMP: Avatar left the zone: TennoAvatar1, player pos: Vector(0, 0, 0)`;
const phaseLine = (t: number, which: string) =>
  `${ts(t)} Script [Info]: CamperHeistOrbFight.lua: Orb Fight - Starting ${which} attack Orb phase`;
const shieldLine = (t: number, element: string) =>
  `${ts(t)} AI [Info]: Camper->SwitchShieldVulnerability() - Switching shield damage vulnerability type to ${element}`;
const shieldEndLine = (t: number, id: string) =>
  `${ts(t)} Sys [Info]: ResourceLoader 0x1 (/Lotus/Sounds/Dialog/FortunaOrbHeist/Business/${id}) Found 479 items to load (1ms)`;
const legLine = (t: number, part: string) =>
  `${ts(t)} AI [Info]: Camper->DestroyLeg() - Leg freshly destroyed at part: ${part}`;
const vulnerableLine = (t: number) =>
  `${ts(t)} AI [Info]: Camper->StartVulnerable() - The Camper can now be damaged!`;
const stateLine = (t: number, state: number) =>
  `${ts(t)} Script [Info]: CamperHeistOrbFight.lua: Landscape - New State: ${state} for /Lotus/Types/Gameplay/Venus/Encounters/Heists/CamperHeistOrbFight on DynamicRandomEncounterHint, was 0`;
const pylonLine = (t: number) =>
  `${ts(t)} Script [Info]: ArachnoidCamperScript.lua: Pylon launch complete`;

describe("profitTakerParser", () => {
  it("matches the reference analyser on a recorded host run", () => {
    const runs = parseFixture("host-single-run.log");
    expect(runs).toHaveLength(1);
    const run = runs[0];

    expect(run.confirmed).toBe(true);
    expect(run.complete).toBe(true);
    expect(run.bugged).toBe(false);
    expect(run.aborted).toBe(false);
    expect(run.hostTelemetry).toBe(true);
    expect(run.hostMigration).toBe(false);
    expect(run.flightUnreliable).toBe(false);
    expect(run.players).toEqual(["HostPlayer", "ClientOne"]);

    expect(run.runStartSec).toBeCloseTo(5316.394, 3);
    expect(run.runEndSec).toBeCloseTo(5429.365, 3);
    expect(run.flightSec).toBeCloseTo(11.339, 2);
    expect(run.durationSec).toBeCloseTo(112.971, 2);
    expect(run.shieldSec).toBeCloseTo(27.25, 2);
    expect(run.legSec).toBeCloseTo(27.107, 2);
    expect(run.bodySec).toBeCloseTo(2.131, 2);
    expect(run.pylonSec).toBeCloseTo(24.573, 2);

    expect(run.phases.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    expect(run.phases.map((p) => p.totalSec)).toEqual([
      expect.closeTo(39.662, 2),
      expect.closeTo(9.728, 2),
      expect.closeTo(39.193, 2),
      expect.closeTo(13.049, 2),
    ]);
  });

  it("splits each phase into shields, legs, body and pylons", () => {
    const [run] = parseFixture("host-single-run.log");
    const [p1, p2, p3, p4] = run.phases;

    expect(p1.shields).toEqual([
      { element: "electric", seconds: expect.closeTo(4.488, 2) },
      { element: "toxin", seconds: expect.closeTo(4.372, 2) },
      { element: "slash", seconds: expect.closeTo(3.521, 2) },
      { element: "magnetic", seconds: expect.closeTo(0.006, 2) },
    ]);
    expect(p1.legs.map((leg) => leg.leg)).toEqual([
      "backLeft",
      "frontRight",
      "frontLeft",
      "backRight",
    ]);
    expect(p1.legs[0].seconds).toBeCloseTo(2.017, 2);
    expect(p1.shieldSec).toBeCloseTo(12.387, 2);
    expect(p1.legSec).toBeCloseTo(6.687, 2);
    expect(p1.bodySec).toBeCloseTo(0.887, 2);
    expect(p1.pylonSec).toBeCloseTo(12.228, 2);

    // Phase 2 has no shield phase and no pylons.
    expect(p2.shields).toEqual([]);
    expect(p2.legSec).toBeCloseTo(7.282, 2);
    expect(p2.bodySec).toBeCloseTo(0.206, 2);
    expect(p2.pylonSec).toBe(0);

    expect(p3.shields.map((s) => s.element)).toEqual([
      "cold",
      "radiation",
      "corrosive",
      "viral",
      "puncture",
      "heat",
    ]);
    expect(p3.shieldSec).toBeCloseTo(10.436, 2);
    expect(p3.legSec).toBeCloseTo(7.195, 2);
    expect(p3.bodySec).toBeCloseTo(0.631, 2);
    expect(p3.pylonSec).toBeCloseTo(12.345, 2);

    // The phase-3 pylon switch carries its element into phase 4.
    expect(p4.shields[0]).toEqual({ element: "gas", seconds: expect.closeTo(3.28, 2) });
    expect(p4.shieldSec).toBeCloseTo(4.427, 2);
    expect(p4.legSec).toBeCloseTo(5.943, 2);
    expect(p4.bodySec).toBeCloseTo(0.407, 2);
    expect(p4.pylonSec).toBe(0);
  });

  it("reads both runs out of a two-run log and falls back for a missing elevator exit", () => {
    const runs = parseFixture("host-two-runs.log");
    expect(runs).toHaveLength(2);
    const [, second] = runs;

    expect(second.complete).toBe(true);
    expect(second.players).toEqual(["HostPlayer"]);
    // No "Avatar left the zone" line, so flight is measured from the job-start line.
    expect(second.flightUnreliable).toBe(true);
    expect(second.runStartSec).toBeCloseTo(5704.634, 3);
    expect(second.flightSec).toBeCloseTo(15.851, 2);
    expect(second.durationSec).toBeCloseTo(100.618, 2);
  });

  it("phase totals plus flight equal the run duration", () => {
    for (const run of parseFixture("host-two-runs.log")) {
      const sum = run.phases.reduce((total, phase) => total + phase.totalSec, run.flightSec);
      expect(Math.abs(sum - run.durationSec)).toBeLessThan(TOL);
    }
  });

  it("ends the run as aborted when the mission state closes early", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      shieldLine(21, "DT_FIRE"),
      `${ts(25)} Net [Info]: GameRulesImpl - changing state from SS_STARTED to SS_ENDING`,
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].aborted).toBe(true);
    expect(runs[0].complete).toBe(false);
    expect(runs[0].runEndSec).toBeCloseTo(25, 3);
  });

  it("treats a shield switch after the phase-3 pylons as the missing phase 4", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      phaseLine(30, "second"),
      phaseLine(40, "third"),
      shieldLine(41, "DT_FIRE"),
      shieldLine(43, "DT_FREEZE"),
      shieldEndLine(45, "DBntyFourInterPrTk0890TheBusiness"),
      legLine(50, "ARM_LEFT"),
      pylonLine(60),
      shieldLine(61, "DT_GAS"),
      shieldLine(65, "DT_VIRAL"),
      `${ts(70)} Sys [Info]: EOM missionLocationUnlocked=1`,
    ]);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.bugged).toBe(true);
    // Phase 3 closed on the guessed marker, so its pylon window is not counted.
    const phase3 = run.phases.find((phase) => phase.index === 3);
    expect(phase3?.totalSec).toBeCloseTo(25, 3);
    expect(phase3?.pylonSec).toBe(0);
    expect(run.pylonSec).toBe(0);
  });

  it("flags more than four leg breaks in one phase as bugged", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      legLine(21, "ARM_LEFT"),
      legLine(22, "ARM_RIGHT"),
      legLine(23, "LEG_LEFT"),
      legLine(24, "LEG_RIGHT"),
      legLine(25, "ARM_LEFT"),
      phaseLine(30, "second"),
      `${ts(40)} Sys [Info]: EOM missionLocationUnlocked=1`,
    ]);
    expect(runs[0].bugged).toBe(true);
    expect(runs[0].phases[0].legs).toHaveLength(5);
  });

  it("keeps an unmapped damage type as its lowercased token", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      shieldLine(21, "DT_MYSTERY"),
      shieldLine(24, "DT_FIRE"),
      phaseLine(30, "second"),
      `${ts(40)} Sys [Info]: EOM missionLocationUnlocked=1`,
    ]);
    expect(runs[0].phases[0].shields).toEqual([
      { element: "dt_mystery", seconds: expect.closeTo(4, 3) },
    ]);
  });

  it("marks a client-side run, whose log has no Camper telemetry", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      stateLine(25, 3),
      phaseLine(30, "second"),
      `${ts(40)} Sys [Info]: EOM missionLocationUnlocked=1`,
    ]);
    expect(runs[0].hostTelemetry).toBe(false);
    expect(runs[0].phases).toHaveLength(1);
  });

  it("counts the third vulnerability window in a phase as the kill", () => {
    const runs = parseAll([
      sessionLine(10),
      elevatorLine(11),
      phaseLine(20, "first"),
      vulnerableLine(30),
      vulnerableLine(30),
      vulnerableLine(30.5),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].complete).toBe(true);
    expect(runs[0].runEndSec).toBeCloseTo(30.5, 3);
    expect(runs[0].phases[0].bodySec).toBeCloseTo(0.5, 3);
  });

  it("ignores the other heist bounties and records a host migration", () => {
    const runs = parseAll([
      `${ts(5)} Script [Info]: ThemedSquadOverlay.lua: Active jobId set to /Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyOne_-6`,
      `${ts(6)} Script [Info]: EidolonMP.lua: Session map string: /Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyTwo`,
      sessionLine(10),
      elevatorLine(11),
      `${ts(15)}     "jobId" : "/Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyFour_-6",`,
      phaseLine(20, "first"),
      phaseLine(30, "second"),
      `${ts(40)} Sys [Info]: EOM missionLocationUnlocked=1`,
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].hostMigration).toBe(true);
  });
});
