/** Safe mode drops every user-authored layer (custom CSS, stored layouts) for one
 *  load so a broken customisation cannot lock the user out of Settings. Main passes
 *  `?safe=1` for `--safe-mode`; the crash panel sets a one-shot localStorage flag. */

const SAFE_QUERY_KEY = "safe";
export const SAFE_MODE_ONCE_KEY = "wf_safe_mode_once";

let resolved: boolean | null = null;

function readQueryFlag(): boolean {
  try {
    if (typeof location === "undefined" || typeof location.search !== "string") return false;
    return new URLSearchParams(location.search).get(SAFE_QUERY_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The one-shot flag is consumed on first read, so the next normal launch is not
 * silently stuck in safe mode.
 */
function consumeOnceFlag(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const armed = localStorage.getItem(SAFE_MODE_ONCE_KEY) === "1";
    if (armed) localStorage.removeItem(SAFE_MODE_ONCE_KEY);
    return armed;
  } catch {
    return false;
  }
}

/** Memoised: the one-shot flag is cleared on the first call, so later calls must agree. */
export function isSafeMode(): boolean {
  if (resolved === null) resolved = consumeOnceFlag() || readQueryFlag();
  return resolved;
}

/** Arms safe mode for the next load and reloads. Used by the renderer crash panel. */
export function restartInSafeMode(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SAFE_MODE_ONCE_KEY, "1");
  } catch {
    // Without storage the reload is still worth attempting.
  }
  if (typeof location !== "undefined") location.reload();
}
