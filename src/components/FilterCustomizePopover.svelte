<script lang="ts">
  import { FILTER_CONTROL_LABEL_KEYS } from "../lib/filters.js";
  import { tr } from "../lib/i18n.js";
  import { createListDrag } from "../lib/listDrag.js";
  import { moveControl, resetScope, setHidden } from "../stores/filterLayout.js";
  import type { FilterControlId, FilterScope } from "../types/filters.js";

  // The bar owns the layout subscription and passes the resolved lists down.
  interface Props {
    scope: FilterScope;
    order: readonly FilterControlId[];
    hidden: readonly FilterControlId[];
    /** Position of a control in the scope's full order; the list shows a subset. */
    indexOf: (id: FilterControlId) => number;
    anchor: HTMLElement | null;
    onClose: () => void;
  }

  let { scope, order, hidden, indexOf, anchor, onClose }: Props = $props();

  // Controls the bar cannot render sit between the listed ones in the stored
  // order, so a move targets the neighbour's real position, not index +- 1.
  function moveBy(index: number, delta: number): void {
    const from = order[index];
    const to = order[index + delta];
    if (from && to) moveControl(scope, indexOf(from), indexOf(to));
  }

  let panel = $state<HTMLElement | null>(null);
  let top = $state(0);
  let left = $state(0);
  let focused = false;

  // Fixed, not absolute: the inline filter bar scrolls horizontally and would
  // clip a panel positioned inside it.
  function place(): void {
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8));
    top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - panel.offsetHeight - 8));
  }

  $effect(() => {
    place();
    if (panel && !focused) {
      focused = true;
      panel.querySelector<HTMLElement>("button, input")?.focus();
    }
  });

  function onWindowKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  }

  function onWindowPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // The toggle closes the panel itself, so a click on it must not close and reopen.
    if (panel?.contains(target) || target.closest("[data-filter-customize-toggle]")) return;
    onClose();
  }

  const controlDrag = createListDrag({
    rowSelector: "[data-filter-control]",
    indexKey: "filterControlIndex",
    move: (from, to) => moveBy(from, to - from),
  });

  function setVisible(id: FilterControlId, event: Event): void {
    setHidden(scope, id, !(event.currentTarget as HTMLInputElement).checked);
  }
</script>

<svelte:window
  onkeydown={onWindowKey}
  onpointerdown={onWindowPointerDown}
  onresize={place}
  onscroll={place}
/>

<div
  bind:this={panel}
  class="filter-customize"
  data-filter-customize={scope}
  role="dialog"
  aria-label={$tr("filters.customizeTitle")}
  style="top: {top}px; left: {left}px;"
>
  <div class="filter-customize-head">
    <span class="shared-chip-label">{$tr("filters.customizeTitle")}</span>
    <button type="button" class="btn-secondary btn-sm" onclick={() => resetScope(scope)}>
      {$tr("filters.resetLayout")}
    </button>
  </div>

  {#if hidden.includes("search")}
    <p class="filter-customize-hint">{$tr("filters.searchHiddenHint")}</p>
  {/if}

  <div class="filter-customize-list">
    {#each order as id, index (id)}
      {@const label = $tr(FILTER_CONTROL_LABEL_KEYS[id])}
      <div class="filter-customize-row" data-filter-control={id} data-filter-control-index={index}>
        <button
          type="button"
          class="filter-customize-grip"
          aria-label={$tr("settings.tabOrderHandle", { tab: label })}
          title={$tr("settings.tabOrderHandleHint")}
          onpointerdown={(event) => controlDrag.onPointerDown(index, event)}
          onkeydown={(event) => controlDrag.onKeyDown(index, event)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <span class="filter-customize-label">{label}</span>
        <button
          type="button"
          class="filter-customize-move"
          data-filter-control-up
          disabled={index === 0}
          aria-label={$tr("filters.moveControlUp")}
          title={$tr("filters.moveControlUp")}
          onclick={() => moveBy(index, -1)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M4 10l4-4 4 4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          class="filter-customize-move"
          data-filter-control-down
          disabled={index === order.length - 1}
          aria-label={$tr("filters.moveControlDown")}
          title={$tr("filters.moveControlDown")}
          onclick={() => moveBy(index, 1)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M4 6l4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <input
          type="checkbox"
          checked={!hidden.includes(id)}
          aria-label={$tr("settings.tabVisible", { tab: label })}
          onchange={(event) => setVisible(id, event)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .filter-customize {
    position: fixed;
    z-index: 260;
    width: 20rem;
    overflow-x: hidden;
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid var(--ui-control-border);
    border-radius: var(--radius-lg);
    background: var(--ui-panel-bg);
    box-shadow: 0 12px 30px color-mix(in oklab, var(--bg-deep) 45%, transparent);
  }
  .filter-customize-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .filter-customize-hint {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--text-secondary);
  }
  .filter-customize-list {
    display: grid;
    gap: 0.15rem;
  }
  .filter-customize-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.2rem;
    border-radius: var(--radius-sm);
  }
  .filter-customize-row:hover {
    background: var(--bg-hover);
  }
  .filter-customize-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--text-primary);
  }
  .filter-customize-grip,
  .filter-customize-move {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
  }
  .filter-customize-grip {
    cursor: grab;
    touch-action: none;
  }
  .filter-customize-grip:hover,
  .filter-customize-move:hover:not(:disabled) {
    background: var(--ui-control-bg);
    color: var(--text-primary);
  }
  .filter-customize-move:disabled {
    opacity: 0.35;
  }
  .filter-customize-grip svg,
  .filter-customize-move svg {
    width: 0.95rem;
    height: 0.95rem;
  }
</style>
