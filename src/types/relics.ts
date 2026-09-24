import type { RelicQuality } from "../../config/shared/relicPlannerView.js";

export type { RelicQuality };

export interface RelicReward {
  name: string;
  displayName?: string;
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

interface RelicGroupLookup {
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
