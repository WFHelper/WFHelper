import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadThemeSettings } from "../../../../src/lib/theme/themeStorage.js";
import { VIEW_NAMES } from "../../../../src/types/views.js";

function store(settings: unknown): void {
  localStorage.setItem("wf_theme_settings", JSON.stringify(settings));
}

describe("per-view override keys", () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => void mem.set(key, value),
      removeItem: (key: string) => void mem.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps an override for every view the app knows", () => {
    const viewOverrides = Object.fromEntries(
      VIEW_NAMES.map((view) => [view, { colors: { accent: "#123456" } }]),
    );
    store({ version: 1, viewOverrides });
    expect(Object.keys(loadThemeSettings().viewOverrides).sort()).toEqual([...VIEW_NAMES].sort());
  });

  it("drops a key that is not a view", () => {
    store({
      version: 1,
      viewOverrides: {
        world: { colors: { accent: "#123456" } },
        "not-a-view": { colors: { accent: "#123456" } },
        constructor: { colors: { accent: "#123456" } },
      },
    });
    expect(Object.keys(loadThemeSettings().viewOverrides)).toEqual(["world"]);
  });
});
