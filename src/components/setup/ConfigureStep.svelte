<script lang="ts">
  import { onMount } from "svelte";

  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { getPlatform } from "../../lib/ipc.js";
  import { PRESET_KEYS, THEME_PRESETS } from "../../config/themePresets.js";
  import { themeSettings } from "../../stores/theme.js";
  import { loadUiScale, saveUiScale } from "../../lib/uiScaleSetting.js";
  import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "../../../config/runtime/uiScale.js";
  import type { ThemeCornerStyle, ThemeSurfaceStyle } from "../../types/theme.js";
  import SegmentedControl from "../SegmentedControl.svelte";
  import GlassBlurControl from "../settings/GlassBlurControl.svelte";
  import ProtonLaunchOption from "../ProtonLaunchOption.svelte";

  const isLinux = getPlatform() === "linux";
  let uiScale = $state(1);

  const surfaceOptions: Array<{ value: ThemeSurfaceStyle; labelKey: MessageKey }> = [
    { value: "full", labelKey: "appearance.surfaceFull" },
    { value: "border", labelKey: "common.border" },
    { value: "minimal", labelKey: "appearance.surfaceMinimal" },
  ];
  const cornerOptions: Array<{ value: ThemeCornerStyle; labelKey: MessageKey }> = [
    { value: "sharp", labelKey: "appearance.cornerSharp" },
    { value: "soft", labelKey: "appearance.cornerSoft" },
    { value: "round", labelKey: "appearance.cornerRound" },
  ];
  // A starter spread across the dark, light and glass looks; the rest live in
  // Settings > Appearance.
  const SETUP_THEME_KEYS = [
    "default",
    "midnight",
    "graphite",
    "tennoMinimal",
    "light",
    "corpusGlass",
  ];

  onMount(() => {
    // Not awaited: the step renders straight away and the slider fills itself in.
    loadUiScale()
      .then((value) => (uiScale = value))
      .catch(() => {});
  });

  // On release, not on input: each save re-zooms the window under the cursor.
  function commitUiScale(): void {
    void saveUiScale(uiScale).catch(() => {});
  }

  const surfaceSegOptions = $derived(
    surfaceOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) })),
  );
  const cornerSegOptions = $derived(
    cornerOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) })),
  );
  const effects = $derived($themeSettings.effects);
  const activePresetKey = $derived(
    PRESET_KEYS.includes($themeSettings.activePreset) ? $themeSettings.activePreset : "default",
  );
</script>

<h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
  {$tr("setup.welcomeTitle")}
</h2>

<div class="grid gap-3">
  <div
    class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
  >
    <div class="mb-2 flex items-start justify-between gap-3">
      <div>
        <h3 class="m-0 font-display text-sm font-semibold text-text-primary">
          {$tr("common.appSize")}
        </h3>
        <p class="mt-0.5 text-xs leading-snug text-text-muted">
          {$tr("setup.appSize.hint")}
        </p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <input
        type="range"
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={UI_SCALE_STEP}
        bind:value={uiScale}
        onchange={commitUiScale}
        class="h-1.5 flex-1 cursor-pointer"
        style="accent-color: var(--accent);"
        aria-label={$tr("common.appSize")}
      />
      <span class="w-10 shrink-0 text-right text-xs text-text-muted"
        >{Math.round(uiScale * 100)}%</span
      >
    </div>
  </div>

  <div
    class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
  >
    <div class="mb-2 flex items-start justify-between gap-3">
      <div>
        <h3 class="m-0 font-display text-sm font-semibold text-text-primary">
          {$tr("setup.theme.title")}
        </h3>
        <p class="mt-0.5 text-xs leading-snug text-text-muted">
          {$tr("setup.theme.hint")}
        </p>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-2">
      {#each SETUP_THEME_KEYS as key (key)}
        {@const preset = THEME_PRESETS[key]}
        <button
          type="button"
          class="rounded-lg border p-2.5 text-left transition-colors duration-150 {activePresetKey ===
          key
            ? 'border-accent ring-1 ring-accent'
            : 'border-border hover:border-border-strong'}"
          style="background: {preset.colors.bgSurface};"
          aria-pressed={activePresetKey === key}
          onclick={() => themeSettings.applyPreset(key)}
        >
          <span class="flex gap-1">
            <span
              class="h-3 w-3 rounded-[3px] border border-border-subtle"
              style="background: {preset.colors.bgBase};"
            ></span>
            <span
              class="h-3 w-3 rounded-[3px] border border-border-subtle"
              style="background: {preset.colors.bgRaised};"
            ></span>
            <span
              class="h-3 w-3 rounded-[3px] border border-border-subtle"
              style="background: {preset.colors.textPrimary};"
            ></span>
            <span
              class="h-3 w-3 rounded-[3px] border border-border-subtle"
              style="background: {preset.colors.accent};"
            ></span>
          </span>
          <span
            class="mt-1.5 block truncate text-xs font-semibold"
            style="color: {preset.colors.textPrimary};">{preset.label}</span
          >
        </button>
      {/each}
    </div>
    <p class="m-0 mt-2 text-xs text-text-muted">
      {$tr("setup.theme.footer")}
    </p>
  </div>

  {#if isLinux}
    <div
      class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
    >
      <ProtonLaunchOption compact />
    </div>
  {/if}

  <div
    class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
  >
    <div class="mb-2 flex items-start justify-between gap-3">
      <div>
        <h3 class="m-0 font-display text-sm font-semibold text-text-primary">
          {$tr("setup.uiStyle.title")}
        </h3>
        <p class="mt-0.5 text-xs leading-snug text-text-muted">
          {$tr("setup.uiStyle.hint")}
        </p>
      </div>
    </div>
    <SegmentedControl
      value={effects.surfaceStyle}
      options={surfaceSegOptions}
      onChange={(surfaceStyle) => themeSettings.setEffects({ surfaceStyle })}
    />
  </div>

  <div
    class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
  >
    <div class="mb-2 flex items-start justify-between gap-3">
      <div>
        <h3 class="m-0 font-display text-sm font-semibold text-text-primary">
          {$tr("setup.borderStyle.title")}
        </h3>
        <p class="mt-0.5 text-xs leading-snug text-text-muted">
          {$tr("setup.borderStyle.hint")}
        </p>
      </div>
    </div>
    <SegmentedControl
      value={effects.cornerStyle}
      options={cornerSegOptions}
      onChange={(cornerStyle) => themeSettings.setEffects({ cornerStyle })}
    />
  </div>

  <div
    class="rounded-lg border border-[var(--ui-panel-border)] bg-[var(--ui-control-bg)] px-3 py-3 [backdrop-filter:var(--ui-backdrop-blur)]"
  >
    <GlassBlurControl labelClass="flex cursor-pointer items-start justify-between gap-3">
      <div>
        <h3 class="m-0 font-display text-sm font-semibold text-text-primary">
          {$tr("common.glassBlur")}
        </h3>
        <p class="mt-0.5 text-xs leading-snug text-text-muted">
          {$tr("setup.glassBlur.hint")}
        </p>
      </div>
    </GlassBlurControl>
  </div>
</div>
