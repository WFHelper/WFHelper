<script lang="ts">
  import { FILTER_CONTROL_LABEL_KEYS } from "../lib/filters.js";
  import { tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";
  import { moveControl, resetScope, setHidden } from "../stores/filterLayout.js";
  import type { FilterControlId, FilterScope } from "../types/filters.js";

  // The bar owns the layout subscription and passes the resolved lists down.
  interface Props {
    scope: FilterScope;
    order: readonly FilterControlId[];
    hidden: readonly FilterControlId[];
    anchor: HTMLElement | null;
    onClose: () => void;
  }

  let { scope, order, hidden, anchor, onClose }: Props = $props();

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;

  let panel = $state<HTMLElement | null>(null);
  let top = $state(0);
  let left = $state(0);
  let dragIndex: number | null = null;
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

  function startDrag(index: number, event: PointerEvent): void {
    // Only the primary button drags; another button would capture the pointer and
    // never see a matching pointerup.
    if (event.button !== 0) return;
    dragIndex = index;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  // Hit-tests the row under the pointer: the list reorders live, so cached rects
  // would be stale after the first swap.
  function onDrag(event: PointerEvent): void {
    if (dragIndex === null) return;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-filter-control]") as HTMLElement | null;
    if (!row) return;
    const target = Number(row.dataset["filterControlIndex"]);
    if (!Number.isInteger(target) || target === dragIndex) return;
    moveControl(scope, dragIndex, target);
    dragIndex = target;
  }

  function endDrag(event: PointerEvent): void {
    if (dragIndex === null) return;
    dragIndex = null;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }

  function onGripKey(index: number, event: KeyboardEvent): void {
    if (event.key === "ArrowUp") moveControl(scope, index, index - 1);
    else if (event.key === "ArrowDown") moveControl(scope, index, index + 1);
    else return;
    event.preventDefault();
  }

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
  aria-label={$tr(k("filters.customizeTitle"))}
  style="top: {top}px; left: {left}px;"
>
  <div class="filter-customize-head">
    <span class="shared-chip-label">{$tr(k("filters.customizeTitle"))}</span>
    <button type="button" class="btn-secondary btn-sm" onclick={() => resetScope(scope)}>
      {$tr(k("filters.resetLayout"))}
    </button>
  </div>

  {#if hidden.includes("search")}
    <p class="filter-customize-hint">{$tr(k("filters.searchHiddenHint"))}</p>
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
          onpointerdown={(event) => startDrag(index, event)}
          onpointermove={onDrag}
          onpointerup={endDrag}
          onpointercancel={endDrag}
          onlostpointercapture={endDrag}
          onkeydown={(event) => onGripKey(index, event)}
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
          aria-label={$tr(k("filters.moveControlUp"))}
          title={$tr(k("filters.moveControlUp"))}
          onclick={() => moveControl(scope, index, index - 1)}
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
          aria-label={$tr(k("filters.moveControlDown"))}
          title={$tr(k("filters.moveControlDown"))}
          onclick={() => moveControl(scope, index, index + 1)}
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
          class="accent-accent"
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
