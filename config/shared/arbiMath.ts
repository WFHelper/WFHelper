// Normal-approximation Vitus model ported from svesk.github.io/arbi, plus the
// run-window interval math.
// Shared by main run finalization and renderer projections.

import type { ArbiInterval } from "./arbiTypes";

/** Enemy count a room counts as saturated at. Lives here so the parser and the
 * renderer report the same number; the renderer re-exports it from arbiChartData. */
export const ARBI_SATURATION_THRESHOLD = 15;

/** Vitus drop chance per drone kill. */
const VITUS_DROP_CHANCE = 0.15;
/** Chance the Retriever mod doubles a drop (4 instead of 2 vitus). */
const VITUS_RETRIEVER_CHANCE = 0.18;
/** Chance a rotation reward is the bonus vitus bundle (scales with waves per rotation). */
const ROTATION_VITUS_CHANCE = 0.1;

interface VitusModel {
  mean: number;
  std: number;
}

export function computeVitusModel(
  rotations: number,
  wavesPerRotation: number,
  drones: number,
): VitusModel {
  const meanVal = 4 * VITUS_RETRIEVER_CHANCE + 2 * (1 - VITUS_RETRIEVER_CHANCE);
  const expectValSq = 16 * VITUS_RETRIEVER_CHANCE + 4 * (1 - VITUS_RETRIEVER_CHANCE);
  const varVal = expectValSq - meanVal * meanVal;

  const rotMean = rotations + rotations * ROTATION_VITUS_CHANCE * wavesPerRotation;
  const rotVar =
    rotations * ROTATION_VITUS_CHANCE * (1 - ROTATION_VITUS_CHANCE) * wavesPerRotation ** 2;

  const meanDrops = drones * VITUS_DROP_CHANCE;
  const varDrops = drones * VITUS_DROP_CHANCE * (1 - VITUS_DROP_CHANCE);

  const mean = rotMean + meanDrops * meanVal;
  const variance = rotVar + meanDrops * varVal + meanVal * meanVal * varDrops;
  return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

const SCENARIOS = [
  { z: -2.326, prob: "99%", key: "worstCase" },
  { z: -1.282, prob: "90%", key: "unlucky" },
  { z: -0.674, prob: "75%", key: "belowAvg" },
  { z: 0, prob: "50%", key: "average" },
  { z: 0.674, prob: "25%", key: "aboveAvg" },
  { z: 1.282, prob: "10%", key: "highRoll" },
  { z: 2.326, prob: "1%", key: "godRoll" },
] as const;

/** i18n suffix: arbi.vitus.scenario.<key>. Renderer-side label maps key on this. */
export type ArbiVitusScenarioKey = (typeof SCENARIOS)[number]["key"];

interface VitusScenario {
  /** Probability of reaching at least this total, e.g. "99%". */
  prob: string;
  total: number;
  key: ArbiVitusScenarioKey;
}

export function scenarioTable(model: VitusModel): VitusScenario[] {
  return SCENARIOS.map((s) => ({
    prob: s.prob,
    key: s.key,
    total: Math.max(0, Math.round(model.mean + s.z * model.std)),
  }));
}

/** Drop empty windows, sort, merge overlapping and touching ones. With `bounds`
 * every window is first clamped to it, which is how the parser and the cadence
 * views restrict pause/idle data to the run window. */
export function mergeIntervals(
  list: readonly ArbiInterval[],
  bounds?: ArbiInterval,
): ArbiInterval[] {
  const lower = bounds ? bounds.start : -Infinity;
  const upper = bounds ? bounds.end : Infinity;
  const clamped = list
    .map((iv) => ({ start: Math.max(iv.start, lower), end: Math.min(iv.end, upper) }))
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  const out: ArbiInterval[] = [];
  for (const iv of clamped) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** Abramowitz-Stegun normal CDF approximation (same as reference implementation). */
export function normCdf(x: number, mean: number, std: number): number {
  if (std <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}
