/**
 * Shared riven mod types used by both main-process (services/rivenFingerprint.ts)
 * and renderer (src/types/ipc.ts + preload.ts).
 *
 * Single source of truth - do not duplicate these types elsewhere.
 */

export interface DecodedRivenStat {
  tag: string;
  name: string;
  displayValue: number;
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
  isPrivate: boolean;
  description: string;
}

export interface UpdateRivenAuctionPayload {
  auctionId: string;
  buyoutPrice: number | null;
  startingPrice: number;
  isPrivate: boolean;
  description: string;
}
