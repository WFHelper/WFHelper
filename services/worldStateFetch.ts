import { WORLD_STATE_CONFIG } from "../config/runtime/worldState";

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: Parameters<typeof fetch>[1] = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = WORLD_STATE_CONFIG.cycleFetchTimeoutMs,
): Promise<unknown> {
  const resp = await fetchWithTimeout(url, timeoutMs, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}
