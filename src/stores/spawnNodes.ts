import { get, writable, type Readable } from "svelte/store";
import type { SpawnNode } from "../../config/shared/spawnNodeTypes.js";
import { invoke, on } from "../lib/ipc.js";

type SpawnNodeCatalog =
  | { status: "loading" }
  | { status: "ready"; nodes: SpawnNode[] }
  | { status: "failed" };

const catalog = writable<SpawnNodeCatalog | null>(null);

/** The star-chart node catalog; null until a spawn panel first asks for it. */
export const spawnNodeCatalog: Readable<SpawnNodeCatalog | null> = {
  subscribe: catalog.subscribe,
};

let request = 0;
let followsGameLanguage = false;

function pull(): void {
  const id = ++request;
  invoke("getSpawnNodes").then(
    (nodes) => {
      if (id === request) catalog.set({ status: "ready", nodes });
    },
    () => {
      // A failed refresh keeps the rows already shown.
      if (id === request && get(catalog)?.status !== "ready") catalog.set({ status: "failed" });
    },
  );
}

/** Pulls the catalog once per session; a failed pull is retried by the next
 *  request, which a panel makes per enemy. Main names the nodes in the game
 *  language and signals a change of it with item-db-updated, so a catalog
 *  already shown is pulled again then. */
export function requestSpawnNodes(): void {
  if (!followsGameLanguage) {
    followsGameLanguage = true;
    on("item-db-updated", () => {
      if (get(catalog)?.status === "ready") pull();
    });
  }
  const status = get(catalog)?.status;
  if (status === "loading" || status === "ready") return;
  catalog.set({ status: "loading" });
  pull();
}
