<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import { sectionById } from "../../lib/layout/registry.js";
  import type { LayoutView } from "../../lib/layout/types.js";
  import {
    canUndo,
    editMode,
    layoutBreakpoint,
    layoutState,
    resetAll,
    resetView,
    sectionsOf,
    setHidden,
    undo,
  } from "../../stores/layout.js";
  import LayoutPresetPicker from "./LayoutPresetPicker.svelte";

  interface Props {
    view: LayoutView;
    /** Restricts the restore list to the sections this screen actually renders. */
    only?: readonly string[] | null;
  }

  const { view, only = null }: Props = $props();

  let showPresets = $state(false);

  const editing = $derived($editMode === view);
  const sections = $derived(sectionsOf($layoutState, view, $layoutBreakpoint));
  const hidden = $derived(
    sections.filter((section) => section.hidden && (!only || only.includes(section.id))),
  );

  function toggleEdit(): void {
    showPresets = false;
    editMode.set(editing ? null : view);
  }
</script>

<div class="relative flex flex-wrap items-center justify-end gap-1" data-layout-bar={view}>
  <button
    type="button"
    class="btn-secondary btn-sm gap-1.5"
    data-layout-edit-toggle={view}
    aria-pressed={editing}
    onclick={toggleEdit}
  >
    {#if !editing}
      <!-- Idle, this bar shares a header row with the title, so only the glyph shows. -->
      <svg
        class="shrink-0"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </svg>
    {/if}
    {editing ? $tr("layout.doneEditing") : $tr("layout.editLayout")}
  </button>

  {#if editing}
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-undo
      disabled={!$canUndo}
      onclick={undo}
    >
      {$tr("layout.undoChange")}
    </button>
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-reset-view
      onclick={() => resetView(view)}
    >
      {$tr("layout.resetView")}
    </button>
    <button type="button" class="btn-secondary btn-sm" data-layout-reset-all onclick={resetAll}>
      {$tr("layout.resetAllViews")}
    </button>
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-presets-toggle
      aria-expanded={showPresets}
      onclick={() => (showPresets = !showPresets)}
    >
      {$tr("layout.presets")}
    </button>

    {#if hidden.length > 0}
      <div
        class="flex basis-full flex-wrap items-center justify-end gap-1 text-xs text-text-secondary"
      >
        <span>{$tr("layout.hiddenSections")}</span>
        {#each hidden as section (section.id)}
          {@const descriptor = sectionById(section.id)}
          <button
            type="button"
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 transition-colors hover:border-accent hover:text-accent"
            data-layout-restore={section.id}
            onclick={() => setHidden(view, $layoutBreakpoint, section.id, false)}
          >
            {descriptor ? $tr(descriptor.labelKey) : section.id} · {$tr("layout.restore")}
          </button>
        {/each}
      </div>
    {/if}

    {#if showPresets}
      <LayoutPresetPicker {view} onClose={() => (showPresets = false)} />
    {/if}
  {/if}
</div>
