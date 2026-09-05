import { writable } from "svelte/store";
import type { DropSearchMode } from "../../config/shared/dropTypes.js";
import type { ComponentInfo, ParsedItem } from "../types/inventory.js";
import type { RelicGroup } from "../types/relics.js";

interface ActiveComponentState {
  comp: ComponentInfo;
  parentName: string;
}

/** The Wiki tab knows only the drop table's spelling; the Codex also knows the
 *  internal path, which is the exact key the scan join uses. */
interface ActiveEnemyState {
  name: string;
  type?: string;
}

export const activeItem = writable<ParsedItem | null>(null);
export const activeComponent = writable<ActiveComponentState | null>(null);
export const activeRelic = writable<RelicGroup | null>(null);
export const activeEnemy = writable<ActiveEnemyState | null>(null);

/** Hand-off for "see the rest of this in the Wiki tab": the enemy panel caps its
 *  own drop list, so it seeds a search and navigates instead. The mode travels
 *  with the query because each caller knows what it is handing over. */
export const wikiSearchRequest = writable<{ query: string; mode: DropSearchMode } | null>(null);
