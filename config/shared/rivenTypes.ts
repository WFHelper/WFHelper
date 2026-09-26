export interface DecodedRivenStat {
  tag: string;
  name: string;
  displayValue: number;
  /** Same roll recomputed at rank 8, for listing an unranked riven as maxed. */
  maxRankValue: number;
  /** Each rank recomputed from the fingerprint to avoid scaling rounded values. */
  rankValues?: number[];
  rollFloat: number;
  grade: string;
  positive: boolean;
  /** True for faction-damage / multiplier-style stats (displayed as xN.NN) */
  multiplier: boolean;
}

export interface DecodedRiven {
  itemId: string;
  weaponName: string;
  weaponUniqueName: string;
  rivenName: string;
  masteryReq: number;
  currentRank: number;
  maxRank: number;
  rerolls: number;
  polarity: string;
  disposition: number;
  stats: DecodedRivenStat[];
  overallGrade: string;
  attributeGrade: string;
  /** Average rollFloat across all stats - higher = closer to perfect */
  statPerfectness: number;
  /** Riven mod type (Rifle / Shotgun / Pistol / Melee / etc.) */
  rivenType: string;
}

export interface VeiledRivenEntry {
  itemType: string;
  label: string;
  challengeType?: string;
  challengeDesc?: string;
  /** challengeDesc without its count or complication; English like challengeDesc. */
  challengeGroup?: string;
  challengeProgress?: number;
  challengeRequired?: number;
}

export interface VeiledRivenGroup {
  itemType: string;
  label: string;
  count: number;
}

export interface CreateRivenAuctionPayload {
  weaponName: string;
  rivenName: string;
  stats: { tag: string; value: number; positive: boolean; multiplier?: boolean }[];
  rerolls: number;
  masteryReq: number;
  polarity: string;
  modRank: number;
  buyoutPrice: number | null;
  startingPrice: number;
  /** Auctions only; WFM hides the listing from users below this reputation. */
  minReputation: number;
  isPrivate: boolean;
  description: string;
}

export interface UpdateRivenAuctionPayload {
  auctionId: string;
  buyoutPrice: number | null;
  /** Null on a direct sell, which has no opening bid to resend. */
  startingPrice: number | null;
  minReputation: number;
  isPrivate?: boolean;
  description: string;
  /** Omitted keeps the private flag in charge of visibility. */
  visible?: boolean;
}
