import { writable } from "svelte/store";
import type {
  ThemeBaseColors,
  ThemeColors,
  ThemeEffects,
  ThemeFontSizes,
  ThemeSettings,
  ViewThemeOverride,
} from "../types/theme.js";
import type { ViewName } from "../types/views.js";
import {
  DEFAULT_FONT_SIZES,
  VIEW_FONT_SIZE_MAX,
  VIEW_FONT_SIZE_MIN,
} from "../config/themeDefaults.js";
import { THEME_PRESETS } from "../config/themePresets.js";
import {
  asOverrideColor,
  asOverrideFontSize,
  loadThemeSettings,
  saveThemeSettings,
  clearThemeSettings,
  cloneDefaultTheme,
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

/** Rewrite one view's override, dropping the entry once nothing is left in it. */
function withViewOverride(
  settings: ThemeSettings,
  view: ViewName,
  edit: (current: ViewThemeOverride) => ViewThemeOverride,
): ThemeSettings {
  const next = edit(settings.viewOverrides[view] ?? {});
  const colors = next.colors && Object.keys(next.colors).length > 0 ? next.colors : null;
  const fontSizes =
    next.fontSizes && Object.keys(next.fontSizes).length > 0 ? next.fontSizes : null;

  const viewOverrides = { ...settings.viewOverrides };
  if (colors || fontSizes) {
    const entry: ViewThemeOverride = {};
    if (colors) entry.colors = colors;
    if (fontSizes) entry.fontSizes = fontSizes;
    viewOverrides[view] = entry;
  } else {
    delete viewOverrides[view];
  }

  return { ...settings, viewOverrides };
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

  /** Override one base colour for a single view. The loader's validator decides:
      anything it drops would apply now and vanish on the next launch. */
  function setViewColor(view: ViewName, key: keyof ThemeBaseColors, value: string): void {
    const color = asOverrideColor(value);
    if (!color) return;
    update((s) =>
      withViewOverride(s, view, (current) => ({
        ...current,
        colors: { ...current.colors, [key]: color },
      })),
    );
  }

  /** Drop one per-view colour override so the view follows the global theme again. */
  function clearViewColor(view: ViewName, key: keyof ThemeBaseColors): void {
    update((s) => {
      const current = s.viewOverrides[view];
      if (!current?.colors || !(key in current.colors)) return s;
      return withViewOverride(s, view, (entry) => {
        const colors = { ...entry.colors };
        delete colors[key];
        return { ...entry, colors };
      });
    });
  }

  /** Override one font size for a single view; null clears it. The global scale is
      not scopable: rem resolves against the root. */
  function setViewFontSize(
    view: ViewName,
    key: Exclude<keyof ThemeFontSizes, "globalScale">,
    value: number | null,
  ): void {
    // The loader drops out-of-range sizes, so accepting one here would apply it
    // until the next launch and then lose it.
    if (
      value != null &&
      asOverrideFontSize(value, VIEW_FONT_SIZE_MIN, VIEW_FONT_SIZE_MAX) == null
    ) {
      return;
    }
    update((s) =>
      withViewOverride(s, view, (current) => {
        const fontSizes = { ...current.fontSizes };
        if (value == null) delete fontSizes[key];
        else fontSizes[key] = value;
        return { ...current, fontSizes };
      }),
    );
  }

  /** Drop every override a view holds. */
  function clearViewOverrides(view: ViewName): void {
    update((s) => {
      if (!(view in s.viewOverrides)) return s;
      const viewOverrides = { ...s.viewOverrides };
      delete viewOverrides[view];
      return { ...s, viewOverrides };
    });
  }

  return {
    subscribe,
    set,
    update,
    setViewColor,
    clearViewColor,
    setViewFontSize,
    clearViewOverrides,

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

    /** Set a per-view accent override (hex). */
    setViewAccent(view: ViewName, value: string): void {
      setViewColor(view, "accent", value);
    },

    /** Drop a per-view accent override so the view follows the theme accent. */
    clearViewAccent(view: ViewName): void {
      clearViewColor(view, "accent");
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
      set(cloneDefaultTheme());
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

    /** Reset one colour to the active preset's value (or the default preset's). */
    resetColor(key: keyof ThemeColors): void {
      update((s) => {
        const preset = THEME_PRESETS[s.activePreset] ?? THEME_PRESETS.default;
        return applyMutableThemeEdits(s, { colors: { ...s.colors, [key]: preset.colors[key] } });
      });
    },
  };
}

export const themeSettings = createThemeStore();

/** True while the element inspector is picking. Owned here so Settings and the
    App-level inspector overlay share one switch. */
export const themeInspectorActive = writable(false);
