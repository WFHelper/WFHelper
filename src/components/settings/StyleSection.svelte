<script lang="ts">
  import type { RelicCardStyle, ThemeCornerStyle, ThemeSurfaceStyle } from "../../types/theme.js";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { themeSettings } from "../../stores/theme.js";

  const cornerOptions: Array<{ value: ThemeCornerStyle; labelKey: MessageKey }> = [
    { value: "sharp", labelKey: "appearance.cornerSharp" },
    { value: "soft", labelKey: "appearance.cornerSoft" },
    { value: "round", labelKey: "appearance.cornerRound" },
  ];

  const surfaceOptions: Array<{ value: ThemeSurfaceStyle; labelKey: MessageKey }> = [
    { value: "full", labelKey: "appearance.surfaceFull" },
    { value: "border", labelKey: "appearance.surfaceBorder" },
    { value: "minimal", labelKey: "appearance.surfaceMinimal" },
  ];

  const relicCardOptions: Array<{ value: RelicCardStyle; labelKey: MessageKey }> = [
    { value: "ornate", labelKey: "appearance.relicCardsOrnate" },
    { value: "plain", labelKey: "appearance.relicCardsPlain" },
  ];

  $: effects = $themeSettings.effects;
</script>

<div class="appearance-section">
  <h4 class="appearance-section-label">{$tr("appearance.style")}</h4>

  <div class="grid gap-[0.55rem]">
    <div class="border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.cornerStyle")}</span>
        <div class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-surface text-[0.72rem]">
          {#each cornerOptions as option, index}
            <button
              type="button"
              class="px-2 py-1 transition-colors {index > 0 ? 'border-l border-border' : ''} {effects.cornerStyle === option.value ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
              on:click={() => themeSettings.setEffects({ cornerStyle: option.value })}
            >
              {$tr(option.labelKey)}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <div class="border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.surfaceStyle")}</span>
        <div class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-surface text-[0.72rem]">
          {#each surfaceOptions as option, index}
            <button
              type="button"
              class="px-2 py-1 transition-colors {index > 0 ? 'border-l border-border' : ''} {effects.surfaceStyle === option.value ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
              on:click={() => themeSettings.setEffects({ surfaceStyle: option.value })}
            >
              {$tr(option.labelKey)}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <label class="flex items-center justify-between gap-[0.6rem] cursor-pointer border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">
        {$tr("appearance.glass")}
        <span class="block text-[0.68rem] text-text-muted font-normal mt-[0.1rem]">{$tr("appearance.glassHint")}</span>
      </span>
      <input
        class="accent-accent"
        type="checkbox"
        checked={effects.glass}
        on:change={(e) => themeSettings.setEffects({ glass: (e.target as HTMLInputElement).checked })}
      />
    </label>

    <div class="border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.relicCards")}</span>
        <div class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-surface text-[0.72rem]">
          {#each relicCardOptions as option, index}
            <button
              type="button"
              class="px-2 py-1 transition-colors {index > 0 ? 'border-l border-border' : ''} {effects.relicCardStyle === option.value ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
              on:click={() => themeSettings.setEffects({ relicCardStyle: option.value })}
            >
              {$tr(option.labelKey)}
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
