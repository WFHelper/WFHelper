export type RelicQuality = "intact" | "exceptional" | "flawless" | "radiant";

export interface RelicReward {
  name: string;
  uniqueName?: string | null;
  imageUrl?: string | null;
  rarity: string;
  chance: number;
  urlName: string | null;
  wfmId?: string | null;
  ducats: number | null;
}

export interface RelicQualityData {
  uniqueName: string | null;
  rewards: RelicReward[];
}

export interface RelicGroup {
  key: string;
  name: string;
  tier: string;
  code: string;
  vaulted?: boolean;
  imageUrl: string | null;
  qualities: Partial<Record<RelicQuality, RelicQualityData>>;
  [key: string]: unknown;
}

export interface RelicGroupLookup {
  groupKey: string;
  quality: RelicQuality;
}

export interface RelicDatabase {
  groups: Record<string, RelicGroup>;
  byUniqueName: Record<string, RelicGroupLookup>;
}

export interface OwnedQualityCounts {
  intact: number;
  exceptional: number;
  flawless: number;
  radiant: number;
}

export type OwnedCounts = Record<string, OwnedQualityCounts>;

export type EvCache = Map<string, number>;
