<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import type {
    LedgerImportPreview,
    LedgerImportRowPreview,
  } from "../../../config/shared/tradeLedgerTypes.js";

  interface Props {
    preview: LedgerImportPreview;
    applying: boolean;
    error: string | null;
    onApply: () => void;
    onClose: () => void;
  }

  let { preview, applying, error, onApply, onClose }: Props = $props();

  const COUNT_KEYS: Array<{ key: keyof LedgerImportPreview["counts"]; labelKey: MessageKey }> = [
    { key: "parsed", labelKey: "analysis.importParsed" },
    { key: "duplicates", labelKey: "analysis.importDuplicates" },
    { key: "unresolved", labelKey: "analysis.importUnresolved" },
    { key: "rejected", labelKey: "analysis.importRejected" },
  ];

  function kindKey(kind: LedgerImportRowPreview["kind"]): MessageKey {
    if (kind === "duplicate") return "analysis.rowKind.duplicate";
    if (kind === "unresolved") return "analysis.rowKind.unresolved";
    if (kind === "rejected") return "analysis.rowKind.rejected";
    return "analysis.rowKind.parsed";
  }

  function kindTone(kind: LedgerImportRowPreview["kind"]): string {
    if (kind === "parsed") return "text-success";
    if (kind === "rejected") return "text-danger";
    return "text-warning";
  }

  // Apply writes every staged row, unresolved ones included: the trade happened,
  // only its item name is outside the catalog, so dropping it would lose data.
  const applicable = $derived(preview.counts.parsed + preview.counts.unresolved);
  const nothingToImport = $derived(applicable <= 0);
</script>

<ModalShell ariaLabel={$tr("analysis.importTitle")} {onClose}>
  <div
    class="relative z-10 flex max-h-[80vh] w-[min(44rem,92vw)] flex-col gap-3 overflow-hidden rounded-[var(--radius-xl)] border border-border-strong bg-bg-surface p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    data-analysis-import-dialog
  >
    <div class="flex flex-col gap-1">
      <span class="text-sm font-semibold uppercase tracking-wide text-text-muted">
        {$tr("analysis.importTitle")}
      </span>
      <span class="truncate text-xs text-text-muted" title={preview.fileName}>
        {$tr("analysis.importPreviewFor", { file: preview.fileName })}
      </span>
    </div>

    <div class="flex flex-wrap gap-4" data-analysis-import-counts>
      {#each COUNT_KEYS as entry (entry.key)}
        <div class="flex flex-col gap-0.5">
          <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr(entry.labelKey)}
          </span>
          <span class="font-display text-xl font-bold leading-none text-text-primary">
            {preview.counts[entry.key]}
          </span>
        </div>
      {/each}
    </div>

    {#if preview.rows.length > 0}
      <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
        {$tr("analysis.importSample")}
      </span>
      <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {#each preview.rows as row, index (`${row.date}-${index}`)}
          <div class="flex flex-col gap-0.5 border-t border-[color:var(--ui-panel-border)] py-1">
            <div class="flex items-baseline gap-2 text-xs">
              <span class="shrink-0 tabular-nums text-text-muted">{row.date}</span>
              <span class="shrink-0 font-semibold {kindTone(row.kind)}"
                >{$tr(kindKey(row.kind))}</span
              >
              <span class="min-w-0 truncate text-text-primary" title={row.summary}>
                {row.summary}
              </span>
            </div>
            {#if row.reason}
              <span class="text-[0.65rem] text-text-muted">{row.reason}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if error}
      <p class="m-0 text-xs text-danger" data-analysis-import-error>{error}</p>
    {/if}

    <div class="flex items-center justify-end gap-2">
      {#if nothingToImport}
        <span class="mr-auto text-xs text-text-muted">{$tr("analysis.importNothing")}</span>
      {/if}
      <ThemedButton onClick={onClose}>{$tr("common.cancel")}</ThemedButton>
      <span data-analysis-import-apply>
        <ThemedButton active disabled={applying || nothingToImport} onClick={onApply}>
          {applying ? $tr("common.saving") : $tr("analysis.importApply", { count: applicable })}
        </ThemedButton>
      </span>
    </div>
  </div>
</ModalShell>
