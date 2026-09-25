<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import {
    OVERLAY_OPACITY_MAX,
    OVERLAY_OPACITY_MIN,
  } from "../../../config/shared/overlayOpacity.js";
  import type { OverlayLayoutKind } from "../../../config/shared/overlayLayout.js";

  let {
    kind,
    label,
    idPrefix = "overlay-opacity",
    onOpacity,
    pending,
    onCommit,
  }: {
    kind?: OverlayLayoutKind;
    label: string;
    idPrefix?: string;
    onOpacity?: (opacity: number) => void;
    // With onCommit the caller stages the override (null inherits) instead of the store.
    pending?: number | null | undefined;
    onCommit?: (override: number | null) => void;
  } = $props();

  let draft = $state<number | null>(null);

  const stored = $derived(
    kind ? $themeSettings.effects.overlayOpacityOverrides?.[kind] : undefined,
  );
  const override = $derived(pending === undefined ? stored : (pending ?? undefined));
  const opacity = $derived(draft ?? override ?? $themeSettings.effects.overlayOpacity);
  const percent = $derived(Math.round(opacity * 100));
  const inputId = $derived(kind ? `${idPrefix}-${kind}` : undefined);

  $effect(() => {
    onOpacity?.(opacity);
  });

  function onInput(value: number): void {
    if (Number.isFinite(value)) draft = value / 100;
  }

  // The drag only moves the draft; the store write happens once on release so a
  // sweep does not queue a save and an overlay theme push per pixel.
  function commit(): void {
    if (draft === null) return;
    const value = draft;
    draft = null;
    if (onCommit) onCommit(value);
    else if (kind) themeSettings.setOverlayOpacity(kind, value);
    else themeSettings.setEffects({ overlayOpacity: value });
  }

  function useGlobal(): void {
    if (!kind) return;
    draft = null;
    if (onCommit) onCommit(null);
    else themeSettings.setOverlayOpacity(kind, null);
  }
</script>

<div data-overlay-opacity-kind={kind} class="space-y-1">
  {#if kind}
    <div class="flex flex-wrap items-center justify-between gap-1">
      <label for={inputId} class="text-text-secondary">{label}</label>
      <button
        type="button"
        class="text-text-muted hover:text-text-primary disabled:cursor-default disabled:hover:text-text-muted"
        disabled={override === undefined}
        onclick={useGlobal}
        >{$tr(
          override === undefined
            ? "appearance.overlayOpacityInherited"
            : "appearance.overlayOpacityUseGlobal",
        )}</button
      >
    </div>
  {/if}
  <div class="flex items-center gap-2">
    <input
      id={inputId}
      type="range"
      min={OVERLAY_OPACITY_MIN * 100}
      max={OVERLAY_OPACITY_MAX * 100}
      step="1"
      class="min-w-0 w-full accent-accent"
      aria-label={kind ? undefined : label}
      value={percent}
      oninput={(event) => onInput(event.currentTarget.valueAsNumber)}
      onchange={commit}
    />
    <span class="w-10 shrink-0 text-right text-xs text-text-primary tabular-nums">{percent}%</span>
  </div>
</div>
