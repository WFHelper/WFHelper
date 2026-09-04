<script lang="ts">
  import { confirmWithDialog } from "../../lib/ipc.js";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { selectionOwnership } from "../../lib/inventory/selectionAlerts.js";
  import { parsedItems } from "../../stores/data.js";
  import { addToast } from "../../stores/toasts.js";
  import { setSelectionAlert, type SavedSelection } from "../../stores/inventorySelection.js";

  interface Props {
    count: number;
    /** How many of the selected rows the current tab and filters show. */
    onTabCount: number;
    /** Selectable rows the current filters show; drives the "Select all" label. */
    eligibleCount: number;
    saved: readonly SavedSelection[];
    onSelectAll: () => void;
    onClear: () => void;
    onSave: (name: string) => void;
    onLoad: (name: string) => void;
    onDelete: (name: string) => void;
    onBulkSell: () => void;
  }

  const {
    count,
    onTabCount,
    eligibleCount,
    saved,
    onSelectAll,
    onClear,
    onSave,
    onLoad,
    onDelete,
    onBulkSell,
  }: Props = $props();

  const t = $derived($tr);

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;

  let draftName = $state("");
  let pickedName = $state("");

  const picked = $derived(saved.find((entry) => entry.name === pickedName) ?? null);
  const ownership = $derived(picked ? selectionOwnership(picked, $parsedItems) : null);

  const FIELD_CLASS =
    "rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] " +
    "bg-[var(--ui-control-bg)] px-2 py-1 text-xs text-text-primary outline-none " +
    "focus:border-accent-dim";

  function save(): void {
    const name = draftName.trim();
    if (!name) return;
    onSave(name);
    draftName = "";
    addToast({ level: "success", message: t(k("inventory.selectionSaved"), { name }) });
  }

  function load(): void {
    if (pickedName) onLoad(pickedName);
  }

  /** Deleting a saved set is not undoable, so it asks first. */
  async function remove(): Promise<void> {
    const name = pickedName;
    if (!name) return;
    if (!(await confirmWithDialog(t(k("inventory.deleteSelectionConfirm"), { name }), t))) return;
    onDelete(name);
    if (pickedName === name) pickedName = "";
  }
</script>

<div
  class="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-accent-dim/50 bg-accent/10 px-3 py-2"
  data-inventory-select-bar
>
  <span class="font-display text-sm font-semibold text-text-primary" data-inventory-select-count>
    {t("common.selected", { count })}
  </span>
  {#if count > onTabCount}
    <!-- The selection is global; without this a full bar over a tab that shows
         none of the picked rows reads as if the picks were lost. -->
    <span class="text-xs text-text-muted" data-inventory-select-on-tab>
      {t("market.selectedHidden", { count: count - onTabCount })}
    </span>
  {/if}

  <button
    type="button"
    class="btn-secondary btn-sm"
    disabled={eligibleCount === 0}
    data-inventory-select-all
    onclick={onSelectAll}
  >
    {t(k("inventory.selectAllFiltered"), { count: eligibleCount })}
  </button>
  <button
    type="button"
    class="btn-secondary btn-sm"
    disabled={count === 0}
    data-inventory-select-clear
    onclick={onClear}
  >
    {t(k("inventory.clearSelection"))}
  </button>

  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>

  <input
    class="{FIELD_CLASS} w-40"
    placeholder={t(k("inventory.saveSelectionPlaceholder"))}
    aria-label={t(k("inventory.saveSelectionPlaceholder"))}
    data-inventory-selection-name
    bind:value={draftName}
  />
  <button
    type="button"
    class="btn-secondary btn-sm"
    disabled={draftName.trim().length === 0 || count === 0}
    data-inventory-selection-save
    onclick={save}
  >
    {t("common.save")}
  </button>

  {#if saved.length > 0}
    <select
      class="{FIELD_CLASS} w-44"
      aria-label={t(k("inventory.savedSelections"))}
      data-inventory-selection-saved
      bind:value={pickedName}
    >
      <option value="">{t(k("inventory.savedSelections"))}</option>
      {#each saved as entry (entry.name)}
        <option value={entry.name}>{entry.name} ({entry.keys.length})</option>
      {/each}
    </select>
    <button
      type="button"
      class="btn-secondary btn-sm"
      disabled={!pickedName}
      data-inventory-selection-load
      onclick={load}
    >
      {t(k("inventory.loadSelection"))}
    </button>
    <button
      type="button"
      class="btn-secondary btn-sm"
      disabled={!pickedName}
      data-inventory-selection-delete
      onclick={() => void remove()}
    >
      {t("common.delete")}
    </button>
    {#if picked && ownership}
      <label class="flex items-center gap-1.5 text-xs text-text-muted">
        <input
          type="checkbox"
          class="themed-checkbox"
          checked={picked.alertWhenComplete === true}
          data-selection-alert-toggle
          onchange={(event) => setSelectionAlert(picked.name, event.currentTarget.checked)}
        />
        {t(k("inventory.selectionAlert"))}
      </label>
      <span class="text-xs text-text-muted" data-selection-owned-count>
        {t(k("inventory.selectionOwned"), { owned: ownership.owned, total: ownership.total })}
      </span>
    {/if}
  {/if}

  <button
    type="button"
    class="btn-primary btn-sm ml-auto"
    disabled={count === 0}
    data-bulk-sell-open
    onclick={onBulkSell}
  >
    {t(k("inventory.bulkSell"), { count })}
  </button>
</div>
