import { describe, expect, it } from "vitest";

import type { Translator } from "../../../src/lib/i18n.js";
import {
  bird3ShardColor,
  codaBatch,
  tenetRotatesAt,
  trackerExpiries,
  trackerLive,
} from "../../../src/lib/world/dailiesLive.js";
import type { CalendarDay, WorldState } from "../../../src/types/world.js";

const NOW = Date.parse("2026-08-24T12:00:00Z");

// Echoes the key and its params so assertions pin structure, not English copy.
const t: Translator = (key, params) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")})`
    : key;

function world(overrides: Partial<WorldState>): WorldState {
  return overrides as WorldState;
}

describe("trackerExpiries", () => {
  it("maps each expiry-driven period to its world-state window", () => {
    const wd = world({
      sortie: { expiry: "2026-08-24T16:00:00Z" },
      archonHunt: {
        activation: "2026-08-17T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        boss: "Nira",
        missions: [],
      },
      steelPath: {
        currentReward: { name: "Umbra Forma", cost: 150 },
        expiry: "2026-08-30T00:00:00Z",
        rotation: [],
        evergreens: [],
      },
      voidTrader: { activation: "2026-08-28T14:00:00Z", expiry: "2026-08-30T14:00:00Z" },
      vaultTrader: { activation: "2026-08-01T00:00:00Z", expiry: "2026-09-01T00:00:00Z" },
      dailyDeals: [{ expiry: "2026-08-24T20:00:00Z" }],
    });

    expect(trackerExpiries(wd)).toEqual({
      sortie: "2026-08-24T16:00:00Z",
      archon: "2026-08-31T00:00:00Z",
      steelPath: "2026-08-30T00:00:00Z",
      descendia: null,
      calendar1999: null,
      baro: "2026-08-28T14:00:00Z",
      darvo: "2026-08-24T20:00:00Z",
      varzia: "2026-08-01T00:00:00Z",
    });
  });

  it("returns nulls when the world state is missing", () => {
    expect(trackerExpiries(null)).toEqual({
      sortie: null,
      archon: null,
      steelPath: null,
      descendia: null,
      calendar1999: null,
      baro: null,
      darvo: null,
      varzia: null,
    });
  });

  it("reads the descent and calendar windows from the world state", () => {
    const wd = world({
      descents: { activation: "2026-08-24T00:00:00Z", expiry: "2026-08-31T00:00:00Z" },
      calendarSeason: {
        activation: "2026-08-24T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        season: "Summer",
      },
    });
    const expiries = trackerExpiries(wd);
    expect(expiries.descendia).toBe("2026-08-31T00:00:00Z");
    expect(expiries.calendar1999).toBe("2026-08-31T00:00:00Z");
    expect(trackerLive("calendar1999", wd, t, NOW)).toEqual({
      detail: "Summer",
      expiry: "2026-08-31T00:00:00Z",
    });
    expect(trackerLive("descendiaSteelPath", wd, t, NOW)).toEqual({
      expiry: "2026-08-31T00:00:00Z",
    });
  });

  it("computes the 4-day vendor countdowns without world data", () => {
    // 2026-08-24T12:00Z sits inside Tenet window Aug 23-27 and Coda window Aug 24-28.
    // Stock renders as an icon strip resolved in the component, so no text lines.
    const nowMs = Date.parse("2026-08-24T12:00:00Z");
    const tenet = trackerLive("tenetMelee", null, t, nowMs);
    expect(tenet.expiry).toBe("2026-08-27T00:00:00.000Z");
    expect(tenet.lines).toBeUndefined();
    const coda = trackerLive("codaWeapons", null, t, nowMs);
    expect(coda.expiry).toBe("2026-08-28T00:00:00.000Z");
    expect(coda.detail).toBe("dailies.codaBatch(batch=B)");
    expect(coda.lines).toBeUndefined();
  });

  it("spells the shard color out beside its name", () => {
    const live = trackerLive("bird3", null, t, Date.parse("2026-08-24T12:00:00Z"));
    expect(live.detail).toBe("dailies.bird3Shard(color=Crimson,plain=dailies.shardRed)");
  });

  const calendarWorld = (days: CalendarDay[]) =>
    world({
      calendarSeason: {
        activation: "2026-08-24T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        season: "Winter",
        days,
      },
    });
  const challengeDay = (day: number): CalendarDay => ({
    day,
    events: [{ kind: "challenge", label: `Act ${day}` }],
  });

  it("lists upcoming calendar days under the 1999 calendar row", () => {
    const wd = calendarWorld([
      challengeDay(5),
      {
        day: 236,
        events: [{ kind: "challenge", label: "Even the Odds", description: "Kill 30 Enemies" }],
      },
      {
        day: 240,
        events: [
          {
            kind: "reward",
            label: "Primary Arcane Adapter",
            uniqueName: "/Lotus/Types/Items/MiscItems/PrimaryArcaneUnlocker",
          },
          { kind: "upgrade", label: "Armor" },
        ],
      },
    ]);
    const live = trackerLive("calendar1999", wd, t, Date.parse("2026-08-24T12:00:00Z"));
    // 2026-08-24 is day 236; the day-5 entry is behind us and drops out.
    expect(live.lines).toBeUndefined();
    expect(live.calendar?.map((entry) => entry.day)).toEqual([236, 240]);
    expect(live.calendar?.[0]?.events[0]?.description).toBe("Kill 30 Enemies");
    expect(live.calendar?.[1]?.events.map((event) => event.kind)).toEqual(["reward", "upgrade"]);
  });

  it("caps the calendar at fifteen days and falls back to the whole season", () => {
    const nowMs = Date.parse("2026-08-24T12:00:00Z");
    const many = Array.from({ length: 20 }, (_, index) => challengeDay(236 + index));
    const capped = trackerLive("calendar1999", calendarWorld(many), t, nowMs);
    expect(capped.calendar).toHaveLength(15);
    expect(capped.calendar?.[14]?.day).toBe(250);
    // DE numbers days by day-of-year, but a season numbered from its own start
    // would match nothing, so the unfiltered list stands in.
    const ownNumbering = trackerLive(
      "calendar1999",
      calendarWorld([challengeDay(1), challengeDay(2)]),
      t,
      nowMs,
    );
    expect(ownNumbering.calendar?.map((entry) => entry.day)).toEqual([1, 2]);
  });

  it("alternates the coda batches across the 4-day boundary", () => {
    // Wiki formula: floor((now - 2025-03-18Z) mod 8d / 4d), index 0 is Batch A.
    // A player confirmed Batch B in game on 2026-09-03.
    expect(codaBatch(Date.parse("2026-09-03T06:35:00Z")).batch).toBe("B");
    expect(codaBatch(Date.parse("2026-09-01T00:00:00Z")).batch).toBe("B");
    expect(codaBatch(Date.parse("2026-08-31T23:59:00Z")).batch).toBe("A");
    expect(codaBatch(Date.parse("2026-08-28T00:00:00Z")).batch).toBe("A");
    expect(codaBatch(Date.parse("2026-08-24T12:00:00Z")).batch).toBe("B");
    expect(codaBatch(Date.parse("2026-08-23T12:00:00Z")).batch).toBe("A");
  });

  it("keeps the grid running before the coda anchor", () => {
    // The shared grid floors a negative offset instead of wrapping it by hand.
    const beforeAnchor = Date.parse("2025-03-17T12:00:00Z");
    expect(codaBatch(beforeAnchor).batch).toBe("B");
    expect(new Date(codaBatch(beforeAnchor).rotatesAt).toISOString()).toBe(
      "2025-03-18T00:00:00.000Z",
    );
  });

  it("reports the next rotation instant for both adversary vendors", () => {
    const coda = codaBatch(Date.parse("2026-09-03T06:35:00Z"));
    expect(new Date(coda.rotatesAt).toISOString()).toBe("2026-09-05T00:00:00.000Z");
    // Same grid the row countdown uses, so the two never disagree.
    expect(new Date(codaBatch(Date.parse("2026-08-24T12:00:00Z")).rotatesAt).toISOString()).toBe(
      trackerLive("codaWeapons", null, t, Date.parse("2026-08-24T12:00:00Z")).expiry,
    );
    // Tenet rides the wiki's own 2015-12-03Z anchor.
    expect(new Date(tenetRotatesAt(Date.parse("2026-09-03T06:35:00Z"))).toISOString()).toBe(
      "2026-09-04T00:00:00.000Z",
    );
    expect(new Date(tenetRotatesAt(Date.parse("2026-09-04T00:00:00Z"))).toISOString()).toBe(
      "2026-09-08T00:00:00.000Z",
    );
    expect(new Date(tenetRotatesAt(Date.parse("2026-08-24T12:00:00Z"))).toISOString()).toBe(
      trackerLive("tenetMelee", null, t, Date.parse("2026-08-24T12:00:00Z")).expiry,
    );
  });

  it("cycles the bird 3 shard color on the 3-week clock", () => {
    // Wiki formula anchored 2022-09-12Z; week of 2026-08-24 renders Crimson.
    expect(bird3ShardColor(Date.parse("2026-08-24T12:00:00Z"))).toBe("Crimson");
    expect(bird3ShardColor(Date.parse("2026-08-31T12:00:00Z"))).toBe("Azure");
    expect(bird3ShardColor(Date.parse("2026-09-07T12:00:00Z"))).toBe("Amber");
  });
});

