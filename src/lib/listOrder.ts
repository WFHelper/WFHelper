/** Moves one entry to a clamped index. Returns the input array itself when nothing
 *  moves (bad `from`, or `to` clamps onto `from`), so callers can skip a write. */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list as T[];
  const target = Math.min(Math.max(to, 0), list.length - 1);
  if (target === from) return list as T[];
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}
