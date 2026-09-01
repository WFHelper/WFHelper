<script lang="ts">
  import ItemImage from "../../ItemImage.svelte";
  import RivenPolarityIcon from "../../RivenPolarityIcon.svelte";
  import { PLATINUM_ICON_URL, RIVEN_TEMPLATE_URL, STAT_ICON_URLS } from "../../../lib/assetUrls.js";
  import { tr } from "../../../lib/i18n.js";
  import { criteriaChips, statLabel } from "./alertResolve.js";
  import type {
    MarketAlertRule,
    RivenStatBound,
  } from "../../../../config/shared/marketAlertTypes.js";
  import type { RivenStatOption } from "../../../types/ipc.js";

  let {
    rule,
    thumb = null,
    targetName,
    statOptions = [],
    lastHitAt = null,
    testing = false,
    onToggle,
    onEdit,
    onDelete,
    onTest,
    onOpenBulkSell,
  }: {
    rule: MarketAlertRule;
    thumb?: string | null;
    targetName: string;
    statOptions?: RivenStatOption[];
    lastHitAt?: string | null;
    testing?: boolean;
    onToggle: (rule: MarketAlertRule) => void;
    onEdit: (rule: MarketAlertRule) => void;
    onDelete: (rule: MarketAlertRule) => void;
    onTest: (rule: MarketAlertRule) => void;
    /** Item rules only; riven and baro rules have nothing to sell. */
    onOpenBulkSell?: (rule: MarketAlertRule) => void;
  } = $props();

  const chipBase =
    "inline-flex items-center gap-1 rounded-full border px-1.5 py-[0.15rem] text-[0.66rem] font-semibold leading-none";
  const neutralChip = `${chipBase} border-border bg-bg-raised text-text-secondary`;
  const positiveChip = `${chipBase} border-success/40 bg-success/15 text-success`;
  const negativeChip = `${chipBase} border-danger/40 bg-danger/15 text-danger`;
  const excludedChip = `${chipBase} border-border text-text-muted line-through`;

  const chips = $derived(criteriaChips(rule));
  const positives = $derived(rule.riven?.requirePositive ?? []);
  const negatives = $derived(rule.riven?.requireNegative ?? []);
  const excluded = $derived(rule.riven?.excludeAttributes ?? []);
  const bounds = $derived(rule.riven?.statBounds ?? []);
  const kindLabel = $derived(
    rule.kind === "riven"
      ? $tr("rivens.type.riven")
      : rule.kind === "item"
        ? $tr("common.item")
        : $tr("marketAlerts.kindBaro"),
  );
  // The riven card template stands in for an unresolved weapon; item rules fall
  // through to the ItemImage placeholder instead.
  const imageSrc = $derived(thumb || (rule.kind === "riven" ? RIVEN_TEMPLATE_URL : null));

  function boundText(bound: RivenStatBound): string {
    if (bound.min !== undefined && bound.max !== undefined) return `${bound.min}-${bound.max}`;
    if (bound.max !== undefined) return `<=${bound.max}`;
    return `>=${bound.min}`;
  }
</script>

<article
  class="alert-card flex flex-col gap-2.5 rounded-xl border border-border bg-bg-surface p-3 transition-colors hover:border-border-strong"
  class:alert-card--off={!rule.enabled}
  data-alert-card
  data-alert-kind={rule.kind}
  data-alert-enabled={rule.enabled}
