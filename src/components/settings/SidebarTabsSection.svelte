<script lang="ts">
  import { get } from "svelte/store";

  import SettingsSection from "./SettingsSection.svelte";
  import { tr } from "../../lib/i18n.js";
  import { createListDrag } from "../../lib/listDrag.js";
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

  const orderDrag = createListDrag({
    rowSelector: "[data-tab-order-row]",
    indexKey: "tabOrderIndex",
    move: moveSidebarView,
  });
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
          onpointerdown={(e) => orderDrag.onPointerDown(index, e)}
          onkeydown={(e) => orderDrag.onKeyDown(index, e)}
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
