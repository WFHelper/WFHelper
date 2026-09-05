import {
  LEDGER_QUERY_MAX_LIMIT,
  type LedgerQuery,
} from "../../../config/shared/tradeLedgerTypes.js";
import { invoke } from "../ipc.js";
import type { TradeEvent } from "../../types/ipc.js";

/**
 * Pages one ledger window newest-first up to `maxRows`. Null means `isCurrent`
 * went false, so the caller must leave its state alone.
 */
export async function pageLedgerRange(
  query: LedgerQuery,
  maxRows: number,
  isCurrent: () => boolean = () => true,
): Promise<{ events: TradeEvent[]; total: number } | null> {
  const collected: TradeEvent[] = [];
  let offset = 0;
  let total = 0;
  let more = true;
  while (more) {
    const page = await invoke("ledgerQuery", { ...query, offset, limit: LEDGER_QUERY_MAX_LIMIT });
    if (!isCurrent()) return null;
    total = page.total;
    collected.push(...page.events);
    offset += page.events.length;
    more = page.events.length > 0 && offset < total && collected.length < maxRows;
  }
  return { events: collected, total };
}
