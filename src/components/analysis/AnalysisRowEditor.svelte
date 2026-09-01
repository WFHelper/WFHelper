<script lang="ts">
  import { untrack } from "svelte";
  import ModalShell from "../ModalShell.svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedInput from "../ThemedInput.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";
  import { tr } from "../../lib/i18n.js";
  import type { LedgerEventPatch } from "../../../config/shared/tradeLedgerTypes.js";
  import type { TradeEvent, TradeType } from "../../types/ipc.js";

  interface Props {
    event: TradeEvent;
    saving: boolean;
    error: string | null;
    onSave: (patch: LedgerEventPatch) => void;
    onClose: () => void;
  }

  let { event, saving, error, onSave, onClose }: Props = $props();

  // The dialog is keyed on one row and closes on save, so the fields are seeded
  // once; untrack keeps that intentional read out of the reactive graph.
  let platValue = $state(untrack(() => String(event.platChange ?? 0)));
  let partnerValue = $state(untrack(() => event.partner ?? ""));
  let typeValue = $state<TradeType>(untrack(() => event.type));
  let creditsValue = $state<string | number>(
    untrack(() => (event.credits == null ? "" : String(event.credits))),
  );
  let taxValue = $state<string | number>(
    untrack(() => (event.tradeTax == null ? "" : String(event.tradeTax))),
  );

  // A number input hands back a number, and null once it is cleared, so every
  // field is read through text().
  function text(raw: string | number | null | undefined): string {
    return raw == null ? "" : String(raw).trim();
  }

  function numeric(raw: string | number | null | undefined): number | null {
    const trimmed = text(raw);
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  const platParsed = $derived(numeric(platValue));
  const creditsParsed = $derived(numeric(creditsValue));
  const taxParsed = $derived(numeric(taxValue));
  const platInvalid = $derived(platParsed == null || platParsed < 0);
  // Main refuses a negative credits or tax and drops the whole patch with it, so
  // both take the same floor as platinum instead of failing at the save.
  const creditsInvalid = $derived(
    text(creditsValue) !== "" && (creditsParsed == null || creditsParsed < 0),
  );
  const taxInvalid = $derived(text(taxValue) !== "" && (taxParsed == null || taxParsed < 0));
  const blocked = $derived(saving || platInvalid || creditsInvalid || taxInvalid);

  // Only changed fields go in the patch, so main never rewrites untouched values.
  function submit(): void {
    if (blocked) return;
    const patch: LedgerEventPatch = {};
    if (platParsed != null && platParsed !== event.platChange) patch.platChange = platParsed;
    if (partnerValue.trim() !== (event.partner ?? "")) patch.partner = partnerValue.trim();
    if (typeValue !== event.type) patch.type = typeValue;
    // A cleared field unsets the stored value; null is the wire form for that.
    if (text(creditsValue) === "") {
      if (event.credits != null) patch.credits = null;
    } else if (creditsParsed != null && creditsParsed !== event.credits) {
      patch.credits = creditsParsed;
    }
    if (text(taxValue) === "") {
      if (event.tradeTax != null) patch.tradeTax = null;
    } else if (taxParsed != null && taxParsed !== event.tradeTax) {
      patch.tradeTax = taxParsed;
    }
    onSave(patch);
  }
</script>

<ModalShell ariaLabel={$tr("analysis.editTitle")} {onClose}>
  <div
    class="relative z-10 flex w-[min(32rem,92vw)] flex-col gap-3 rounded-[var(--radius-xl)] border border-border-strong bg-bg-surface p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    data-analysis-row-editor={event.id}
  >
    <div class="flex flex-col gap-1">
      <span class="text-sm font-semibold uppercase tracking-wide text-text-muted">
        {$tr("analysis.editTitle")}
      </span>
      <span class="text-xs text-text-muted">{$tr("analysis.editHint")}</span>
    </div>

    <label class="flex flex-col gap-1 text-xs text-text-secondary">
      {$tr("common.platinum")}
      <ThemedInput type="number" min="0" bind:value={platValue} />
      {#if platInvalid}
        <span class="text-danger">{$tr("analysis.invalidNumber")}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1 text-xs text-text-secondary">
      {$tr("analysis.colPartner")}
      <ThemedInput bind:value={partnerValue} />
    </label>

    <label class="flex flex-col gap-1 text-xs text-text-secondary">
      {$tr("common.type")}
      <ThemedSelect bind:value={typeValue} className="h-8">
        <option value="sale">{$tr("stats.filterSale")}</option>
        <option value="purchase">{$tr("stats.filterPurchase")}</option>
        <option value="trade">{$tr("stats.filterTrade")}</option>
      </ThemedSelect>
    </label>

    <div class="grid grid-cols-2 gap-3">
      <label class="flex flex-col gap-1 text-xs text-text-secondary">
        {$tr("common.credits")}
        <ThemedInput type="number" min="0" bind:value={creditsValue} />
        {#if creditsInvalid}
          <span class="text-danger">{$tr("analysis.invalidNumber")}</span>
        {/if}
      </label>
      <label class="flex flex-col gap-1 text-xs text-text-secondary">
        {$tr("analysis.tradeTax")}
        <ThemedInput type="number" min="0" bind:value={taxValue} />
        {#if taxInvalid}
          <span class="text-danger">{$tr("analysis.invalidNumber")}</span>
        {/if}
      </label>
    </div>

    {#if error}
      <p class="m-0 text-xs text-danger" data-analysis-row-editor-error>{error}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <ThemedButton onClick={onClose}>{$tr("common.cancel")}</ThemedButton>
      <ThemedButton active disabled={blocked} onClick={submit}>
        {saving ? $tr("common.saving") : $tr("common.save")}
      </ThemedButton>
    </div>
  </div>
</ModalShell>
