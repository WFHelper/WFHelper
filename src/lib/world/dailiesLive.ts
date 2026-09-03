import {
  codaBatchAt,
  nextVendorRotationMs,
  VENDOR_ROTATION_ANCHORS,
  VENDOR_ROTATION_MS,
} from "../../../config/shared/vendorRotation.js";
import { activeWindow, WEEK_MS } from "../format.js";
import type { MessageKey, Translator } from "../i18n.js";
import type { ArchonHunt, CalendarDay, Sortie, WorldState } from "../../types/world.js";
import { circuitChoices } from "../world.js";
import { fourDayResetIso, type TrackerExpiries } from "./dailies.js";

interface TrackerLive {
  /** One-line subtitle under the task label. */
  detail?: string | undefined;
  /** Sub-lines revealed by the row's expand toggle. */
  lines?: string[] | undefined;
  /** Calendar days revealed by the expand toggle; rendered, not flattened to text. */
  calendar?: CalendarDay[] | undefined;
  /** Drives the per-row countdown; null when the task has no live window. */
  expiry?: string | null | undefined;
}

/** Ergo Glast always sells all five; the 4-day tick only rerolls elements. */
export const TENET_MELEE_STOCK = [
  "Tenet Agendus",
  "Tenet Exec",
  "Tenet Ferrox",
  "Tenet Grigori",
  "Tenet Livia",
];

const CODA_BATCH_A = [
  "Coda Hema",
  "Coda Sporothrix",
  "Coda Catabolyst",
  "Coda Pox",
  "Dual Coda Torxica",
  "Coda Mire",
  "Coda Motovore",
];
const CODA_BATCH_B = [
  "Coda Bassocyst",
  "Coda Bubonico",
  "Coda Synapse",
  "Coda Tysis",
  "Coda Caustacyst",
  "Coda Hirudo",
  "Coda Pathocyst",
];

/** Eleanor's two batches on the shared 4-day grid, plus the flip the row counts
 *  down to. The weapon arrays are constants, so a tick that changes nothing
 *  hands back the same array identity. */
export function codaBatch(nowMs: number): {
  batch: "A" | "B";
  weapons: string[];
  /** Epoch ms of the next batch flip, which is also the row's countdown target. */
  rotatesAt: number;
} {
  const batch = codaBatchAt(nowMs);
  return {
    batch,
    weapons: batch === "A" ? CODA_BATCH_A : CODA_BATCH_B,
    rotatesAt: nextVendorRotationMs(nowMs, VENDOR_ROTATION_ANCHORS.coda, VENDOR_ROTATION_MS),
  };
}

/** Ergo Glast's stock never changes, so only the element and bonus reroll; the
 *  grid is the same 4-day one the wiki countdown uses. */
export function tenetRotatesAt(nowMs: number): number {
  return nextVendorRotationMs(nowMs, VENDOR_ROTATION_ANCHORS.tenet, VENDOR_ROTATION_MS);
}

/** Bird 3's weekly Archon Shard color; wiki formula anchored 2022-09-12T00:00Z. */
const BIRD3_ANCHOR_MS = Date.UTC(2022, 8, 12);
const BIRD3_SHARDS = ["Azure", "Amber", "Crimson"];
/** Shard names are item names, so the plain colour is spelled out beside them. */
const SHARD_PLAIN_KEYS: Record<string, MessageKey> = {
  Azure: "dailies.shardBlue",
  Amber: "dailies.shardYellow",
  Crimson: "dailies.shardRed",
};

export function bird3ShardColor(nowMs: number): string {
  const offset = (((nowMs - BIRD3_ANCHOR_MS) % (3 * WEEK_MS)) + 3 * WEEK_MS) % (3 * WEEK_MS);
  return BIRD3_SHARDS[Math.floor(offset / WEEK_MS)];
}

/** A season spans a whole quarter, so the row shows only the near future and
 *  leaves the rest to the wiki link. */
const CALENDAR_DAY_CAP = 15;

function dayOfYearUtc(nowMs: number): number {
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - start) / 86_400_000) + 1;
}

/** DE numbers calendar days by day-of-year; a season numbered from its own start
 *  would match nothing, so an empty upcoming list falls back to the whole list. */
function upcomingCalendarDays(days: CalendarDay[], nowMs: number): CalendarDay[] {
  const today = dayOfYearUtc(nowMs);
  const upcoming = days.filter((entry) => entry.day >= today);
  return (upcoming.length > 0 ? upcoming : days).slice(0, CALENDAR_DAY_CAP);
}

export function trackerExpiries(wd: WorldState | null): TrackerExpiries {
  return {
    sortie: wd?.sortie?.expiry ?? null,
    archon: wd?.archonHunt?.expiry ?? null,
    steelPath: wd?.steelPath?.expiry ?? null,
    descendia: wd?.descents?.expiry ?? null,
    calendar1999: wd?.calendarSeason?.expiry ?? null,
    // Baro's activation is stable from "away" through "here", so it names one visit.
    baro: wd?.voidTrader?.activation ?? null,
    darvo: wd?.dailyDeals?.[0]?.expiry ?? null,
    varzia: wd?.vaultTrader?.activation ?? null,
  };
}

