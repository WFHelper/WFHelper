import {
  cycleTimeDisplay,
  nextDailyResetUtc,
  nextWeeklyResetUtc,
  parseIsoDate,
  timeTo,
  timeToStrict,
} from "../format.js";
import { PLANET_ICON_PATHS, fissureTierClass } from "../world.js";
import type { BountyJob, CycleData, Fissure, SyndicateBounty, WorldState } from "../../types/world.js";

export const WORLD_REFRESH_MS = 120_000;
export const WORLD_POLL_MS = 30_000;
export const COARSE_CLOCK_MS = 5_000;
const URGENCY_RATIO = 0.2;

const FISSURE_EXPIRY_GUARD_MS = 1_500;
const FISSURE_TIER_ORDER: Record<string, number> = {
  lith: 0,
  meso: 1,
  neo: 2,
  axi: 3,
  requiem: 4,
  omnia: 5,
};
const COLLAPSE_KEY = "world-collapsed-sections";
const MS_24H = 86_400_000;
const MS_7D = 604_800_000;
const BOUNTY_ORDER: Record<string, number> = {
  CetusSyndicate: 0,
  Ostrons: 0,
  SolarisSyndicate: 1,
  "Solaris United": 1,
  EntratiSyndicate: 2,
  Entrati: 2,
  ZarimanSyndicate: 3,
  "The Holdfasts": 3,
  EntratiLabSyndicate: 4,
  Cavia: 4,
  HexSyndicate: 5,
  "The Hex": 5,
};

export type FissureMode = "normal" | "steel";

export const FISSURE_MODE_OPTIONS: Array<{ value: FissureMode; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "steel", label: "Steel Path" },
];

export function loadCollapsedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function toggleCollapsedSection(
  collapsed: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  const next = { ...collapsed, [key]: !collapsed[key] };
  const toSave: Record<string, boolean> = {};
  for (const [sectionKey, value] of Object.entries(next)) {
    if (!/^bounty-.+-\d+$/.test(sectionKey)) toSave[sectionKey] = value;
  }
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(toSave));
  } catch {
    /* best effort */
  }
  return next;
}

function isUrgent(
  expiryIso: string | null | undefined,
  activationIso: string | null | undefined,
  fallbackTotalMs?: number,
  clock: number = Date.now(),
): boolean {
  const exp = parseIsoDate(expiryIso ?? null);
  if (!exp) return false;
  const remainMs = exp.getTime() - clock;
  if (remainMs <= 0) return false;
  const act = parseIsoDate(activationIso ?? null);
  const totalMs = act ? exp.getTime() - act.getTime() : (fallbackTotalMs ?? 0);
  if (totalMs <= 0) return false;
  return remainMs / totalMs < URGENCY_RATIO;
}

export function activeWindow(
  activationIso: string | null | undefined,
  expiryIso: string | null | undefined,
  clock: number,
): boolean {
  const activation = parseIsoDate(activationIso ?? null);
  const expiry = parseIsoDate(expiryIso ?? null);
  return !!(activation && expiry && clock >= +activation && clock < +expiry);
}

export function buildWorldTimes({
  baro,
  baroActive,
  varzia,
  varziaActive,
  sortie,
  steelPath,
  duviri,
  earth,
  cetus,
  vallis,
  cambion,
  nowMs,
}: {
  baro: WorldState["voidTrader"];
  baroActive: boolean;
  varzia: WorldState["vaultTrader"];
  varziaActive: boolean;
  sortie: WorldState["sortie"];
  steelPath: WorldState["steelPath"];
  duviri: WorldState["duviriCycle"];
  earth: CycleData;
  cetus: CycleData;
  vallis: CycleData;
  cambion: CycleData;
  nowMs: number;
}) {
  const baroAct = parseIsoDate(baro?.activation);
  const baroExpiry = parseIsoDate(baro?.expiry);
  const varziaAct = parseIsoDate(varzia?.activation);
  const varziaExpiry = parseIsoDate(varzia?.expiry);
  const duviriExpiry = parseIsoDate(duviri?.expiry);

  return {
    baro: baroActive ? timeTo(baroExpiry, nowMs) : timeTo(baroAct, nowMs),
    varzia: varziaActive ? timeTo(varziaExpiry, nowMs) : timeTo(varziaAct, nowMs),
    daily: timeTo(nextDailyResetUtc(), nowMs),
    weekly: timeTo(nextWeeklyResetUtc(), nowMs),
    sortie: timeTo(parseIsoDate(sortie?.expiry) || nextDailyResetUtc(), nowMs),
    steelPath: timeTo(parseIsoDate(steelPath?.expiry ?? undefined) || nextWeeklyResetUtc(), nowMs),
    duviri: timeTo(duviriExpiry, nowMs),
    earth: cycleTimeDisplay(earth.timeLeft, earth.expiry, nowMs),
    cetus: cycleTimeDisplay(cetus.timeLeft, cetus.expiry, nowMs),
    vallis: cycleTimeDisplay(vallis.timeLeft, vallis.expiry, nowMs),
    cambion: cycleTimeDisplay(cambion.timeLeft, cambion.expiry, nowMs),
  };
}

