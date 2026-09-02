import { get } from "svelte/store";

import {
  cycleTimeDisplay,
  nextDailyResetUtc,
  nextWeeklyResetUtc,
  parseIsoDate,
  timeTo,
  timeToStrict,
} from "../format.js";
import { tr } from "../i18n.js";
import type { MessageKey } from "../../i18n/en.js";
import { invoke, on } from "../ipc.js";
import { useInterval } from "../timers.js";
import { PLANET_ICON_PATHS, fissureTierClass } from "../world.js";
import {
  applyOverlaySettingsResponse,
  overlaySettings,
  overlaySettingsLoaded,
} from "../../stores/overlaySettings.js";
import { addToast } from "../../stores/toasts.js";
import { worldData, worldLastFetch, worldLoading } from "../../stores/world.js";
import type { FissureMode } from "../../stores/world.js";
import type { CycleData, Fissure, SyndicateBounty, WorldState } from "../../types/world.js";
import { readStorage, writeStorage } from "../persistence.js";

const WORLD_REFRESH_MS = 120_000;
const WORLD_POLL_MS = 30_000;
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

type CycleAlertKey = "earth" | "cetus" | "vallis" | "cambion" | "duviri";

// Labels stay as keys so the caller can resolve them reactively with $tr.
export const FISSURE_MODE_OPTIONS: ReadonlyArray<{ value: FissureMode; labelKey: MessageKey }> = [
  { value: "all", labelKey: "common.all" },
  { value: "normal", labelKey: "common.normal" },
  { value: "steel", labelKey: "common.steelPath" },
  { value: "railjack", labelKey: "world.railjack" },
];

async function fetchWorldData(force: boolean = false): Promise<void> {
  if (get(worldLoading)) return;

  const now = Date.now();
  if (!force && get(worldData) && now - get(worldLastFetch) < WORLD_REFRESH_MS) return;

  worldLoading.set(true);
  try {
    const data = await invoke("getWorldState");
    if (data) {
      worldData.set(data);
      worldLastFetch.set(Date.now());
    }
  } catch (error) {
    console.error("[World] getWorldState failed:", error);
  } finally {
    worldLoading.set(false);
  }
}

// Refcounted because the World tab and the dashboard's world widgets both need
// live data. Only one of the two views is mounted at a time today, but a mount
// that overlaps an unmount must not leave two intervals running.
let worldPollRefs = 0;
let stopWorldPoll: (() => void) | null = null;

