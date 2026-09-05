import { BACKEND_URL } from "../../config/shared/backendConfig.js";
import { fetchWithTimeout } from "../../config/shared/fetchWithTimeout.js";
import { readStorage, writeStorage } from "./persistence.js";

export type SupporterTier = "basic" | "big" | "biggest";

export interface Supporter {
  name: string;
  tier: SupporterTier;
}

/** Display order: the bigger the pledge, the earlier the group. */
export const SUPPORTER_TIER_ORDER: readonly SupporterTier[] = ["biggest", "big", "basic"];

const CACHE_KEY = "wf_supporters_cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
// Mirrors the worker-side cap; keeps a malformed payload from being iterated wholesale.
const MAX_SUPPORTERS = 5000;

const TIER_SET = new Set<string>(SUPPORTER_TIER_ORDER);

function parseSupporters(payload: unknown): Supporter[] | null {
  if (!payload || typeof payload !== "object") return null;
  const list = (payload as { supporters?: unknown }).supporters;
  if (!Array.isArray(list)) return null;
  const supporters: Supporter[] = [];
  for (const entry of list.slice(0, MAX_SUPPORTERS)) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    const tier = (entry as { tier?: unknown }).tier;
    if (typeof name !== "string" || !name.trim()) continue;
    if (typeof tier !== "string" || !TIER_SET.has(tier)) continue;
    supporters.push({ name: name.trim(), tier: tier as SupporterTier });
  }
  return supporters;
}

function readCache(): { cachedAt: number; supporters: Supporter[] } | null {
  const raw = readStorage(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { cachedAt?: unknown; supporters?: unknown };
    const cachedAt = typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0;
    const supporters = parseSupporters(parsed);
    if (!supporters) return null;
    return { cachedAt, supporters };
  } catch {
    return null;
  }
}

/** Patreon supporter list from the backend; stale cache beats an outage,
 *  and any failure resolves to an empty list so the section just hides. */
export async function loadSupporters(): Promise<Supporter[]> {
  const cached = readCache();
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.supporters;

  try {
    const response = await fetchWithTimeout(`${BACKEND_URL}/v1/supporters`, FETCH_TIMEOUT_MS);
    if (response.ok) {
      const supporters = parseSupporters(await response.json());
      if (supporters) {
        // An empty list is never cached, mirroring the worker: the first
        // Patreon sync should show up on the next launch, not a day later.
        if (supporters.length > 0) {
          writeStorage(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), supporters }));
        }
        return supporters;
      }
    }
  } catch {
    // Offline or backend down; fall through to whatever the cache holds.
  }
  return cached?.supporters ?? [];
}