>
  <div class="flex items-start gap-2.5">
    <div
      class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] bg-[var(--ui-control-bg)] p-1"
    >
      <ItemImage
        src={imageSrc}
        alt={targetName}
        auditKey={targetName}
        cls="max-h-full max-w-full"
      />
    </div>

    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <span
          class="min-w-0 truncate font-display text-sm font-bold text-text-primary"
          title={rule.name}>{rule.name}</span
        >
        <span
          class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-[0.6rem] font-bold uppercase tracking-[0.05em] text-accent"
          >{kindLabel}</span
        >
      </div>
      <span class="truncate text-xs text-text-secondary" title={targetName}>{targetName}</span>
    </div>

    <label class="alert-switch shrink-0" title={$tr("marketAlerts.enabled")}>
      <input
        type="checkbox"
        class="peer sr-only"
        checked={rule.enabled}
        aria-label={$tr("marketAlerts.enabled")}
        data-alert-card-toggle
        onchange={() => onToggle(rule)}
      />
      <span
        class="block h-5 w-9 rounded-full border border-border bg-[var(--ui-control-bg)] transition-colors peer-checked:border-accent peer-checked:bg-accent/30 peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
      ></span>
      <span
        class="pointer-events-none absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-text-muted transition-transform peer-checked:translate-x-4 peer-checked:bg-accent"
      ></span>
    </label>
  </div>

  {#if chips.length > 0}
    <div class="flex flex-wrap gap-1" data-alert-criteria>
      {#each chips as chip (chip.id)}
        <span class={neutralChip} title={$tr(chip.titleKey)}>
          {#if chip.icon === "platinum"}
            <img src={PLATINUM_ICON_URL} alt="" width="11" height="11" />
          {:else if chip.icon === "endo"}
            <img src={STAT_ICON_URLS.endoDelta} alt="" width="11" height="11" />
          {:else if chip.polarity}
            <RivenPolarityIcon polarity={chip.polarity} size={12} />
          {/if}
          {#if chip.labelKey}<span class="opacity-70">{$tr(chip.labelKey)}</span>{/if}
          {#if chip.textKey}<span>{$tr(chip.textKey)}</span>{/if}
          {#if chip.text}<span>{chip.text}</span>{/if}
        </span>
      {/each}
    </div>
  {/if}

  {#if positives.length + negatives.length + excluded.length + bounds.length > 0}
    <div class="flex flex-wrap gap-1" data-alert-stats>
      {#each positives as stat (stat)}
        <span class={positiveChip} title={$tr("marketAlerts.requiredPositive")}
          >{statLabel(stat, statOptions)}</span
        >
      {/each}
      {#each negatives as stat (stat)}
        <span class={negativeChip} title={$tr("marketAlerts.requiredNegative")}
          >{statLabel(stat, statOptions)}</span
        >
      {/each}
      {#each bounds as bound (bound.attribute)}
        <span class={neutralChip} title={$tr("marketAlerts.statBounds")}>
          <span class="opacity-70">{statLabel(bound.attribute, statOptions)}</span>
          <span>{boundText(bound)}</span>
        </span>
      {/each}
      {#each excluded as stat (stat)}
        <span class={excludedChip} title={$tr("marketAlerts.excludedStats")}
          >{statLabel(stat, statOptions)}</span
        >
      {/each}
    </div>
  {/if}

  <div
    class="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle pt-2 text-[0.68rem] text-text-muted"
  >
    <span>{$tr("marketAlerts.cooldownShort", { minutes: rule.cooldownMinutes })}</span>
    {#if lastHitAt}
      <span>{$tr("marketAlerts.lastHitAt", { time: lastHitAt })}</span>
    {/if}
    {#if rule.kind === "baro"}
      <span class="text-warning">{$tr("marketAlerts.baroDeferred")}</span>
    {/if}
    <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      {#if rule.kind === "item" && onOpenBulkSell}
        <button
          class="btn-secondary btn-sm"
          data-alert-open-bulk-sell
          onclick={() => onOpenBulkSell(rule)}>{$tr("inventory.openBulkSell")}</button
        >
      {/if}
      <button
        class="btn-secondary btn-sm"
        disabled={testing || rule.kind === "baro"}
        onclick={() => onTest(rule)}>{$tr("marketAlerts.testFire")}</button
      >
      <button class="btn-secondary btn-sm" onclick={() => onEdit(rule)}>{$tr("market.edit")}</button
      >
      <button
        class="btn-danger btn-sm h-7 w-7 px-0 text-sm font-black"
        title={$tr("common.delete")}
        aria-label={$tr("common.delete")}
        onclick={() => onDelete(rule)}>X</button
      >
    </div>
  </div>
</article>

<style>
  /* Paint containment keeps a hover repaint inside one card of the grid. */
  .alert-card {
    contain: layout paint style;
  }
  .alert-card--off {
    opacity: 0.55;
  }
  .alert-card--off:hover {
    opacity: 0.8;
  }
  .alert-switch {
    position: relative;
    display: inline-flex;
    cursor: pointer;
    align-items: center;
  }
</style>
