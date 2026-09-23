import { get, writable, type Writable } from "svelte/store";
import type { DropSearchMode } from "../../config/shared/dropTypes.js";
import { redirectItemToRelic, redirectRelicToItem } from "../lib/relic/relicView.js";
import { componentOwnership, itemDb } from "./data.js";
import { relicDb } from "./relics.js";
import { relicViewPreference } from "./relicView.js";
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

const itemState = writable<ParsedItem | null>(null);
const relicState = writable<RelicGroup | null>(null);

/** Shows the breakdown whatever view is remembered, closing any item popup. */
export function openRelicDetailed(group: RelicGroup): void {
  itemState.set(null);
  relicState.set(group);
}

/** Shows the item popup whatever view is remembered, closing any breakdown. */
export function openRelicSimple(item: ParsedItem): void {
  relicState.set(null);
  itemState.set(item);
}

function setActiveItem(item: ParsedItem | null): void {
  const group = item ? redirectItemToRelic(get(relicViewPreference), item, get(relicDb)) : null;
  if (group) openRelicDetailed(group);
  else itemState.set(item);
}

function setActiveRelic(group: RelicGroup | null): void {
  const item = group
    ? redirectRelicToItem(get(relicViewPreference), group, get(itemDb), get(componentOwnership))
    : null;
  if (item) openRelicSimple(item);
  else relicState.set(group);
}

/** Every opener goes through these, so a remembered relic view applies to all tabs. */
export const activeItem: Writable<ParsedItem | null> = {
  subscribe: itemState.subscribe,
  set: setActiveItem,
  update: (fn) => setActiveItem(fn(get(itemState))),
};
export const activeRelic: Writable<RelicGroup | null> = {
  subscribe: relicState.subscribe,
  set: setActiveRelic,
  update: (fn) => setActiveRelic(fn(get(relicState))),
};
export const activeComponent = writable<ActiveComponentState | null>(null);
export const activeEnemy = writable<ActiveEnemyState | null>(null);

/** Hand-off for "see the rest of this in the Wiki tab": the enemy panel caps its
 *  own drop list, so it seeds a search and navigates instead. The mode travels
 *  with the query because each caller knows what it is handing over. */
export const wikiSearchRequest = writable<{ query: string; mode: DropSearchMode } | null>(null);
