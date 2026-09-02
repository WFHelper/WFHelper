import { afterEach, describe, expect, it, vi } from "vitest";

interface StorageStub {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function storageStub(initial: Record<string, string> = {}): StorageStub {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

// isSafeMode memoises and consumes the one-shot flag, so every case needs a fresh module.
async function loadSafeMode(): Promise<typeof import("../../../../src/lib/customCss/safeMode.js")> {
  vi.resetModules();
  return import("../../../../src/lib/customCss/safeMode.js");
}

describe("isSafeMode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off with no flag anywhere", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub());
    const { isSafeMode } = await loadSafeMode();
    expect(isSafeMode()).toBe(false);
  });

  it("reads safe=1 from the launch query", async () => {
    vi.stubGlobal("location", { search: "?safe=1" });
    vi.stubGlobal("localStorage", storageStub());
    const { isSafeMode } = await loadSafeMode();
    expect(isSafeMode()).toBe(true);
  });

  it("ignores any other value of the query flag", async () => {
    vi.stubGlobal("location", { search: "?safe=0" });
    vi.stubGlobal("localStorage", storageStub());
    const { isSafeMode } = await loadSafeMode();
    expect(isSafeMode()).toBe(false);
  });

  it("consumes the one-shot flag but keeps reporting safe mode for this load", async () => {
    const storage = storageStub({ wf_safe_mode_once: "1" });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storage);
    const { isSafeMode, SAFE_MODE_ONCE_KEY } = await loadSafeMode();

    expect(isSafeMode()).toBe(true);
    expect(storage.store.has(SAFE_MODE_ONCE_KEY)).toBe(false);
    expect(isSafeMode()).toBe(true);
  });

  it("is off on the next load after the one-shot flag was consumed", async () => {
    const storage = storageStub({ wf_safe_mode_once: "1" });
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storage);
    expect((await loadSafeMode()).isSafeMode()).toBe(true);
    expect((await loadSafeMode()).isSafeMode()).toBe(false);
  });

  it("survives storage that throws", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    const { isSafeMode } = await loadSafeMode();
    expect(isSafeMode()).toBe(false);
  });
});

describe("restartInSafeMode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("arms the one-shot flag and reloads", async () => {
    const storage = storageStub();
    const reload = vi.fn();
    vi.stubGlobal("location", { search: "", reload });
    vi.stubGlobal("localStorage", storage);
    const { restartInSafeMode, SAFE_MODE_ONCE_KEY } = await loadSafeMode();

    restartInSafeMode();
    expect(storage.store.get(SAFE_MODE_ONCE_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when storage refuses the flag", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { search: "", reload });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    const { restartInSafeMode } = await loadSafeMode();

    restartInSafeMode();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
