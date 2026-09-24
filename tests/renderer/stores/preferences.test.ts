import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

async function loadPreferences(stored: Record<string, string> = {}): Promise<{
  prefs: typeof import("../../../src/stores/preferences.js");
  mem: Map<string, string>;
}> {
  const mem = new Map(Object.entries(stored));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  // The stores read localStorage once at module load.
  vi.resetModules();
  const prefs = await import("../../../src/stores/preferences.js");
  return { prefs, mem };
}

describe("showFoundryReadyBadges", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to shown so existing users keep the F badge", async () => {
    const { prefs } = await loadPreferences();
    expect(get(prefs.showFoundryReadyBadges)).toBe(true);
  });

  it("starts hidden for users who had hidden parent badges, which covered F too", async () => {
    const { prefs, mem } = await loadPreferences({ wf_show_owned_parent_badges: "0" });
    expect(get(prefs.showOwnedParentBadges)).toBe(false);
    expect(get(prefs.showFoundryReadyBadges)).toBe(false);
    expect(mem.get("wf_show_foundry_ready_badges")).toBe("0");
  });

  it("seeds only once, so hiding C later leaves F alone", async () => {
    const first = await loadPreferences();
    expect(first.mem.get("wf_show_foundry_ready_badges")).toBe("1");
    first.prefs.showOwnedParentBadges.set(false);
    const { prefs } = await loadPreferences(Object.fromEntries(first.mem));
    expect(get(prefs.showFoundryReadyBadges)).toBe(true);
  });

  it("is independent of the parent-owned badge preference once set", async () => {
    const { prefs, mem } = await loadPreferences({
      wf_show_owned_parent_badges: "0",
      wf_show_foundry_ready_badges: "1",
    });
    expect(get(prefs.showFoundryReadyBadges)).toBe(true);

    prefs.showFoundryReadyBadges.set(false);
    expect(mem.get("wf_show_foundry_ready_badges")).toBe("0");
    expect(mem.get("wf_show_owned_parent_badges")).toBe("0");
  });

  it("restores a hidden F badge", async () => {
    const { prefs } = await loadPreferences({ wf_show_foundry_ready_badges: "0" });
    expect(get(prefs.showFoundryReadyBadges)).toBe(false);
  });
});
