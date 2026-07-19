/**
 * Pure data/format helpers for the Arbitrations schedule sub-tab.
 * No Svelte, i18n, or IPC dependencies (unit-tested directly).
 * Filtering/search semantics ported from arbischedule.com.
 */
import type { ArbiScheduleEntry } from "../../types/ipc.js";

interface ArbiNodeItem {
  id: string;
  node: string;
  mission: string;
  faction: string;
}

interface ArbiSearchState {
  raw: string;
  normalized: string;
  matchedTokens: string[];
  unmatchedTokens: string[];
}

interface ArbiScheduleDayGroup {
  dayKey: string;
  dayLabel: string;
  entries: ArbiScheduleEntry[];
}

export interface ArbiSelectionPreset {
  name: string;
  nodeIds: string[];
  updatedAt: number;
}

/** Unique nodes across the whole schedule, sorted by display name. */
export function buildNodeCatalog(entries: ArbiScheduleEntry[]): ArbiNodeItem[] {
  const seen = new Map<string, ArbiNodeItem>();
  for (const entry of entries) {
    if (!seen.has(entry.nodeId)) {
      seen.set(entry.nodeId, {
        id: entry.nodeId,
        node: entry.node,
        mission: entry.mission,
        faction: entry.faction,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.node.localeCompare(b.node));
}

export function buildSearchState(raw: string, nodes: ArbiNodeItem[]): ArbiSearchState {
  const source = String(raw || "");
  const normalized = source.toLowerCase().trim();
  const tokens = [
    ...new Set(
      source
        .toLowerCase()
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];

  const matchedTokens: string[] = [];
  const unmatchedTokens: string[] = [];
  for (const token of tokens) {
    if (nodes.some((node) => node.node.toLowerCase().includes(token))) matchedTokens.push(token);
    else unmatchedTokens.push(token);
  }

  return { raw: source, normalized, matchedTokens, unmatchedTokens };
}

export function matchesSearch(
  searchState: ArbiSearchState,
  node: string,
  mission: string,
  faction: string,
): boolean {
  const query = searchState.normalized;
  if (!query) return true;

  const nodeName = node.toLowerCase();
  const fullQueryMatch =
    nodeName.includes(query) ||
    mission.toLowerCase().includes(query) ||
    faction.toLowerCase().includes(query);

  if (!searchState.matchedTokens.length) return fullQueryMatch;
  return searchState.matchedTokens.some((token) => nodeName.includes(token)) || fullQueryMatch;
}

/** Multi-token search: names the tokens that match no node at all. */
export function searchUnmatchedFeedback(searchState: ArbiSearchState): string | null {
  if (!searchState.normalized || !searchState.unmatchedTokens.length) return null;
  return searchState.unmatchedTokens.join(", ");
}

export function filterScheduleEntries(
  entries: ArbiScheduleEntry[],
  selected: ReadonlySet<string>,
  searchState: ArbiSearchState,
  daysToShow: number,
  nowMs: number,
): ArbiScheduleEntry[] {
  const cutoff = nowMs + Math.max(1, daysToShow) * 24 * 60 * 60 * 1000;
  return entries
    .filter((entry) => entry.epochMs <= cutoff)
    .filter((entry) => selected.size === 0 || selected.has(entry.nodeId))
    .filter((entry) => matchesSearch(searchState, entry.node, entry.mission, entry.faction))
    .sort((a, b) => a.epochMs - b.epochMs);
}

export function groupEntriesByDay(entries: ArbiScheduleEntry[]): ArbiScheduleDayGroup[] {
  const groups: ArbiScheduleDayGroup[] = [];
  let current: ArbiScheduleDayGroup | null = null;
  for (const entry of entries) {
    const date = new Date(entry.epochMs);
    const dayKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (!current || current.dayKey !== dayKey) {
      current = {
        dayKey,
        dayLabel: date.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "short",
        }),
        entries: [],
      };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export function formatEntryTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "NOW" while active (arbitrations last an hour), else d/h/m/s countdown. */
export function formatScheduleCountdown(epochMs: number, nowMs: number): string {
  const diff = epochMs - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return "NOW";

  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);

  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

export function formatUpdatedAgo(fetchedAt: number | null, nowMs: number): string | null {
  if (!fetchedAt) return null;
  const agoMs = Math.max(0, nowMs - fetchedAt);
  const min = Math.floor(agoMs / 60_000);
  if (min > 0) return `${min}m`;
  return `${Math.floor(agoMs / 1_000)}s`;
}

export function factionBadgeKey(
  faction: string,
): "grineer" | "corpus" | "infested" | "corrupted" | "other" {
  const low = faction.toLowerCase();
  if (low.includes("grineer")) return "grineer";
  if (low.includes("corpus")) return "corpus";
  if (low.includes("infest")) return "infested";
  if (low.includes("corrupt") || low.includes("orokin")) return "corrupted";
  return "other";
}

// --- localStorage-backed UI prefs (renderer only passes storage in) ---------

const SELECTED_KEY = "arbi-sched-selected";
const PRESETS_KEY = "arbi-sched-presets";
const DAYS_KEY = "arbi-sched-days";

export function loadSelectedNodeIds(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTED_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveSelectedNodeIds(selected: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SELECTED_KEY, JSON.stringify([...selected]));
  } catch {
    // prefs are best-effort
  }
}

export function loadSelectionPresets(): ArbiSelectionPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (p): p is ArbiSelectionPreset =>
          !!p &&
          typeof p === "object" &&
          typeof (p as ArbiSelectionPreset).name === "string" &&
          Array.isArray((p as ArbiSelectionPreset).nodeIds),
      )
      .map((p) => ({
        name: p.name,
        nodeIds: p.nodeIds.filter((id): id is string => typeof id === "string"),
        updatedAt: Number(p.updatedAt) || 0,
      }));
  } catch {
    return [];
  }
}

export function saveSelectionPresets(presets: ArbiSelectionPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // prefs are best-effort
  }
}

export function loadDaysToShow(): number {
  const value = Number(localStorage.getItem(DAYS_KEY));
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function saveDaysToShow(days: number): void {
  try {
    localStorage.setItem(DAYS_KEY, String(days));
  } catch {
    // prefs are best-effort
  }
}
