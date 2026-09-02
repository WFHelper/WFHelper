<script lang="ts">
  import { tr, type MessageKey } from "../../lib/i18n.js";
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
  const k = (key: string): MessageKey => key as MessageKey;

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
    class="btn-secondary btn-sm"
    data-layout-edit-toggle={view}
    aria-pressed={editing}
    onclick={toggleEdit}
  >
    {editing ? $tr(k("layout.doneEditing")) : $tr(k("layout.editLayout"))}
  </button>

  {#if editing}
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-undo
      disabled={!$canUndo}
      onclick={undo}
    >
      {$tr(k("layout.undoChange"))}
    </button>
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-reset-view
      onclick={() => resetView(view)}
    >
      {$tr(k("layout.resetView"))}
    </button>
    <button type="button" class="btn-secondary btn-sm" data-layout-reset-all onclick={resetAll}>
      {$tr(k("layout.resetAllViews"))}
    </button>
    <button
      type="button"
      class="btn-secondary btn-sm"
      data-layout-presets-toggle
      aria-expanded={showPresets}
      onclick={() => (showPresets = !showPresets)}
    >
      {$tr(k("layout.presets"))}
    </button>

    {#if hidden.length > 0}
      <div
        class="flex basis-full flex-wrap items-center justify-end gap-1 text-xs text-text-secondary"
      >
        <span>{$tr(k("layout.hiddenSections"))}</span>
        {#each hidden as section (section.id)}
          {@const descriptor = sectionById(section.id)}
          <button
            type="button"
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 transition-colors hover:border-accent hover:text-accent"
            data-layout-restore={section.id}
            onclick={() => setHidden(view, $layoutBreakpoint, section.id, false)}
          >
            {descriptor ? $tr(descriptor.labelKey) : section.id} · {$tr(k("layout.restore"))}
          </button>
        {/each}
      </div>
    {/if}

    {#if showPresets}
      <LayoutPresetPicker {view} onClose={() => (showPresets = false)} />
    {/if}
  {/if}
</div>
