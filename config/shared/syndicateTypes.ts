/** Shape of the generated syndicate rank table
 *  (scripts/syndicates/build-syndicate-ranks.mjs -> src/data/syndicateRanks.json). */

/** "normal" are the six aligned syndicates sharing one daily pool; "openWorld"
 *  each own a pool; "other" is Conclave. */
export type SyndicateKind = "normal" | "openWorld" | "other";

export interface SyndicateSacrificeItem {
  itemType: string;
  count: number;
  /** English name resolved at build time from DE's export dictionary. */
  name: string;
}

interface SyndicateSacrifice {
  credits: number;
  items: SyndicateSacrificeItem[];
}

interface SyndicateTitle {
  /** DE rank; the six aligned syndicates also carry -2 and -1, and never 0. */
  level: number;
  name: string;
  minStanding: number;
  maxStanding: number;
  /** Absent where ranking up costs only standing (Ventkids). */
  sacrifice?: SyndicateSacrifice;
}

export interface SyndicateMeta {
  tag: string;
  name: string;
  wikiPage: string;
  kind: SyndicateKind;
  dailyBin: string;
  /** Raw-inventory field holding today's remaining pool for this bin. */
  dailyField: string;
  /** Other tags this one is aligned with; negative factors are enemies. */
  alignments?: Record<string, number>;
  /** One-time cost of joining, paid before the rank 1 sacrifice. */
  initiation?: SyndicateSacrifice;
  titles: SyndicateTitle[];
}
