<script lang="ts">
  import type { MessageKey, Translator } from "../../lib/i18n.js";
  import {
    effectivePrice,
    rowNeedsOverride,
    rowWarnings,
    type WorkbenchQueueRow,
  } from "../../lib/tradeWorkbench/queueModel.js";

  interface Props {
    row: WorkbenchQueueRow;
    /** Set-keep only applies to assembled-set rows. */
    canSetKeep: boolean;
    isLocked: boolean;
    isSetKept: boolean;
    spareOverride: number | null;
    t: Translator;
    onToggleSelect: (row: WorkbenchQueueRow) => void;
    onQuantity: (row: WorkbenchQueueRow, quantity: number) => void;
    onManualPrice: (row: WorkbenchQueueRow, price: number | null) => void;
    onOverride: (row: WorkbenchQueueRow) => void;
    onToggleLock: (row: WorkbenchQueueRow) => void;
    onToggleSetKeep: (row: WorkbenchQueueRow) => void;
    onSpare: (row: WorkbenchQueueRow, spare: number | null) => void;
  }

  const {
    row,
    canSetKeep,
    isLocked,
    isSetKept,
    spareOverride,
    t,
    onToggleSelect,
    onQuantity,
    onManualPrice,
    onOverride,
    onToggleLock,
    onToggleSetKeep,
    onSpare,
  }: Props = $props();

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;

  const warnings = $derived(rowWarnings(row));
  const needsOverride = $derived(rowNeedsOverride(row));
  const price = $derived(effectivePrice(row));

  const reservationTitle = $derived(
    row.verdict.reservations
      .map((reservation) => {
        const count = reservation.params?.count;
        const label = t(k(reservation.reasonKey), count != null ? { count } : {});
        return `${label} (${reservation.quantity})${reservation.binding ? " *" : ""}`;
      })
      .join("\n"),
  );

  function numberInput(event: Event): number | null {
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
</script>

<div
  class="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center gap-2 border-b border-white/10 py-1 text-sm"
>
  <input
    type="checkbox"
    checked={row.selected}
    data-workbench-select
    onchange={() => onToggleSelect(row)}
  />

  <div class="min-w-0">
    <span class="truncate font-medium">{row.item.displayName ?? row.itemName}</span>
    {#if row.rank != null}
      <span class="ml-1 opacity-70">R{row.rank}</span>
    {/if}
    {#if row.existingOrder}
      <span class="ml-2 text-xs opacity-70">
        {t(k("workbench.row.listed"), { price: row.existingOrder.platinum })}
      </span>
    {/if}
    {#if warnings.length > 0}
      <div class="text-xs text-amber-400">
        {warnings.map((warning) => t(k(`workbench.warning.${warning}`))).join(" · ")}
      </div>
    {/if}
  </div>

  <div class="text-right" title={reservationTitle}>
    <span>{row.verdict.safe}</span><span class="opacity-60">/{row.verdict.total}</span>
    {#if row.verdict.reserved > 0}
      <span
        class="ml-1 rounded bg-amber-500/20 px-1 text-xs text-amber-300"
        title={reservationTitle}
      >
        {t(k("workbench.row.reserved"), { count: row.verdict.reserved })}
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-1">
    <input
      class="w-14 rounded bg-black/20 px-1 text-right"
      type="number"
      min="0"
      max={row.verdict.total}
      value={row.quantity}
      data-workbench-qty
      onchange={(event) => onQuantity(row, numberInput(event) ?? 0)}
    />
    {#if needsOverride}
      <label class="flex items-center gap-1 text-xs text-red-400" title={reservationTitle}>
        <input
          type="checkbox"
          checked={row.overrideAcknowledged}
          onchange={() => onOverride(row)}
        />
        {t(k("workbench.row.override"))}
      </label>
    {/if}
  </div>

  <div class="text-right text-xs opacity-80">
    {#if row.market}
      <div>{t(k("workbench.row.lowest"), { price: row.market.lowestSell ?? 0 })}</div>
      <div>
        {t(k("workbench.row.liquidity"), { count: row.market.activeSellers })}
        {#if row.market.spread != null}
          · {t(k("workbench.row.spread"), { spread: row.market.spread })}
        {/if}
      </div>
    {:else}
      <span class="opacity-50">{t(k("workbench.row.noMarketData"))}</span>
    {/if}
  </div>

  <div class="flex items-center gap-1">
    {#if row.suggestion?.price != null}
      <span class="text-xs opacity-70" title={JSON.stringify(row.suggestion.inputs)}>
        {row.suggestion.price}p ({Math.round(row.suggestion.confidence * 100)}%)
        {#if row.suggestion.damping}
          <span class="text-amber-400"
            >{t(k(`workbench.damping.${row.suggestion.damping.reason}`))}</span
          >
        {/if}
      </span>
    {/if}
    <input
      class="w-16 rounded bg-black/20 px-1 text-right"
      type="number"
      min="1"
      placeholder={row.suggestion?.price != null ? String(row.suggestion.price) : ""}
      value={row.manualPrice ?? ""}
      data-workbench-price
      onchange={(event) => onManualPrice(row, numberInput(event))}
    />
    <span class="text-xs opacity-60">{price != null ? `${price}p` : "-"}</span>
  </div>

  <div class="flex items-center gap-1 text-xs">
    <button
      type="button"
      class="rounded px-1 {isLocked ? 'bg-red-500/30' : 'bg-white/10'}"
      title={t(k("workbench.safety.lockHint"))}
      onclick={() => onToggleLock(row)}
    >
      {t(k(isLocked ? "workbench.safety.locked" : "workbench.safety.lock"))}
    </button>
    <input
      class="w-12 rounded bg-black/20 px-1 text-right"
      type="number"
      min="0"
      placeholder={t(k("workbench.safety.sparePlaceholder"))}
      title={t(k("workbench.safety.spareHint"))}
      value={spareOverride ?? ""}
      onchange={(event) => onSpare(row, numberInput(event))}
    />
    {#if canSetKeep}
      <button
        type="button"
        class="rounded px-1 {isSetKept ? 'bg-amber-500/30' : 'bg-white/10'}"
        title={t(k("workbench.safety.setKeepHint"))}
        onclick={() => onToggleSetKeep(row)}
      >
        {t(k("workbench.safety.setKeep"))}
      </button>
    {/if}
  </div>
</div>