/** Live detail for a built-in task, or an empty object when the game has none. */
export function trackerLive(
  id: string,
  wd: WorldState | null,
  t: Translator,
  nowMs: number,
): TrackerLive {
  // The 4-day vendor grids come from the clock, so they tick without world data.
  if (id === "tenetMelee") {
    return { expiry: fourDayResetIso("tenet", new Date(nowMs)) };
  }
  if (id === "codaWeapons") {
    return {
      detail: t("dailies.codaBatch", { batch: codaBatch(nowMs).batch }),
      expiry: fourDayResetIso("coda", new Date(nowMs)),
    };
  }
  // Shard color is a 3-week clock cycle; the shard names are item names, so
  // they stay English like everything matched against the game.
  if (id === "bird3") {
    const color = bird3ShardColor(nowMs);
    const plainKey = SHARD_PLAIN_KEYS[color];
    return {
      detail: t("dailies.bird3Shard", { color, plain: plainKey ? t(plainKey) : color }),
    };
  }

  if (!wd) return {};

  switch (id) {
    case "sortie": {
      const sortie: Sortie | null | undefined = wd.sortie;
      const missions = (sortie?.missions ?? []).map(
        (mission) => `${mission.mission} - ${mission.node} - ${mission.modifier}`,
      );
      return {
        detail: sortie?.boss ? t("dailies.boss", { name: sortie.boss }) : undefined,
        lines: missions,
        expiry: sortie?.expiry ?? null,
      };
    }

    case "archonHunt": {
      const hunt: ArchonHunt | null | undefined = wd.archonHunt;
      if (!hunt) return {};
      return {
        detail: hunt.boss ? t("dailies.boss", { name: hunt.boss }) : undefined,
        lines: hunt.missions.map((mission) => `${mission.mission} - ${mission.node}`),
        expiry: hunt.expiry ?? null,
      };
    }

    case "circuitNormal": {
      const choices = circuitChoices(wd, "normal");
      return choices.length > 0 ? { detail: choices.join(" - ") } : {};
    }

    case "circuitSteelPath": {
      const choices = circuitChoices(wd, "hard");
      return choices.length > 0 ? { detail: choices.join(" - ") } : {};
    }

    case "steelPathHonors": {
      const reward = wd.steelPath?.currentReward;
      if (!reward) return {};
      return {
        detail: `${reward.name} - ${t("world.steelEssenceCost", { cost: String(reward.cost) })}`,
        expiry: wd.steelPath?.expiry ?? null,
      };
    }

    case "baro": {
      const baro = wd.voidTrader;
      if (!baro) return {};
      const here = activeWindow(baro.activation, baro.expiry, nowMs);
      const location = baro.location ?? "";
      const where = location
        ? t(here ? "dailies.baroHere" : "dailies.baroAway", { location })
        : undefined;
      const offers = baro.inventory?.length ?? 0;
      const count = here && offers > 0 ? t("dailies.itemCount", { count: String(offers) }) : "";
      return {
        detail: [where, count].filter(Boolean).join(" - ") || undefined,
        expiry: (here ? baro.expiry : baro.activation) ?? null,
      };
    }

    case "varzia": {
      const varzia = wd.vaultTrader;
      if (!varzia) return {};
      const here = activeWindow(varzia.activation, varzia.expiry, nowMs);
      const offers = varzia.inventory?.length ?? 0;
      return {
        detail: here && offers > 0 ? t("dailies.itemCount", { count: String(offers) }) : undefined,
        expiry: (here ? varzia.expiry : varzia.activation) ?? null,
      };
    }

    case "descendiaNormal":
    case "descendiaSteelPath": {
      return { expiry: wd.descents?.expiry ?? null };
    }

    case "calendar1999": {
      const season = wd.calendarSeason;
      if (!season) return {};
      // The season tag is a game term (Winter/Spring/...), shown as the game spells it.
      return {
        detail: season.season || undefined,
        calendar: season.days?.length ? upcomingCalendarDays(season.days, nowMs) : undefined,
        expiry: season.expiry ?? null,
      };
    }

    case "darvo": {
      const deal = wd.dailyDeals?.[0];
      if (!deal?.item) return {};
      const price =
        typeof deal.salePrice === "number"
          ? `${deal.salePrice}p${typeof deal.discount === "number" ? ` (-${deal.discount}%)` : ""}`
          : "";
      const stock =
        typeof deal.sold === "number" && typeof deal.total === "number"
          ? t("world.soldOfTotal", { sold: String(deal.sold), total: String(deal.total) })
          : "";
      return {
        detail: [deal.item, price, stock].filter(Boolean).join(" - "),
        expiry: deal.expiry ?? null,
      };
    }

    default:
      return {};
  }
}
