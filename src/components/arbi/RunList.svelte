<script
  lang="ts"
  generics="TRun extends { id: string; startedAt: number; logFile: string | null; logSizeBytes: number }"
>
  import type { Snippet } from "svelte";

  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../../lib/i18n.js";
  import { confirmWithDialog } from "../../lib/ipc.js";
  import { formatBytes, formatRunDate } from "../../lib/arbi/arbiChartData.js";

  interface Props {
    runs: TRun[];
    onSelect: (id: string) => void;
    /** The feature's own columns, between the date and the log size. */
    headers: Snippet;
    cells: Snippet<[TRun]>;
    deleteRun: (id: string) => Promise<void>;
    deleteRunLog: (id: string) => Promise<void>;
    /** Hooks the e2e specs locate the table and its rows by. */
    listAttrs?: Record<string, string>;
    rowAttrs?: (run: TRun) => Record<string, string>;
    /** Selection column; null for a list without bulk actions. */
    selected?: Set<string> | null;
    onToggleSelect?: (id: string) => void;
    onToggleSelectAll?: () => void;
  }

  const {
    runs,
    onSelect,
    headers,
    cells,
    deleteRun,
    deleteRunLog,
    listAttrs = {},
    rowAttrs = () => ({}),
    selected = null,
    onToggleSelect = () => {},
    onToggleSelectAll = () => {},
  }: Props = $props();

  const allSelected = $derived(
    !!selected && runs.length > 0 && runs.every((run) => selected.has(run.id)),
  );

  async function onDeleteRun(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    if (!(await confirmWithDialog($t("arbi.confirmDeleteRun"), $t))) return;
    await deleteRun(id);
  }

  async function onDeleteLog(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    await deleteRunLog(id);
  }
</script>

<div class="overflow-x-auto" {...listAttrs}>
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
        {#if selected}
          <th class="w-8 px-3 py-2">
            <input
              type="checkbox"
              class="block h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
              checked={allSelected}
              title={$t("common.selectAll")}
              aria-label={$t("common.selectAll")}
              onchange={onToggleSelectAll}
            />
          </th>
        {/if}
        <th class="px-3 py-2 font-semibold">{$t("arbi.col.date")}</th>
        {@render headers()}
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.log")}</th>
        <th class="px-3 py-2"></th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr
          class="cursor-pointer border-b border-border/50 transition-colors duration-100 hover:bg-bg-raised"
          onclick={() => onSelect(run.id)}
          {...rowAttrs(run)}
        >
          {#if selected}
            <td class="px-3 py-2">
              <input
                type="checkbox"
                class="block h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                checked={selected.has(run.id)}
                aria-label={$t("arbi.selectRun")}
                onclick={(e) => e.stopPropagation()}
                onchange={() => onToggleSelect(run.id)}
              />
            </td>
          {/if}
          <td class="whitespace-nowrap px-3 py-2 text-text-secondary"
            >{formatRunDate(run.startedAt)}</td
          >
          {@render cells(run)}
          <td class="whitespace-nowrap px-3 py-2 text-right text-text-muted">
            {run.logFile ? formatBytes(run.logSizeBytes) : "–"}
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right">
            {#if run.logFile}
              <button
                class="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-warning/60 transition-colors duration-100 hover:border-warning/40 hover:bg-warning/10 hover:text-warning"
                title={$t("arbi.deleteLog")}
                onclick={(e) => onDeleteLog(e, run.id)}
              >
                <svg
                  class="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="m9.5 12.5 5 5" />
                  <path d="m14.5 12.5-5 5" />
                </svg>
              </button>
            {/if}
            <button
              class="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-danger/60 transition-colors duration-100 hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
              title={$t("arbi.deleteRun")}
              onclick={(e) => onDeleteRun(e, run.id)}
            >
              <svg
                class="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
