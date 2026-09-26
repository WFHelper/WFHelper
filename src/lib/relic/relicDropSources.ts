import { relicNameFromLabel } from "./relicInventory.js";
import { componentUniqueNameAliases } from "../../../config/shared/componentNames.js";
import { wfcdDropOrderKey } from "../../../config/shared/dropOrder.js";
import { RELIC_QUALITY_MODES } from "../../../config/shared/relicPlannerView.js";
import type { DropInfo } from "../../types/inventory.js";
import type { RelicDatabase, RelicGroup, RelicQuality, RelicReward } from "../../types/relics.js";

interface DropsItemDbEntry {
  name?: string;
  drops?: DropInfo[];
  components?: ReadonlyArray<{ drops?: DropInfo[] }>;
}

export type DropsItemDb = Record<string, DropsItemDbEntry>;

interface RewardHit {
  group: RelicGroup;
  quality: RelicQuality;
  reward: RelicReward;
}

interface RewardIndex {
  relicNames: Set<string>;
  byUniqueName: Map<string, RewardHit[]>;
  byName: Map<string, RewardHit[]>;
}

const rewardIndexes = new WeakMap<RelicDatabase, RewardIndex>();
const relicsNamedByItemData = new WeakMap<DropsItemDb, Set<string>>();

const nameKey = (name: string): string => name.trim().toLowerCase();

function relicNameKeys(group: RelicGroup): string[] {
  return [nameKey(group.key), nameKey(`${group.tier} ${group.code}`)];
}

function pushHit(index: Map<string, RewardHit[]>, key: string, hit: RewardHit): void {
  const hits = index.get(key);
  if (hits) hits.push(hit);
  else index.set(key, [hit]);
}

function rewardIndexFor(relicDb: RelicDatabase): RewardIndex {
  const cached = rewardIndexes.get(relicDb);
  if (cached) return cached;
  const index: RewardIndex = { relicNames: new Set(), byUniqueName: new Map(), byName: new Map() };
  for (const group of Object.values(relicDb.groups)) {
    for (const key of relicNameKeys(group)) index.relicNames.add(key);
    for (const quality of RELIC_QUALITY_MODES) {
      for (const reward of group.qualities[quality]?.rewards ?? []) {
        const hit = { group, quality, reward };
        if (reward.uniqueName) pushHit(index.byUniqueName, reward.uniqueName, hit);
        if (reward.name) pushHit(index.byName, nameKey(reward.name), hit);
      }
    }
  }
  rewardIndexes.set(relicDb, index);
  return index;
}

function relicsNamedIn(drops: readonly DropInfo[] | undefined, into: Set<string>): Set<string> {
  for (const drop of drops ?? []) into.add(nameKey(relicNameFromLabel(drop.location)));
  return into;
}

function relicsTheItemDataNames(itemDb: DropsItemDb): Set<string> {
  const cached = relicsNamedByItemData.get(itemDb);
  if (cached) return cached;
  const named = new Set<string>();
  for (const entry of Object.values(itemDb)) {
    relicsNamedIn(entry.drops, named);
    for (const component of entry.components ?? []) relicsNamedIn(component.drops, named);
  }
  relicsNamedByItemData.set(itemDb, named);
  return named;
}

function rewardHitsFor(
  uniqueName: string,
  drops: readonly DropInfo[],
  itemDb: DropsItemDb,
  index: RewardIndex,
): Set<RewardHit> {
  const names = new Set<string>();
  const english = itemDb[uniqueName]?.name;
  if (english) names.add(nameKey(english));
  // A weapon ingredient lists the relics of its parts, each under the part's name.
  for (const drop of drops) {
    if (typeof drop.type !== "string" || !drop.type.trim()) continue;
    if (index.relicNames.has(nameKey(relicNameFromLabel(drop.location)))) {
      names.add(nameKey(drop.type));
    }
  }
  const hits = new Set<RewardHit>();
  for (const alias of componentUniqueNameAliases(uniqueName)) {
    for (const hit of index.byUniqueName.get(alias) ?? []) hits.add(hit);
  }
  for (const name of names) {
    for (const hit of index.byName.get(name) ?? []) hits.add(hit);
  }
  return hits;
}

function refinementLocation(group: RelicGroup, quality: RelicQuality): string {
  if (quality === "intact") return `${group.name} Relic`;
  return `${group.name} Relic (${quality.charAt(0).toUpperCase()}${quality.slice(1)})`;
}

function insertInDropOrder(drops: readonly DropInfo[], added: readonly DropInfo[]): DropInfo[] {
  const out = [...drops];
  for (const drop of added) {
    const key = wfcdDropOrderKey(drop);
    const at = out.findIndex((other) => wfcdDropOrderKey(other).localeCompare(key, "en") > 0);
    out.splice(at < 0 ? out.length : at, 0, drop);
  }
  return out;
}

/** The item data's drops plus the relics of this relic database that list the item and
 *  that no drop list of the item data names; a relic it names anywhere stays as listed,
 *  so the bundled relics alone return `drops` itself. */
export function withRelicDbSources(
  drops: DropInfo[],
  uniqueName: string,
  itemDb: DropsItemDb,
  relicDb: RelicDatabase,
): DropInfo[] {
  const index = rewardIndexFor(relicDb);
  const hits = rewardHitsFor(uniqueName, drops, itemDb, index);
  if (hits.size === 0) return drops;
  const listedHere = relicsNamedIn(drops, new Set());
  const listedAnywhere = relicsTheItemDataNames(itemDb);
  const hitKeys = [...hits].map((hit) => relicNameKeys(hit.group));
  // 738 bundled entries list nothing while their parent's row names the relics; the new
  // relics alone would read as their only source there.
  if (
    !hitKeys.some((keys) => keys.some((key) => listedHere.has(key))) &&
    hitKeys.some((keys) => keys.some((key) => listedAnywhere.has(key)))
  ) {
    return drops;
  }
  const added: DropInfo[] = [];
  const seen = new Set<string>();
  for (const { group, quality, reward } of hits) {
    const keys = relicNameKeys(group);
    if (keys.some((key) => listedHere.has(key))) continue;
    if (keys.some((key) => listedAnywhere.has(key))) continue;
    const location = refinementLocation(group, quality);
    const id = `${location}|${reward.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({ location, type: reward.name, chance: reward.chance, rarity: reward.rarity });
  }
  return added.length > 0 ? insertInDropOrder(drops, added) : drops;
}
