/** Summaries the dashboard widget receives; the Missions tab pages through the rest. */
export const MISSION_REWARDS_RECENT_LIMIT = 10;
export const MISSION_REWARDS_PAGE_SIZE = 50;
export const MISSION_REWARDS_MAX_PAGE_SIZE = 200;
export const MISSION_REWARDS_MAX_QUERY_NAMES = 5_000;

export interface MissionRewardItem {
  uniqueName: string;
  count: number;
}

export interface MissionRewardSummary {
  id: string;
  endedAt: number;
  readAt: number;
  /** Above 1 when failed reads carried earlier missions into this one. */
  missionCount: number;
  missionType?: string;
  node?: string;
  items: MissionRewardItem[];
  credits: number;
  endo: number;
}

type MissionRewardsBlockReason = "tracking-off";

export type MissionRewardsFailure =
  | "game-not-running"
  | "access-denied"
  | "no-fresh-copy"
  | "inventory-unreadable"
  | "error";

export interface MissionRewardsStatus {
  phase: "idle" | "waiting" | "reading";
  blocked?: MissionRewardsBlockReason;
  lastFailure?: MissionRewardsFailure;
  /** Mission ends the next successful read will cover. */
  pendingMissions: number;
}

export interface MissionRewardSummaryView extends MissionRewardSummary {
  nodeLabel?: string;
}

export interface MissionRewardsPayload {
  summaries: MissionRewardSummaryView[];
  status: MissionRewardsStatus;
}

export interface MissionRewardsQuery {
  offset: number;
  limit: number;
  /** Earliest endedAt included; the renderer resolves "today" in its own time zone. */
  since?: number;
  missionType?: string;
  /** A mission matches when it received any of these. */
  uniqueNames?: string[];
}

export interface MissionRewardsTotals {
  /** Missions the matched summaries cover, carried reads included. */
  missions: number;
  credits: number;
  endo: number;
  items: MissionRewardItem[];
}

export interface MissionRewardsPage {
  summaries: MissionRewardSummaryView[];
  /** Summaries matching the query; the page is a slice of them. */
  matched: number;
  totals: MissionRewardsTotals;
  latest: MissionRewardSummaryView | null;
  recorded: number;
  missionTypes: string[];
  /** Every item any recorded mission brought, for the renderer's name search. */
  itemTypes: string[];
  status: MissionRewardsStatus;
}
