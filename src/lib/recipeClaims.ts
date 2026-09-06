import type { ClaimNode, ItemDbEntry, MasteryStatus, RecipeClaim } from "../types/inventory.js";

export type { RecipeClaim };

interface PartClaimResult {
  /** Copies spoken for by an unfinished recipe, capped at what is owned. */
  reserved: number;
  /** Copies free to sell. */
  sellable: number;
  claims: RecipeClaim[];
}

interface ClaimResolverOptions {
  /** Reserve an extra copy of gear another recipe consumes, so the player keeps
   *  the single alongside the combined version (Bronco Prime + Akbronco Prime). */
  keepVariants?: boolean;
}

interface ParentLink {
  parentUniqueName: string;
  /** Copies of the child that one build of the parent consumes. */
  required: number;
}

type StatusLookup = (uniqueName: string) => MasteryStatus | undefined;
type OwnedLookup = (uniqueName: string) => number;

interface ClaimResolver {
  (uniqueName: string, owned: number): PartClaimResult;
  /** Builds of this item still outstanding; exposed for callers that want the
   *  recipe-level number rather than one part's claims. */
  buildsNeeded: (uniqueName: string) => number;
}

/** child uniqueName -> recipes consuming it, per-build counts summed. DE lists a
 *  doubled ingredient as two entries, so accumulate rather than overwrite. */
function buildParentIndex(itemDb: Record<string, ItemDbEntry>): Map<string, ParentLink[]> {
  const index = new Map<string, ParentLink[]>();
  for (const [parentUniqueName, entry] of Object.entries(itemDb)) {
    const components = Array.isArray(entry.components) ? entry.components : [];
    if (components.length === 0) continue;

    const perChild = new Map<string, number>();
    for (const component of components) {
      const childUniqueName = component.uniqueName;
      if (!childUniqueName) continue;
      const required = Math.max(1, Math.floor(component.itemCount ?? 1));
      perChild.set(childUniqueName, (perChild.get(childUniqueName) ?? 0) + required);
    }

    for (const [childUniqueName, required] of perChild) {
      const links = index.get(childUniqueName);
      const link = { parentUniqueName, required };
      if (links) links.push(link);
      else index.set(childUniqueName, [link]);
    }
  }
  return index;
}

export function buildClaimResolver(
  itemDb: Record<string, ItemDbEntry>,
  statusOf: StatusLookup,
  ownedOf: OwnedLookup,
  options: ClaimResolverOptions = {},
): ClaimResolver {
  const parentIndex = buildParentIndex(itemDb);
  const keepVariants = options.keepVariants === true;

  const memo = new Map<string, number>();
  const inProgress = new Set<string>();

  function isMasteryTarget(uniqueName: string): boolean {
    // Appearing in the mastery catalogue is what makes something a target; the
    // db's `masterable` flag is unset on plenty of real rows. A part is never a
    // target itself, only the gear it builds.
    if (statusOf(uniqueName) === undefined) return false;
    return itemDb[uniqueName]?.isBuildComponent !== true;
  }

  /** Copies of `uniqueName` that still have to be produced. */
  function buildsNeeded(uniqueName: string): number {
    const cached = memo.get(uniqueName);
    if (cached !== undefined) return cached;
    // A recipe reachable from itself contributes nothing on the second visit.
    if (inProgress.has(uniqueName)) return 0;

    inProgress.add(uniqueName);
    let fromParents = 0;
    for (const link of parentIndex.get(uniqueName) ?? []) {
      fromParents += link.required * buildsNeeded(link.parentUniqueName);
    }
    inProgress.delete(uniqueName);

    // Mastery is earned by levelling, not by keeping: one copy can be mastered
    // and then consumed, so the mastery target overlaps recipe demand.
    const masteryTarget =
      isMasteryTarget(uniqueName) && statusOf(uniqueName) !== "mastered" ? 1 : 0;
    let target = Math.max(fromParents, masteryTarget);
    if (keepVariants && fromParents > 0 && isMasteryTarget(uniqueName)) target += 1;

    const needed = Math.max(0, target - ownedOf(uniqueName));
    memo.set(uniqueName, needed);
    return needed;
  }

  /** Recipes from the direct parent up to whatever is actually unfinished, so a
   *  part held for a mastered weapon can name the build really asking for it. */
  function drivingChain(uniqueName: string, seen = new Set<string>()): ClaimNode[] {
    const node = {
      uniqueName,
      name: itemDb[uniqueName]?.name ?? uniqueName,
      status: statusOf(uniqueName),
    };
    if (seen.has(uniqueName)) return [node];
    seen.add(uniqueName);

    if (isMasteryTarget(uniqueName) && statusOf(uniqueName) !== "mastered") return [node];

    let driver = "";
    let driverDemand = 0;
    for (const link of parentIndex.get(uniqueName) ?? []) {
      const contribution = link.required * buildsNeeded(link.parentUniqueName);
      if (contribution > driverDemand) {
        driverDemand = contribution;
        driver = link.parentUniqueName;
      }
    }
    return driver ? [node, ...drivingChain(driver, seen)] : [node];
  }

  const resolve = ((uniqueName: string, owned: number): PartClaimResult => {
    const claims: RecipeClaim[] = [];
    let demand = 0;

    for (const link of parentIndex.get(uniqueName) ?? []) {
      const count = link.required * buildsNeeded(link.parentUniqueName);
      if (count <= 0) continue;
      demand += count;
      claims.push({
        parentUniqueName: link.parentUniqueName,
        parentName: itemDb[link.parentUniqueName]?.name ?? link.parentUniqueName,
        count,
        parentStatus: statusOf(link.parentUniqueName),
        chain: drivingChain(link.parentUniqueName),
      });
    }

    claims.sort((a, b) => b.count - a.count || a.parentName.localeCompare(b.parentName));
    return {
      reserved: Math.min(owned, demand),
      sellable: Math.max(0, owned - demand),
      claims,
    };
  }) as ClaimResolver;

  resolve.buildsNeeded = buildsNeeded;
  return resolve;
}
