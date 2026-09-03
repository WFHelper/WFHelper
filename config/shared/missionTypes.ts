/** Mission-type naming shared by the world-state parser, the fissure-alert
 *  dropdown and the alert matcher, so a saved rule always names an emitted label. */

/** Fallback MT_ labels for the enums DE's ExportMissionTypes leaves unnamed, and
 *  for a failed export load. Values mirror DE's own dictionary so both paths
 *  agree. A divergence here is what made Interception read "Infested Salvage". */
export const MISSION_TYPE_LABELS: Readonly<Record<string, string>> = {
  MT_ALCHEMY: "Alchemy",
  MT_ARENA: "Arena",
  MT_ARMAGEDDON: "Void Armageddon",
  MT_ARTIFACT: "Disruption",
  MT_ASSASSINATION: "Assassination",
  MT_ASSAULT: "Assault",
  MT_CAPTURE: "Capture",
  MT_CORRUPTION: "Void Flood",
  // DE ships no name for this one; "Deception" is the in-game wording.
  MT_COUNTER_INTEL: "Deception",
  MT_DEFENSE: "Defense",
  MT_ENDLESS_CAPTURE: "Legacyte Harvest",
  MT_ENDLESS_EXTERMINATION: "Sanctuary Onslaught",
  MT_EVACUATION: "Defection",
  MT_EXCAVATE: "Excavation",
  MT_EXTERMINATION: "Exterminate",
  MT_HIVE: "Hive",
  MT_INTEL: "Spy",
  MT_JUNCTION: "Solar Rail Junction",
  MT_LANDSCAPE: "Free Roam",
  MT_MOBILE_DEFENSE: "Mobile Defense",
  MT_PURIFY: "Infested Salvage",
  MT_PURSUIT: "Pursuit",
  MT_PVP: "Conclave",
  MT_RACE: "Rush",
  // Void storms carry no MissionType; this only covers a node-less MT_RAILJACK.
  MT_RAILJACK: "Railjack",
  MT_RESCUE: "Rescue",
  MT_RETRIEVAL: "Hijack",
  MT_SABOTAGE: "Sabotage",
  MT_SURVIVAL: "Survival",
  MT_TERRITORY: "Interception",
  MT_VAULTS: "Netracell",
  MT_VOID_CASCADE: "Void Cascade",
};

/** Mission types a void fissure or void storm can run, in the exact labels the
 *  parser emits. Skirmish, Volatile and Orphix come from railjack nodes only;
 *  Defense, Exterminate, Spy and Survival match a normal fissure and a void
 *  storm alike, because a rule carries no railjack flag. */
export const FISSURE_MISSION_TYPES: readonly string[] = [
  "Alchemy",
  // Assassination and Defection stay listed because the old dropdown offered
  // them: saved rules render read-only and match by label, but dropping either
  // would stop the user picking it again.
  "Assassination",
  "Assault",
  "Capture",
  "Defection",
  "Defense",
  "Disruption",
  "Excavation",
  "Exterminate",
  "Hijack",
  "Hive",
  "Infested Salvage",
  "Interception",
  "Mobile Defense",
  "Orphix",
  "Rescue",
  "Sabotage",
  "Skirmish",
  "Spy",
  "Survival",
  "Void Armageddon",
  "Void Cascade",
  "Void Flood",
  "Volatile",
];

/** Rules saved before the parser switched to DE's wording keep working. */
const MISSION_LABEL_ALIASES: Readonly<Record<string, string>> = {
  extermination: "exterminate",
  "open world": "free roam",
};

function missionLabelKey(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ");
  return MISSION_LABEL_ALIASES[normalized] ?? normalized;
}

/** True when an alert rule's stored mission type covers an emitted fissure label. */
export function missionTypeMatches(ruleValue: string, emittedLabel: string): boolean {
  if (typeof ruleValue !== "string" || ruleValue === "" || ruleValue === "any") return true;
  if (typeof emittedLabel !== "string") return false;
  return missionLabelKey(ruleValue) === missionLabelKey(emittedLabel);
}
