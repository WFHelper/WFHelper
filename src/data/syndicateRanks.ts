// Typed shim over the generated table (scripts/syndicates/build-syndicate-ranks.mjs
// writes the JSON; source is DE's PublicExport ExportSyndicates).
import data from "./syndicateRanks.json";
import type { SyndicateMeta } from "../../config/shared/syndicateTypes.js";

export const SYNDICATE_RANKS = data.syndicates as SyndicateMeta[];
