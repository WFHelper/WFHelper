export interface AyatanSculpture {
  slug: string;
  baseEndo: number;
  endoMultiplier: number;
  maxAmberStars: number;
  maxCyanStars: number;
}

// warframe.market /v2/items fields, measured 2026-09-26. The client catalog drops
// them, so a new sculpture needs a row here.
export const AYATAN_SCULPTURES: readonly AyatanSculpture[] = [
  sculpture("ayatan_anasa_sculpture", 2000, 0.5, 2, 2),
  sculpture("ayatan_kitha_sculpture", 450, 3, 1, 4),
  sculpture("ayatan_hemakara_sculpture", 450, 3, 1, 2),
  sculpture("ayatan_zambuka_sculpture", 450, 3, 1, 2),
  sculpture("ayatan_chattraka_sculpture", 450, 3, 1, 2),
  sculpture("ayatan_orta_sculpture", 650, 2, 1, 3),
  sculpture("ayatan_vaya_sculpture", 400, 2, 1, 2),
  sculpture("ayatan_piv_sculpture", 375, 2, 1, 2),
  sculpture("ayatan_valana_sculpture", 325, 2, 1, 2),
  sculpture("ayatan_sah_sculpture", 300, 2, 1, 2),
  sculpture("ayatan_ayr_sculpture", 325, 2, 0, 3),
];

function sculpture(
  slug: string,
  baseEndo: number,
  endoMultiplier: number,
  maxAmberStars: number,
  maxCyanStars: number,
): AyatanSculpture {
  return { slug, baseEndo, endoMultiplier, maxAmberStars, maxCyanStars };
}

const BY_SLUG = new Map(AYATAN_SCULPTURES.map((entry) => [entry.slug, entry]));

export function ayatanSculptureBySlug(slug: string | null | undefined): AyatanSculpture | null {
  return (slug && BY_SLUG.get(slug)) || null;
}

function clampStars(value: number | undefined, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(max, Math.max(0, n));
}

export interface AyatanStars {
  amber: number;
  cyan: number;
}

/** Stars an order says are socketed, clamped to the sculpture's sockets; an
 *  order without the fields is unsocketed, as warframe.market reads it. */
export function ayatanStarsOf(
  sculpture: AyatanSculpture,
  order: { amberStars?: number; cyanStars?: number },
): AyatanStars {
  return {
    amber: clampStars(order.amberStars, sculpture.maxAmberStars),
    cyan: clampStars(order.cyanStars, sculpture.maxCyanStars),
  };
}

// Maroo pays (base + 50*cyan + 100*amber) * (1 + multiplier * stars / sockets), rounded
// (wiki.warframe.com Ayatan_Treasures table). warframe.market divides by the stars instead
// of the sockets, which only differs for part-socketed sculptures.
export function ayatanSculptureEndo(sculpture: AyatanSculpture, stars: AyatanStars): number {
  const sockets = sculpture.maxAmberStars + sculpture.maxCyanStars;
  const filled = stars.amber + stars.cyan;
  const raw = sculpture.baseEndo + 50 * stars.cyan + 100 * stars.amber;
  const bonus = sockets > 0 ? (sculpture.endoMultiplier * filled) / sockets : 0;
  return Math.round(raw * (1 + bonus));
}

/** Endo per platinum of one listing; `platinum` buys `perTrade` sculptures.
 *  A free or broken price has no ratio, so it can never satisfy a minimum. */
export function ayatanEndoRatio(endo: number, platinum: number, perTrade = 1): number | null {
  if (!Number.isFinite(platinum) || platinum <= 0) return null;
  const count = Number.isInteger(perTrade) && perTrade > 0 ? perTrade : 1;
  return (endo * count) / platinum;
}

/** warframe.market's app.order.clipboard.stars, `({cyan} cyan, {amber} amber)`: a part
 *  appears only when the order's field is set, with its raw value, so
 *  "(, 1 amber)" is what the site prints too. Empty when the order names neither. */
export function ayatanWhisperStars(order: { amberStars?: number; cyanStars?: number }): string {
  if (order.cyanStars === undefined && order.amberStars === undefined) return "";
  const cyan = order.cyanStars === undefined ? "" : `${order.cyanStars} cyan`;
  const amber = order.amberStars === undefined ? "" : `, ${order.amberStars} amber`;
  return `(${cyan}${amber})`;
}