/** Fetches now and keeps world data polling while any caller holds its stop fn. */
export function mountWorldPolling(): () => void {
  worldPollRefs += 1;
  if (worldPollRefs === 1) {
    void fetchWorldData();
    stopWorldPoll = useInterval(() => void fetchWorldData(), WORLD_POLL_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    worldPollRefs -= 1;
    if (worldPollRefs > 0) return;
    stopWorldPoll?.();
    stopWorldPoll = null;
  };
}

export function mountWorldView(): () => void {
  void fetchWorldData(true);

  const stopFetchErrorListener = on("world-state-fetch-error", (message) => {
    // A toast is a snapshot, so resolving the language once at fire time is fine.
    const t = get(tr);
    addToast({
      level: "warning",
      title: t("world.fetchErrorTitle"),
      message: t("world.fetchFailed", { error: String(message) }),
      durationMs: 8000,
    });
  });

  if (!get(overlaySettingsLoaded)) {
    void invoke("getOverlaySettings")
      .then((loaded) => {
        if (loaded) applyOverlaySettingsResponse(loaded);
      })
      .catch((error: unknown) => console.error("[World] getOverlaySettings failed:", error));
  }

  const stopPolling = mountWorldPolling();

  return () => {
    stopPolling();
    stopFetchErrorListener();
  };
}

export async function toggleCycleAlert(key: CycleAlertKey): Promise<void> {
  const current = get(overlaySettings).cycleAlerts?.[key] ?? false;
  const newAlerts = { ...get(overlaySettings).cycleAlerts, [key]: !current };
  try {
    const saved = await invoke("setOverlaySettings", { cycleAlerts: newAlerts });
    if (saved) applyOverlaySettingsResponse(saved);
  } catch (error: unknown) {
    console.error("[World] toggleCycleAlert failed:", error);
  }
}

export async function setCycleAlertMinutes(minutes: number): Promise<void> {
  const clamped = Math.max(0, Math.min(120, Math.round(minutes)));
  try {
    const saved = await invoke("setOverlaySettings", { cycleAlertMinutesBefore: clamped });
    if (saved) applyOverlaySettingsResponse(saved);
  } catch (error: unknown) {
    console.error("[World] setCycleAlertMinutes failed:", error);
  }
}

export function loadCollapsedSections(): Record<string, boolean> {
  const raw = readStorage(COLLAPSE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
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
  writeStorage(COLLAPSE_KEY, JSON.stringify(toSave));
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

function fissureSourceMode(f: Fissure): Exclude<FissureMode, "all"> {
  if (f.isStorm === true) return "railjack";
  return f.isHard === true ? "steel" : "normal";
}

export function buildFissureRows(
  fissures: Fissure[] | undefined,
  mode: FissureMode,
  nowMs: number,
  nowCoarseMs: number,
) {
  return (fissures || [])
    .filter((f) => {
      if (f.expired) return false;
      if ((parseIsoDate(f.expiry)?.getTime() || 0) <= nowCoarseMs + FISSURE_EXPIRY_GUARD_MS) {
        return false;
      }
      // Railjack mode = all Void Storm fissures (both normal and Steel Path railjack).
      // Normal/Steel modes show only standard fissures, split by isHard; "all"
      // merges both of those but still keeps Void Storms in their own tab.
      if (mode === "railjack") return f.isStorm === true;
      if (f.isStorm === true) return false;
      if (mode === "all") return true;
      return mode === "steel" ? f.isHard === true : f.isHard !== true;
    })
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
      sourceMode: fissureSourceMode(f),
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
  t,
}: {
  earth: CycleData;
  cetus: CycleData;
  vallis: CycleData;
  cambion: CycleData;
  duviri: WorldState["duviriCycle"];
  duviriState: string;
  times: ReturnType<typeof buildWorldTimes>;
  nowCoarseMs: number;
  t: (key: MessageKey) => string;
}) {
  const earthLabel = t(earth.isDay ? "world.cycle.day" : "world.cycle.night");
  const cetusLabel = t(cetus.isDay ? "world.cycle.day" : "world.cycle.night");
  const vallisLabel = t(vallis.isWarm ? "world.cycle.warm" : "world.cycle.cold");
  const cambionState = (cambion.active || "").toString().toLowerCase();
  // DE only ever reports fass or vome here; anything else is shown as sent.
  const cambionLabel =
    cambionState === "fass"
      ? t("world.cycle.fass")
      : cambionState === "vome"
        ? t("world.cycle.vome")
        : cambionState
          ? cambionState.charAt(0).toUpperCase() + cambionState.slice(1)
          : t("common.unknown");
  const rows = [
    {
      key: "earth" as const,
      src: PLANET_ICON_PATHS.earth,
      t: earth,
      time: times.earth,
      stateLabel: earthLabel,
      stateClass: earth.isDay ? "day" : "night",
      nextLabel: t(earth.isDay ? "world.cycle.night" : "world.cycle.day"),
      urgent: isUrgent(earth.expiry, earth.activation, undefined, nowCoarseMs),
    },
    {
      key: "cetus" as const,
      src: PLANET_ICON_PATHS.cetus,
      t: cetus,
      time: times.cetus,
      stateLabel: cetusLabel,
      stateClass: cetus.isDay ? "day" : "night",
      nextLabel: t(cetus.isDay ? "world.cycle.night" : "world.cycle.day"),
      urgent: isUrgent(cetus.expiry, cetus.activation, undefined, nowCoarseMs),
    },
    {
      key: "vallis" as const,
      src: PLANET_ICON_PATHS.vallis,
      t: vallis,
      time: times.vallis,
      stateLabel: vallisLabel,
      stateClass: vallis.isWarm ? "warm" : "cold",
      nextLabel: t(vallis.isWarm ? "world.cycle.cold" : "world.cycle.warm"),
      urgent: isUrgent(vallis.expiry, vallis.activation, undefined, nowCoarseMs),
    },
    {
      key: "cambion" as const,
      src: PLANET_ICON_PATHS.cambion,
      t: cambion,
      time: times.cambion,
      stateLabel: cambionLabel,
      stateClass: cambionState || "fass",
      nextLabel: t(cambionState === "fass" ? "world.cycle.vome" : "world.cycle.fass"),
      urgent: isUrgent(cambion.expiry, cambion.activation, undefined, nowCoarseMs),
    },
    ...(duviri?.expiry
      ? [
          {
            key: "duviri" as const,
            src: PLANET_ICON_PATHS.duviri,
            t: { expiry: duviri.expiry },
            time: times.duviri,
            stateLabel: duviriState,
            stateClass: duviriState.toLowerCase(),
            nextLabel: duviri.nextState ? String(duviri.nextState) : t("common.unknown"),
            urgent: isUrgent(duviri.expiry, null, undefined, nowCoarseMs),
          },
        ]
      : []),
  ];
  return rows.filter((row) => row.t.expiry);
}

export function buildBountyGroups(bounties: SyndicateBounty[] | undefined): SyndicateBounty[] {
  return (bounties || [])
    .filter((b) => b.jobs.length > 0)
    .sort(
      (a, b) =>
        (BOUNTY_ORDER[a.syndicateKey] ?? BOUNTY_ORDER[a.syndicate] ?? 99) -
        (BOUNTY_ORDER[b.syndicateKey] ?? BOUNTY_ORDER[b.syndicate] ?? 99),
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
