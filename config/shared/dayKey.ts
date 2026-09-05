/** Local "YYYY-MM-DD" of a Date, or "" when it is unusable. Range bounds are
 *  the days the user picked in their own timezone, so the ISO prefix would
 *  shift the window by a day west of Greenwich. Main and renderer share the
 *  machine clock, so both sides land on the same key. */
export function localDayKey(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The same key for a stored date string. */
export function toLocalDayKey(date: string): string {
  return localDayKey(new Date(date));
}
