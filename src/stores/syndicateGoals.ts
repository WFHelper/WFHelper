import { writable } from "svelte/store";

import { readStorage, writeStorage } from "../lib/persistence.js";
import { toFiniteNumber } from "../../config/shared/numeric.js";

const STORAGE_KEY = "wf_syndicate_goals_v1";

/** Target rank per syndicate tag. A tag drops out of the map when cleared. */
type SyndicateGoals = Record<string, number>;

function load(): SyndicateGoals {
  try {
    const parsed: unknown = JSON.parse(readStorage(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const goals: SyndicateGoals = {};
    for (const [tag, value] of Object.entries(parsed as Record<string, unknown>)) {
      const level = toFiniteNumber(value);
      if (level !== null) goals[tag] = Math.round(level);
    }
    return goals;
  } catch {
    return {};
  }
}

const store = writable<SyndicateGoals>(load());

export const syndicateGoals = {
  subscribe: store.subscribe,
  set(goals: SyndicateGoals): void {
    writeStorage(STORAGE_KEY, JSON.stringify(goals));
    store.set(goals);
  },
};

export function setSyndicateGoal(tag: string, targetLevel: number | null): void {
  store.update((current) => {
    const next = { ...current };
    if (targetLevel === null) delete next[tag];
    else next[tag] = targetLevel;
    writeStorage(STORAGE_KEY, JSON.stringify(next));
    return next;
  });
}

export function clearSyndicateGoals(): void {
  syndicateGoals.set({});
}
