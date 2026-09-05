import { WORLD_STATE_CONFIG } from "../config/runtime/worldState";
import { fetchWithTimeout } from "../config/shared/fetchWithTimeout";

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = WORLD_STATE_CONFIG.cycleFetchTimeoutMs,
): Promise<unknown> {
  // The abort reason becomes the rejection, so a timed-out world-state fetch
  // logs "timeout" instead of the generic AbortError text.
  const resp = await fetchWithTimeout(
    url,
    timeoutMs,
    { headers: { Accept: "application/json" } },
    new Error("timeout"),
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}
