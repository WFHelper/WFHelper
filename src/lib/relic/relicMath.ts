export function computeSquadEV(
  rewards: Array<{ chance: number }>,
  prices: Array<number | null>,
  N: number,
): number {
  const items = rewards.map((r, i) => ({ prob: r.chance / 100, price: prices[i] ?? 0 }));

  if (N <= 1) {
    return items.reduce((sum, item) => sum + item.prob * item.price, 0);
  }

  const sorted = [...items].sort((a, b) => a.price - b.price);
  const grouped: Array<{ price: number; prob: number }> = [];
  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.price === item.price) {
      last.prob += item.prob;
    } else {
      grouped.push({ price: item.price, prob: item.prob });
    }
  }

  let ev = 0;
  let cdfPrev = 0;
  for (const g of grouped) {
    const cdfCur = Math.min(1, cdfPrev + g.prob);
    ev += g.price * (Math.pow(cdfCur, N) - Math.pow(cdfPrev, N));
    cdfPrev = cdfCur;
  }
  return ev;
}

export function computeSquadDucatEV(
  rewards: Array<{ chance: number }>,
  ducats: Array<number | null>,
  squadSize: number,
): number {
  return computeSquadEV(rewards, ducats, squadSize);
}
