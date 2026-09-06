import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

function storageStub(initial: Record<string, string> = {}): {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

// The store reads localStorage and the safe-mode flag at import time.
async function loadStore(): Promise<typeof import("../../../../src/stores/customCss.js")> {
  vi.resetModules();
  return import("../../../../src/stores/customCss.js");
}

describe("customCss store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts empty with nothing persisted", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub());
    const { customCss } = await loadStore();
    expect(get(customCss)).toEqual({ enabled: false, css: "", updatedAt: 0 });
  });

  it("round-trips through localStorage", async () => {
    const storage = storageStub();
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storage);

    const first = await loadStore();
    first.customCss.save(".x { color: red; }");
    first.customCss.setEnabled(true);
    expect(get(first.customCss).css).toBe(".x { color: red; }");

    const raw = storage.store.get(first.CUSTOM_CSS_STORAGE_KEY);
    expect(raw).toBeTruthy();

    const second = await loadStore();
    const reloaded = get(second.customCss);
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.css).toBe(".x { color: red; }");
    expect(reloaded.updatedAt).toBeGreaterThan(0);
  });

  it("falls back to empty on corrupt or wrongly typed storage", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub({ wf_custom_css_v1: "{not json" }));
    expect(get((await loadStore()).customCss)).toEqual({ enabled: false, css: "", updatedAt: 0 });

    vi.stubGlobal(
      "localStorage",
      storageStub({ wf_custom_css_v1: JSON.stringify({ enabled: "yes", css: 5, updatedAt: "x" }) }),
    );
    expect(get((await loadStore()).customCss)).toEqual({ enabled: false, css: "", updatedAt: 0 });
  });

  it("reset clears the saved sheet and the opt-in", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub());
    const { customCss } = await loadStore();
    customCss.save(".x { color: red; }");
    customCss.setEnabled(true);
    customCss.reset();
    expect(get(customCss).enabled).toBe(false);
    expect(get(customCss).css).toBe("");
  });
});

describe("applyCustomCss", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("emits nothing while the opt-in is off", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub());
    const { applyCustomCss } = await loadStore();
    expect(applyCustomCss({ enabled: false, css: ".x { color: red; }", updatedAt: 0 })).toEqual({
      css: "",
      warnings: [],
    });
  });

  it("sanitises and scopes the saved sheet when enabled", async () => {
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", storageStub());
    const { applyCustomCss, activeCustomCss, customCss } = await loadStore();

    const result = applyCustomCss({
      enabled: true,
      css: ".x { color: red; } @import 'a.css';",
      updatedAt: 0,
    });
    expect(result.css).toBe("#shell .x {\n  color: red;\n}");
    expect(result.warnings.map((warning) => warning.reason)).toEqual(["atImport"]);

    customCss.save(".x { color: red; }");
    customCss.setEnabled(true);
    expect(get(activeCustomCss)).toBe("#shell .x {\n  color: red;\n}");
  });

  it("emits nothing in safe mode even when enabled", async () => {
    vi.stubGlobal("location", { search: "?safe=1" });
    vi.stubGlobal("localStorage", storageStub());
    const { applyCustomCss, activeCustomCss, customCss, safeMode } = await loadStore();

    expect(get(safeMode)).toBe(true);
    expect(applyCustomCss({ enabled: true, css: ".x { color: red; }", updatedAt: 0 })).toEqual({
      css: "",
      warnings: [],
    });
    customCss.save(".x { color: red; }");
    customCss.setEnabled(true);
    expect(get(activeCustomCss)).toBe("");
  });
});
