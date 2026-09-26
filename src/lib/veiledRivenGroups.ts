import type { VeiledRivenEntry } from "../types/ipc.js";
import { compareNames } from "./filters.js";

interface VeiledChallengeGroup {
  label: string;
  entries: VeiledRivenEntry[];
}

export function groupVeiledRivens(
  entries: readonly VeiledRivenEntry[],
  unassignedLabel: string,
): VeiledChallengeGroup[] {
  const byChallenge = new Map<string, VeiledRivenEntry[]>();
  const unassigned: VeiledRivenEntry[] = [];
  for (const entry of entries) {
    if (!entry.challengeGroup) {
      unassigned.push(entry);
      continue;
    }
    const members = byChallenge.get(entry.challengeGroup);
    if (members) members.push(entry);
    else byChallenge.set(entry.challengeGroup, [entry]);
  }

  const groups = Array.from(byChallenge, ([label, members]) => ({ label, entries: members })).sort(
    (a, b) => b.entries.length - a.entries.length || compareNames(a.label, b.label),
  );
  if (unassigned.length > 0) groups.push({ label: unassignedLabel, entries: unassigned });
  return groups;
}
