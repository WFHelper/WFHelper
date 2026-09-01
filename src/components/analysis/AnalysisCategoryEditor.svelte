<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedInput from "../ThemedInput.svelte";
  import { tr } from "../../lib/i18n.js";
  import { UNCATEGORIZED, type ItemCategoryEntry } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    items: ItemCategoryEntry[];
    knownCategories: string[];
    /** Turns a resolved bucket id into the label the panels show. */
    labelFor: (resolved: string) => string;
    onSet: (key: string, category: string) => void;
    onClear: (key: string) => void;
    onResetAll: () => void;
    onClose: () => void;
  }

  let { items, knownCategories, labelFor, onSet, onClear, onResetAll, onClose }: Props = $props();

  let search = $state("");

  const visible = $derived(
    items.filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 300),
  );

  // The datalist is a suggestion list, not a whitelist: a new name is allowed.
  function commit(key: string, raw: string): void {
    const value = raw.trim();
    if (value) onSet(key, value);
    else onClear(key);
  }
</script>

<ModalShell ariaLabel={$tr("analysis.editCategories")} {onClose}>
  <div
    class="relative z-10 flex max-h-[80vh] w-[min(48rem,92vw)] flex-col gap-3 overflow-hidden rounded-[var(--radius-xl)] border border-border-strong bg-bg-surface p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    data-analysis-category-editor
  >
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-2">
      <div class="flex flex-col gap-1">
        <span class="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {$tr("analysis.editCategories")}
        </span>
        <span class="text-xs text-text-muted">{$tr("analysis.categoryEditorHint")}</span>
      </div>
      <div class="flex items-center gap-2">
        <ThemedButton onClick={onResetAll}>{$tr("analysis.resetOverrides")}</ThemedButton>
        <ThemedButton onClick={onClose}>{$tr("common.close")}</ThemedButton>
      </div>
    </div>

    <ThemedInput
      bind:value={search}
      placeholder={$tr("common.searchPlaceholder")}
      className="shrink-0"
    />

    <datalist id="analysis-category-options">
      {#each knownCategories as category (category)}
        <option value={category}></option>
      {/each}
    </datalist>

    {#if visible.length === 0}
      <p class="m-0 py-6 text-center text-sm text-text-muted">{$tr("analysis.noCategories")}</p>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {#each visible as item (item.key)}
          <div
            class="grid grid-cols-[1fr_12rem_auto] items-center gap-2 rounded-[var(--radius-md)] px-1 py-1 hover:bg-bg-raised"
            data-analysis-category-row={item.key}
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate text-sm text-text-primary" title={item.name}>{item.name}</span>
              {#if item.secondary}
                <span class="truncate text-[0.65rem] text-text-muted">{item.secondary}</span>
              {/if}
            </span>
            <input
              list="analysis-category-options"
              value={item.resolved === UNCATEGORIZED ? "" : labelFor(item.resolved)}
              placeholder={$tr("analysis.uncategorized")}
              class="w-full rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)]
                     bg-[var(--ui-control-bg)] px-2 py-1 text-xs text-text-primary outline-none
                     placeholder:text-text-muted focus:border-accent-dim"
              onchange={(e) => commit(item.key, e.currentTarget.value)}
            />
            <ThemedButton
              size="compact"
              disabled={!item.overridden}
              onClick={() => onClear(item.key)}
              title={$tr("analysis.clearOverride")}
            >
              {$tr("common.reset")}
            </ThemedButton>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</ModalShell>
