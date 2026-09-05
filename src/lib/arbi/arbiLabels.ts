import type { MessageKey } from "../i18n.js";
import type { ArbiMissionType } from "../../../config/shared/arbiTypes.js";

// Generic fallback words only; a named mission kind (missionKindLabel) wins over these.
export const ARBI_MISSION_TYPE_KEYS: Record<ArbiMissionType, MessageKey> = {
  defense: "arbi.type.defense",
  interception: "arbi.type.interception",
  disruption: "arbi.type.disruption",
  other: "arbi.type.other",
};
