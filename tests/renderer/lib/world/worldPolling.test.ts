import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));

vi.mock("../../../../src/lib/ipc.js", () => ({ invoke: h.invoke, on: h.on }));

const WORLD_POLL_MS = 30_000;

async function importModule() {
  vi.resetModules();
  return import("../../../../src/lib/world/useWorldView.js");
}

async function importWorldStore() {
  return import("../../../../src/stores/world.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  h.invoke.mockReset();
  h.invoke.mockResolvedValue(null);
  h.on.mockReset();
  h.on.mockImplementation(() => () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mountWorldPolling", () => {
  it("fetches once immediately and then on every poll tick", async () => {
    const { mountWorldPolling } = await importModule();

    const stop = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("getWorldState");

    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS);
    expect(h.invoke).toHaveBeenCalledTimes(2);

    stop();
  });

  it("keeps one interval and one initial fetch for two concurrent mounts", async () => {
    const { mountWorldPolling } = await importModule();

    const stopA = mountWorldPolling();
    const stopB = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS);
    expect(h.invoke).toHaveBeenCalledTimes(2);

    stopA();
    stopB();
  });

  it("keeps polling while another caller still holds the helper", async () => {
    const { mountWorldPolling } = await importModule();

    const stopA = mountWorldPolling();
    const stopB = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);

    stopA();
    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS);
    expect(h.invoke).toHaveBeenCalledTimes(2);

    stopB();
    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS * 3);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("ignores a stop called twice so the refcount cannot go negative", async () => {
    const { mountWorldPolling } = await importModule();

    const stopA = mountWorldPolling();
    const stopB = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);

    stopA();
    stopA();
    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS);
    expect(h.invoke).toHaveBeenCalledTimes(2);

    stopB();
    await vi.advanceTimersByTimeAsync(WORLD_POLL_MS * 2);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("restarts cleanly after the last caller has released it", async () => {
    const { mountWorldPolling } = await importModule();
    const { worldData, worldLastFetch } = await importWorldStore();

    mountWorldPolling()();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    // No payload arrived, so the freshness guard cannot suppress the next fetch.
    expect(get(worldData)).toBeNull();
    expect(get(worldLastFetch)).toBe(0);

    const stop = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    stop();
  });

  it("leaves the world loading flag down once a fetch settles", async () => {
    const { mountWorldPolling } = await importModule();
    const { worldLoading } = await importWorldStore();

    const stop = mountWorldPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(get(worldLoading)).toBe(false);
    stop();
  });
});