describe("trackerLive", () => {
  it("returns nothing without world data", () => {
    expect(trackerLive("sortie", null, t, NOW)).toEqual({});
  });

  it("returns nothing for an id it does not decorate", () => {
    expect(trackerLive("netracells", world({}), t, NOW)).toEqual({});
  });

  it("lists the sortie boss and its three missions", () => {
    const wd = world({
      sortie: {
        expiry: "2026-08-24T16:00:00Z",
        boss: "Lephantis",
        missions: [
          { node: "Pacific (Earth)", mission: "Survival", modifier: "Augmented Enemy Armor" },
          { node: "Baal (Europa)", mission: "Mobile Defense", modifier: "Viral Enhancement" },
          { node: "Hepit (Void)", mission: "Assassination", modifier: "Pistol Only" },
        ],
      },
    });

    const live = trackerLive("sortie", wd, t, NOW);

    expect(live.detail).toBe("dailies.boss(name=Lephantis)");
    expect(live.lines).toEqual([
      "Survival - Pacific (Earth) - Augmented Enemy Armor",
      "Mobile Defense - Baal (Europa) - Viral Enhancement",
      "Assassination - Hepit (Void) - Pistol Only",
    ]);
    expect(live.expiry).toBe("2026-08-24T16:00:00Z");
  });

  it("falls back to an empty archon hunt when the game has none", () => {
    expect(trackerLive("archonHunt", world({ archonHunt: null }), t, NOW)).toEqual({});
  });

  it("lists archon hunt missions without a modifier column", () => {
    const wd = world({
      archonHunt: {
        activation: "2026-08-17T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        boss: "Nira",
        missions: [
          { node: "Arval (Mars)", mission: "Extermination" },
          { node: "War (Mars)", mission: "Assassination" },
        ],
      },
    });

    const live = trackerLive("archonHunt", wd, t, NOW);

    expect(live.detail).toBe("dailies.boss(name=Nira)");
    expect(live.lines).toEqual(["Extermination - Arval (Mars)", "Assassination - War (Mars)"]);
  });

  it("names this week's circuit rewards per difficulty", () => {
    const wd = world({
      duviriCycle: {
        choices: [
          { category: "normal", choices: ["Nidus", "Octavia", "Harrow"] },
          { category: "hard", choices: ["Vectis", "Stug"] },
        ],
      },
    });

    expect(trackerLive("circuitNormal", wd, t, NOW).detail).toBe("Nidus - Octavia - Harrow");
    expect(trackerLive("circuitSteelPath", wd, t, NOW).detail).toBe("Vectis - Stug");
    expect(trackerLive("circuitNormal", world({}), t, NOW)).toEqual({});
  });

  it("shows the current Steel Path honor and its essence cost", () => {
    const wd = world({
      steelPath: {
        currentReward: { name: "Umbra Forma", cost: 150 },
        expiry: "2026-08-30T00:00:00Z",
        rotation: [],
        evergreens: [],
      },
    });

    const live = trackerLive("steelPathHonors", wd, t, NOW);

    expect(live.detail).toBe("Umbra Forma - world.steelEssenceCost(cost=150)");
    expect(live.expiry).toBe("2026-08-30T00:00:00Z");
  });

  it("counts Baro's offers while he is here and counts down to his arrival otherwise", () => {
    const here = world({
      voidTrader: {
        activation: "2026-08-24T00:00:00Z",
        expiry: "2026-08-26T00:00:00Z",
        location: "Orcus Relay (Pluto)",
        inventory: [{ item: "Prisma Gorgon" }, { item: "Primed Fury" }],
      },
    });
    const away = world({
      voidTrader: {
        activation: "2026-09-04T14:00:00Z",
        expiry: "2026-09-06T14:00:00Z",
        location: "Larunda Relay (Mercury)",
        inventory: [],
      },
    });

    const arrived = trackerLive("baro", here, t, NOW);
    expect(arrived.detail).toBe(
      "dailies.baroHere(location=Orcus Relay (Pluto)) - dailies.itemCount(count=2)",
    );
    expect(arrived.expiry).toBe("2026-08-26T00:00:00Z");

    const pending = trackerLive("baro", away, t, NOW);
    expect(pending.detail).toBe("dailies.baroAway(location=Larunda Relay (Mercury))");
    expect(pending.expiry).toBe("2026-09-04T14:00:00Z");
  });

  it("summarises Darvo's deal with its discount and stock", () => {
    const wd = world({
      dailyDeals: [
        {
          item: "Vasto",
          salePrice: 114,
          originalPrice: 190,
          discount: 40,
          sold: 80,
          total: 100,
          expiry: "2026-08-24T20:00:00Z",
        },
      ],
    });

    const live = trackerLive("darvo", wd, t, NOW);

    expect(live.detail).toBe("Vasto - 114p (-40%) - world.soldOfTotal(sold=80,total=100)");
    expect(live.expiry).toBe("2026-08-24T20:00:00Z");
  });

  it("skips Darvo entirely when no deal is running", () => {
    expect(trackerLive("darvo", world({ dailyDeals: [] }), t, NOW)).toEqual({});
  });
});
