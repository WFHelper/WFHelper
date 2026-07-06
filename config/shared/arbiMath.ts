/**
 * Vitus Essence probability model for arbitration runs.
 * Ported from svesk.github.io/arbi (normal approximation of drop variance).
 * Shared by main (finalize) and renderer (luck percentile, scenario table).
 */

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

export function computeVitusModel(rotations: number, wavesPerRotation: number, drones: number): VitusModel {
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

interface VitusScenario {
  /** Probability of reaching at least this total, e.g. "99%". */
  prob: string;
  total: number;
  /** i18n suffix: arbi.vitus.scenario.<key> */
  key: string;
}

const SCENARIOS: ReadonlyArray<{ z: number; prob: string; key: string }> = [
  { z: -2.326, prob: "99%", key: "worstCase" },
  { z: -1.282, prob: "90%", key: "unlucky" },
  { z: -0.674, prob: "75%", key: "belowAvg" },
  { z: 0, prob: "50%", key: "average" },
  { z: 0.674, prob: "25%", key: "aboveAvg" },
  { z: 1.282, prob: "10%", key: "highRoll" },
  { z: 2.326, prob: "1%", key: "godRoll" },
];

export function scenarioTable(model: VitusModel): VitusScenario[] {
  return SCENARIOS.map((s) => ({
    prob: s.prob,
    key: s.key,
    total: Math.max(0, Math.round(model.mean + s.z * model.std)),
  }));
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
