import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnNode } from "../../../config/shared/spawnNodeTypes";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, Array<() => void>>(),
}));

vi.mock("../../../src/lib/ipc.js", () => ({
  invoke: mocks.invoke,
  on: (channel: string, callback: () => void) => {
    mocks.listeners.set(channel, [...(mocks.listeners.get(channel) ?? []), callback]);
    return () => undefined;
  },
}));

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function freshStore() {
  vi.resetModules();
  return import("../../../src/stores/spawnNodes");
}

function emitItemDbUpdated(): void {
  for (const listener of mocks.listeners.get("item-db-updated") ?? []) listener();
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listeners.clear();
});

describe("spawn node catalog store", () => {
  it("pulls once however many panels ask", async () => {
    const nodes: SpawnNode[] = [];
    mocks.invoke.mockResolvedValue(nodes);
    const { requestSpawnNodes, spawnNodeCatalog } = await freshStore();

    expect(get(spawnNodeCatalog)).toBeNull();
    requestSpawnNodes();
    requestSpawnNodes();
    expect(get(spawnNodeCatalog)).toEqual({ status: "loading" });
    await settle();
    requestSpawnNodes();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("getSpawnNodes");
    expect(get(spawnNodeCatalog)).toEqual({ status: "ready", nodes });
  });

  it("retries a failed pull when the next panel asks", async () => {
    const nodes: SpawnNode[] = [];
    mocks.invoke.mockRejectedValueOnce(new Error("no handler")).mockResolvedValueOnce(nodes);
    const { requestSpawnNodes, spawnNodeCatalog } = await freshStore();

    requestSpawnNodes();
    await settle();
    expect(get(spawnNodeCatalog)).toEqual({ status: "failed" });
    // Nothing is shown yet, so a language change has nothing to re-pull.
    emitItemDbUpdated();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    requestSpawnNodes();
    await settle();
    expect(get(spawnNodeCatalog)).toEqual({ status: "ready", nodes });
  });

  it("re-pulls a shown catalog on a game language change and keeps it if that fails", async () => {
    const english: SpawnNode[] = [];
    const german: SpawnNode[] = [];
    mocks.invoke
      .mockResolvedValueOnce(english)
      .mockResolvedValueOnce(german)
      .mockRejectedValueOnce(new Error("main busy"));
    const { requestSpawnNodes, spawnNodeCatalog } = await freshStore();

    const shownNodes = () => {
      const state = get(spawnNodeCatalog);
      return state?.status === "ready" ? state.nodes : null;
    };

    requestSpawnNodes();
    await settle();
    expect(shownNodes()).toBe(english);
    emitItemDbUpdated();
    await settle();
    expect(shownNodes()).toBe(german);

    emitItemDbUpdated();
    await settle();
    expect(shownNodes()).toBe(german);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });
});
