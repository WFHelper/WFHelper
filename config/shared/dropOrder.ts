/** The key @wfcd/items sorts every drop list by. */
export function wfcdDropOrderKey(drop: {
  chance?: number;
  location: string;
  rarity?: string;
}): string {
  return `${drop.chance}:${drop.location}::${drop.rarity}`.toUpperCase();
}
