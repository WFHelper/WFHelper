<script lang="ts">
  import { get } from "svelte/store";

  import SettingsSection from "./SettingsSection.svelte";
  import { tr } from "../../lib/i18n.js";
  import {
    SIDEBAR_VIEW_ORDER,
    VIEW_LABEL_KEYS,
    isToggleableView,
    type SidebarViewName,
  } from "../../lib/viewRegistry.js";
  import {
    moveSidebarView,
    resetSidebarLabels,
    resetSidebarOrder,
    setSidebarLabel,
    sidebarLabels,
    sidebarOrder,
    tabVisibility,
    SIDEBAR_LABEL_MAX,
  } from "../../stores/sidebarTabs.js";

  // Local mirror of the per-tab visibility stores so each checkbox can bind to a
  // plain bool; the change handler pushes back to the persisted store. Pinned
  // rows are present and true so one keyed input serves the whole ordered list.
  const tabChecked: Record<SidebarViewName, boolean> = $state(
    Object.fromEntries(
      SIDEBAR_VIEW_ORDER.map((view) => [
        view,
        isToggleableView(view) ? get(tabVisibility[view]) : true,
      ]),
    ) as Record<SidebarViewName, boolean>,
  );

  function setTabVisible(view: SidebarViewName): void {
    if (isToggleableView(view)) tabVisibility[view].set(tabChecked[view]);
  }

  // The store owns the trim and the length cap, so the committed value is read
  // back rather than leaving whatever the user typed sitting in the box.
  function commitLabel(view: SidebarViewName, input: HTMLInputElement): void {
    setSidebarLabel(view, input.value);
    input.value = get(sidebarLabels)[view] ?? "";
  }

  let orderDragIndex: number | null = null;

  function startOrderDrag(index: number, e: PointerEvent): void {
    // Only the primary button drags; a right- or middle-click would otherwise
    // capture the pointer and never see a matching pointerup.
    if (e.button !== 0) return;
    orderDragIndex = index;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  // Hit-tests the row under the pointer instead of measuring offsets: the list
  // reorders live, so cached rects would be stale after the first swap.
  function onOrderDrag(e: PointerEvent): void {
    if (orderDragIndex === null) return;
    const row = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-tab-order-row]") as HTMLElement | null;
    if (!row) return;
    const target = Number(row.dataset["tabOrderIndex"]);
    if (!Number.isInteger(target) || target === orderDragIndex) return;
    moveSidebarView(orderDragIndex, target);
    orderDragIndex = target;
  }

  function endOrderDrag(e: PointerEvent): void {
    if (orderDragIndex === null) return;
    orderDragIndex = null;
    const handle = e.currentTarget as HTMLElement;
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  }

  function onOrderKey(index: number, e: KeyboardEvent): void {
    if (e.key === "ArrowUp") moveSidebarView(index, index - 1);
    else if (e.key === "ArrowDown") moveSidebarView(index, index + 1);
    else return;
    e.preventDefault();
  }
</script>

<SettingsSection
  title={$tr("settings.sidebarTabsTitle")}
  description={$tr("settings.sidebarTabsDesc")}
>
  <div class="mt-2.5 grid gap-1" data-tab-order-list>
    {#each $sidebarOrder as view, index (view)}
      {@const defaultLabel = $tr(VIEW_LABEL_KEYS[view])}
      {@const label = $sidebarLabels[view] ?? defaultLabel}
      <div class="tab-order-row" data-tab-order-row={view} data-tab-order-index={index}>
        <button
          type="button"
          class="tab-order-handle"
          data-tab-order-handle={view}
          aria-label={$tr("settings.tabOrderHandle", { tab: label })}
          title={$tr("settings.tabOrderHandleHint")}
          onpointerdown={(e) => startOrderDrag(index, e)}
          onpointermove={onOrderDrag}
          onpointerup={endOrderDrag}
          onpointercancel={endOrderDrag}
          onlostpointercapture={endOrderDrag}
          onkeydown={(e) => onOrderKey(index, e)}
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
        <span class="tab-order-label truncate">{label}</span>
        <input
          type="text"
          class="tab-rename-input"
          data-tab-rename={view}
          value={$sidebarLabels[view] ?? ""}
          placeholder={defaultLabel}
          maxlength={SIDEBAR_LABEL_MAX}
          aria-label={$tr("settings.tabRenameLabel", { tab: label })}
          onchange={(event) => commitLabel(view, event.currentTarget)}
        />
        <input
          type="checkbox"
          bind:checked={tabChecked[view]}
          onchange={() => setTabVisible(view)}
          disabled={!isToggleableView(view)}
          title={isToggleableView(view) ? undefined : $tr("settings.tabAlwaysVisible")}
          aria-label={$tr("settings.tabVisible", { tab: label })}
          class="accent-accent"
        />
      </div>
    {/each}
  </div>
  <div class="mt-2.5 flex flex-wrap gap-2">
    <button class="btn-secondary btn-sm" data-tab-order-reset onclick={resetSidebarOrder}
      >{$tr("settings.tabOrderReset")}</button
    >
    <button class="btn-secondary btn-sm" data-tab-rename-reset onclick={resetSidebarLabels}
      >{$tr("settings.tabRenameReset")}</button
    >
  </div>
</SettingsSection>

<style>
  /* Mirrors .settings-control-row, plus a leading handle column. */
  .tab-order-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    border-radius: var(--radius-md);
    padding: 0.24rem 0.45rem;
    margin: 0 -0.45rem;
  }
  .tab-order-row:hover {
    background: var(--bg-hover);
  }

  .tab-order-label {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
  }

  /* Fixed width so the row keeps handle, name, field and checkbox on one line
     down to the narrowest masonry column; the name truncates instead. */
  .tab-rename-input {
    flex: 0 0 auto;
    width: 9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-primary);
    padding: 0.14rem 0.4rem;
    font-size: 0.8rem;
    outline: none;
  }
  .tab-rename-input:focus {
    border-color: var(--accent-dim);
  }

  .tab-order-handle {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    cursor: grab;
    /* A live pointer reorder must not be interrupted by the browser's own
       touch scrolling or text selection. */
    touch-action: none;
    user-select: none;
  }
  .tab-order-handle:hover,
  .tab-order-handle:focus-visible {
    color: var(--accent);
  }
  .tab-order-handle:active {
    cursor: grabbing;
  }
  .tab-order-handle svg {
    width: 1rem;
    height: 1rem;
    fill: none;
  }
</style>
