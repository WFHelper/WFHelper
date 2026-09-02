<script lang="ts">
  import type { ItemDbLookup, WfmItemsLookup } from "../../types/ipc.js";
  import { getLookupByName } from "../../lib/inventoryMarket.js";
  import { locale, tr } from "../../lib/i18n.js";

  // Baro inventory entry - typed loosely to match the world-state shape.
  type BaroEntry = {
    uniqueName?: string | undefined;
    item?: string | undefined;
    ducats?: number | undefined;
    credits?: number | undefined;
    imageOverride?: unknown;
  };

  export let entry: BaroEntry;
  export let itemDb: ItemDbLookup;
  export let wfmItems: WfmItemsLookup;
  export let owned: boolean;
  export let onOpen: (uniqueName: string) => void;

  $: dbEntry = itemDb[entry.uniqueName || ""];
  $: hasDb = !!dbEntry;
  $: isMod = dbEntry?.category === "Mod";
  $: wfmEntry = isMod ? getLookupByName(entry.item || "", wfmItems) : null;
  $: wfmIcon = wfmEntry?.icon || wfmEntry?.thumb || null;
  $: imgUrl =
    (isMod ? wfmIcon : null) ||
    dbEntry?.imageUrl ||
    (typeof entry.imageOverride === "string" ? entry.imageOverride : null);

  $: title = `${entry.item || $tr("common.unknown")}${
    entry.ducats ? ` · ${$tr("world.baro.ducatsShort", { count: entry.ducats })}` : ""
  }${
    entry.credits
      ? ` / ${$tr("world.baro.creditsShort", { amount: entry.credits.toLocaleString($locale) })}`
      : ""
  }`;

  // Variant classes - broken out for readability.
  $: shapeCls = isMod
    ? "h-[140px] w-[100px] rounded-[var(--radius-md)] border-0 bg-transparent"
    : "h-[120px] w-[120px] rounded-[var(--radius-lg)] border-2 bg-surface-card";
  $: borderCls = isMod
    ? owned
      ? "shadow-[0_0_8px_2px_var(--success-bg)]"
      : ""
    : owned
      ? "border-success-dim"
      : "border-border";
  $: interactCls = hasDb ? "cursor-pointer hover:scale-105 hover:z-[1]" : "";
  $: labelMaxW = isMod ? "max-w-[100px]" : "max-w-[120px]";
</script>

<button
  type="button"
  class="flex shrink-0 flex-col items-center gap-1 border-0 bg-transparent p-0 text-inherit
         transition-transform duration-100 disabled:cursor-default disabled:opacity-85 {interactCls}"
  disabled={!hasDb}
  on:click={() => hasDb && onOpen(entry.uniqueName || "")}
  {title}
>
  <div class="relative flex items-center justify-center overflow-hidden {shapeCls} {borderCls}">
    {#if imgUrl}
      <img
        class="h-full w-full object-contain"
        src={imgUrl}
        alt={entry.item || ""}
        loading="lazy"
      />
    {:else}
      <span class="text-3xl font-bold text-text-secondary opacity-40">
        {(entry.item || "?")[0]}
      </span>
    {/if}

    {#if entry.ducats}
      <span
        class="absolute top-[3px] left-[3px] rounded bg-bg-deep/80 px-[6px] py-[2px]
               text-lg font-bold leading-[1.2] text-accent pointer-events-none">{entry.ducats}</span
      >
    {/if}

    {#if owned}
      <span
        class="absolute bottom-[3px] right-[3px] flex h-6 w-6 items-center justify-center rounded-full
               bg-success-dim text-base font-bold leading-none text-text-primary pointer-events-none"
        >✓</span
      >
    {/if}
  </div>

  <span
    class="overflow-hidden text-ellipsis whitespace-nowrap text-center text-xs
           text-text-secondary {labelMaxW}">{entry.item || $tr("common.unknown")}</span
  >
</button>
