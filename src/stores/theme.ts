import { writable } from "svelte/store";
import type { ThemeColors, ThemeEffects, ThemeFontSizes, ThemeSettings } from "../types/theme.js";
import {
  DEFAULT_BRANDING,
  DEFAULT_COLORS,
  DEFAULT_EFFECTS,
  DEFAULT_FONT_SIZES,
  DEFAULT_THEME,
} from "../config/themeDefaults.js";
import { THEME_PRESETS } from "../config/themePresets.js";
import {
  loadThemeSettings,
  saveThemeSettings,
  clearThemeSettings,
} from "../lib/theme/themeStorage.js";
import { applyTheme } from "../lib/theme/applyTheme.js";

const SAVE_DEBOUNCE_MS = 300;
const CUSTOM_THEME_PREFIX = "custom:";

function isCustomThemeId(value: string): boolean {
  return value.startsWith(CUSTOM_THEME_PREFIX);
}

function createCustomThemeId(): string {
  return `${CUSTOM_THEME_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeCustomThemeName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 40) : "Custom Theme";
}

function cloneDefaultSettings(): ThemeSettings {
  return {
    ...DEFAULT_THEME,
    colors: { ...DEFAULT_COLORS },
    fontSizes: { ...DEFAULT_FONT_SIZES },
    effects: { ...DEFAULT_EFFECTS },
    customThemes: [],
    branding: { ...DEFAULT_BRANDING },
  };
}

function applyMutableThemeEdits(
  settings: ThemeSettings,
  edits: Pick<Partial<ThemeSettings>, "colors" | "fontSizes" | "effects">,
): ThemeSettings {
  const next: ThemeSettings = {
    ...settings,
    ...edits,
    colors: edits.colors ? { ...edits.colors } : { ...settings.colors },
    fontSizes: edits.fontSizes ? { ...edits.fontSizes } : { ...settings.fontSizes },
    effects: edits.effects ? { ...edits.effects } : { ...settings.effects },
  };

  if (isCustomThemeId(settings.activePreset)) {
    let updatedActiveTheme = false;
    const customThemes = settings.customThemes.map((theme) => {
      if (theme.id !== settings.activePreset) return theme;
      updatedActiveTheme = true;
      return {
        ...theme,
        colors: { ...next.colors },
        fontSizes: { ...next.fontSizes },
        effects: { ...next.effects },
      };
    });

    return {
      ...next,
      activePreset: updatedActiveTheme ? settings.activePreset : "custom",
      customThemes,
    };
  }

  return {
    ...next,
    activePreset: "custom",
  };
}

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
      update((s) => {
        const preset = THEME_PRESETS[presetKey];
        const customPreset = s.customThemes.find((theme) => theme.id === presetKey);
        if (!preset && !customPreset) return s;

        const theme = preset ?? customPreset;
        if (!theme) return s;
        return {
          ...s,
          activePreset: presetKey,
          colors: { ...theme.colors },
          fontSizes: { ...theme.fontSizes },
          effects: { ...theme.effects },
        };
      });
    },

    /** Update a single colour key. Switches activePreset to "custom". */
    setColor(key: keyof ThemeColors, value: string): void {
      update((s) => applyMutableThemeEdits(s, { colors: { ...s.colors, [key]: value } }));
    },

    /** Update the global font scale. */
    setGlobalScale(globalScale: number): void {
      update((s) => applyMutableThemeEdits(s, { fontSizes: { ...s.fontSizes, globalScale } }));
    },

    /** Update one optional font-size override. */
    setOptionalFontSize(
      key: Exclude<keyof ThemeFontSizes, "globalScale">,
      value: number | undefined,
    ): void {
      update((s) => {
        const fontSizes = { ...s.fontSizes };
        if (value != null) {
          fontSizes[key] = value;
        } else {
          delete fontSizes[key];
        }
        return applyMutableThemeEdits(s, { fontSizes });
      });
    },

    /** Update theme effects such as corners, surface style, and glass blur. */
    setEffects(effects: Partial<ThemeEffects>): void {
      update((s) => applyMutableThemeEdits(s, { effects: { ...s.effects, ...effects } }));
    },

    /** Save the current edited appearance as a named custom theme. */
    saveCustomTheme(label: string): void {
      update((s) => {
        const name = sanitizeCustomThemeName(label);
        const id = createCustomThemeId();
        return {
          ...s,
          activePreset: id,
          customThemes: [
            ...s.customThemes,
            {
              id,
              label: name,
              colors: { ...s.colors },
              fontSizes: { ...s.fontSizes },
              effects: { ...s.effects },
            },
          ],
        };
      });
    },

    /** Delete a saved custom theme. */
    deleteCustomTheme(themeId: string): void {
      update((s) => {
        if (!isCustomThemeId(themeId)) return s;
        const customThemes = s.customThemes.filter((theme) => theme.id !== themeId);
        if (s.activePreset !== themeId) {
          return { ...s, customThemes };
        }
        const preset = THEME_PRESETS.default;
        return {
          ...s,
          activePreset: "default",
          colors: { ...preset.colors },
          fontSizes: { ...preset.fontSizes },
          effects: { ...preset.effects },
          customThemes,
        };
      });
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
      set(cloneDefaultSettings());
    },

    /** Reset only colours to the current preset (or default). */
    resetColors(): void {
      update((s) => {
        const preset = THEME_PRESETS[s.activePreset] || THEME_PRESETS.default;
        return applyMutableThemeEdits(s, { colors: { ...preset.colors } });
      });
    },

    /** Reset only font sizes to default. */
    resetFontSizes(): void {
      update((s) => applyMutableThemeEdits(s, { fontSizes: { ...DEFAULT_FONT_SIZES } }));
    },

  };
}

export const themeSettings = createThemeStore();
