import { writable } from "svelte/store";
import type { ThemeSettings, ThemeColors } from "../types/theme.js";
import { DEFAULT_THEME, DEFAULT_COLORS, DEFAULT_FONT_SIZES, DEFAULT_BRANDING } from "../config/themeDefaults.js";
import { THEME_PRESETS } from "../config/themePresets.js";
import { loadThemeSettings, saveThemeSettings, clearThemeSettings } from "../lib/theme/themeStorage.js";
import { applyTheme } from "../lib/theme/applyTheme.js";

const SAVE_DEBOUNCE_MS = 300;

function createThemeStore() {
  const initial = loadThemeSettings();
  const { subscribe, set, update } = writable<ThemeSettings>(initial);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Apply theme on every change and debounce save
  subscribe((settings) => {
    applyTheme(settings);

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveThemeSettings(settings);
    }, SAVE_DEBOUNCE_MS);
  });

  return {
    subscribe,
    set,
    update,

    /** Apply a named preset. */
    applyPreset(presetKey: string): void {
      const preset = THEME_PRESETS[presetKey];
      if (!preset) return;
      update((s) => ({
        ...s,
        activePreset: presetKey,
        colors: { ...preset.colors },
        fontSizes: { ...preset.fontSizes },
      }));
    },

    /** Update a single colour key. Switches activePreset to "custom". */
    setColor(key: keyof ThemeColors, value: string): void {
      update((s) => ({
        ...s,
        activePreset: "custom",
        colors: { ...s.colors, [key]: value },
      }));
    },

    /** Update the global font scale. */
    setGlobalScale(globalScale: number): void {
      update((s) => ({
        ...s,
        fontSizes: { ...s.fontSizes, globalScale },
      }));
    },

    /** Update branding. */
    setBranding(branding: Partial<ThemeSettings["branding"]>): void {
      update((s) => ({
        ...s,
        branding: { ...s.branding, ...branding },
      }));
    },

    /** Toggle contrast-safe mode. */
    setContrastSafeMode(enabled: boolean): void {
      update((s) => ({
        ...s,
        contrastSafeMode: enabled,
      }));
    },

    /** Reset everything to default. */
    resetAll(): void {
      clearThemeSettings();
      set({
        ...DEFAULT_THEME,
        colors: { ...DEFAULT_COLORS },
        fontSizes: { ...DEFAULT_FONT_SIZES },
        branding: { ...DEFAULT_BRANDING },
      });
    },

    /** Reset only colours to the current preset (or default). */
    resetColors(): void {
      update((s) => {
        const preset = THEME_PRESETS[s.activePreset] || THEME_PRESETS.default;
        return { ...s, colors: { ...preset.colors } };
      });
    },

    /** Reset only font sizes to default. */
    resetFontSizes(): void {
      update((s) => ({
        ...s,
        fontSizes: { ...DEFAULT_FONT_SIZES },
      }));
    },

    /** Reset only branding to default. */
    resetBranding(): void {
      update((s) => ({
        ...s,
        branding: { ...DEFAULT_BRANDING },
      }));
    },
  };
}

export const themeSettings = createThemeStore();