export function buildFissureRows(
  fissures: Fissure[] | undefined,
  mode: FissureMode,
  nowMs: number,
  nowCoarseMs: number,
) {
  return (fissures || [])
    .filter(
      (f) =>
        !f.expired &&
        (parseIsoDate(f.expiry)?.getTime() || 0) > nowCoarseMs + FISSURE_EXPIRY_GUARD_MS &&
        (mode === "steel" ? f.isHard === true : f.isHard !== true),
    )
    .sort((a, b) => {
      const oa = FISSURE_TIER_ORDER[(a.tier || "").toLowerCase()] ?? 99;
      const ob = FISSURE_TIER_ORDER[(b.tier || "").toLowerCase()] ?? 99;
      if (oa !== ob) return oa - ob;
      return (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0);
    })
    .map((f) => ({
      ...f,
      timeStr: timeToStrict(parseIsoDate(f.expiry), nowMs),
      tierCls: fissureTierClass(f.tier || ""),
    }));
}

export function buildCycleRows({
  earth,
  cetus,
  vallis,
  cambion,
  duviri,
  duviriState,
  times,
  nowCoarseMs,
}: {
  earth: CycleData;
  cetus: CycleData;
  vallis: CycleData;
  cambion: CycleData;
  duviri: WorldState["duviriCycle"];
  duviriState: string;
  times: ReturnType<typeof buildWorldTimes>;
  nowCoarseMs: number;
}) {
  const earthLabel = earth.isDay ? "Day" : "Night";
  const cetusLabel = cetus.isDay ? "Day" : "Night";
  const vallisLabel = vallis.isWarm ? "Warm" : "Cold";
  const cambionLabel = (cambion.active || "").toString().toUpperCase() || "Unknown";
  const rows = [
    { key: "earth" as const, src: PLANET_ICON_PATHS.earth, t: earth, time: times.earth, stateLabel: earthLabel, stateClass: earth.isDay ? "day" : "night", nextLabel: earth.isDay ? "Night" : "Day", urgent: isUrgent(earth.expiry, earth.activation, undefined, nowCoarseMs) },
    { key: "cetus" as const, src: PLANET_ICON_PATHS.cetus, t: cetus, time: times.cetus, stateLabel: cetusLabel, stateClass: cetus.isDay ? "day" : "night", nextLabel: cetus.isDay ? "Night" : "Day", urgent: isUrgent(cetus.expiry, cetus.activation, undefined, nowCoarseMs) },
    { key: "vallis" as const, src: PLANET_ICON_PATHS.vallis, t: vallis, time: times.vallis, stateLabel: vallisLabel, stateClass: vallis.isWarm ? "warm" : "cold", nextLabel: vallis.isWarm ? "Cold" : "Warm", urgent: isUrgent(vallis.expiry, vallis.activation, undefined, nowCoarseMs) },
    { key: "cambion" as const, src: PLANET_ICON_PATHS.cambion, t: cambion, time: times.cambion, stateLabel: cambionLabel, stateClass: (cambion.active || "").toString().toLowerCase() || "fass", nextLabel: (cambion.active || "").toString().toLowerCase() === "fass" ? "VOME" : "FASS", urgent: isUrgent(cambion.expiry, cambion.activation, undefined, nowCoarseMs) },
    ...(duviri?.expiry ? [{ key: "duviri" as const, src: PLANET_ICON_PATHS.duviri, t: { expiry: duviri.expiry }, time: times.duviri, stateLabel: duviriState, stateClass: duviriState.toLowerCase(), nextLabel: (duviri.nextState || "Unknown").toString(), urgent: isUrgent(duviri.expiry, null, undefined, nowCoarseMs) }] : []),
  ];
  return rows.filter((row) => row.t.expiry);
}

export function buildBountyGroups(bounties: SyndicateBounty[] | undefined): SyndicateBounty[] {
  return (bounties || [])
    .filter((b) => b.jobs.length > 0)
    .sort(
      (a, b) =>
        (BOUNTY_ORDER[a.syndicateKey] ?? (BOUNTY_ORDER[a.syndicate] ?? 99)) -
        (BOUNTY_ORDER[b.syndicateKey] ?? (BOUNTY_ORDER[b.syndicate] ?? 99)),
    );
}

export function buildResetUrgency(
  sortie: WorldState["sortie"],
  steelPath: WorldState["steelPath"],
  nowCoarseMs: number,
) {
  const dailyRemaining = nextDailyResetUtc().getTime() - nowCoarseMs;
  const weeklyRemaining = nextWeeklyResetUtc().getTime() - nowCoarseMs;
  return {
    sortie: isUrgent(sortie?.expiry, null, MS_24H, nowCoarseMs),
    daily: dailyRemaining > 0 && dailyRemaining / MS_24H < URGENCY_RATIO,
    weekly: weeklyRemaining > 0 && weeklyRemaining / MS_7D < URGENCY_RATIO,
    steelPath: isUrgent(steelPath?.expiry ?? undefined, null, MS_7D, nowCoarseMs),
  };
}

export function buildBountyTimers(
  bounties: SyndicateBounty[],
  nowMs: number,
  nowCoarseMs: number,
): Record<string, { timeStr: string; urgent: boolean }> {
  return Object.fromEntries(
    bounties.map((b) => {
      const exp = b.expiry ? parseIsoDate(b.expiry) : null;
      const timeStr = exp ? timeTo(exp, nowMs) : "";
      const urgent = isUrgent(b.expiry, null, 9_000_000, nowCoarseMs);
      return [b.syndicateKey, { timeStr, urgent }];
    }),
  );
}

export type { BountyJob };
