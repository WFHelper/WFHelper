<script lang="ts">
  import type { ItemDbLookup, WfmItemsLookup } from "../../types/ipc.js";
  import { getLookupByName } from "../../lib/inventoryMarket.js";

  // Baro inventory entry — typed loosely to match the world-state shape.
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

  $: title = `${entry.item || "Unknown"}${entry.ducats ? ` — ${entry.ducats} duc` : ""}${
    entry.credits ? ` / ${entry.credits.toLocaleString()} cr` : ""
  }`;

  // Variant classes — broken out for readability.
  $: shapeCls = isMod
    ? "h-[140px] w-[100px] rounded-[0.3rem] border-0 bg-transparent"
    : "h-[120px] w-[120px] rounded-[0.35rem] border-2 bg-[rgba(0,0,0,0.3)]";
  $: borderCls = isMod
    ? owned
      ? "shadow-[0_0_8px_2px_rgba(34,139,34,0.5)]"
      : ""
    : owned
      ? "border-[rgba(34,139,34,0.7)]"
      : "border-border";
  $: interactCls = hasDb ? "cursor-pointer hover:scale-105 hover:z-[1]" : "";
  $: labelMaxW = isMod ? "max-w-[100px]" : "max-w-[120px]";
</script>

<button
  type="button"
  class="flex shrink-0 flex-col items-center gap-[0.2rem] border-0 bg-transparent p-0 text-inherit
         transition-transform duration-100 disabled:cursor-default disabled:opacity-85 {interactCls}"
  disabled={!hasDb}
  on:click={() => hasDb && onOpen(entry.uniqueName || "")}
  {title}
>
  <div
    class="relative flex items-center justify-center overflow-hidden {shapeCls} {borderCls}"
  >
    {#if imgUrl}
      <img class="h-full w-full object-contain" src={imgUrl} alt={entry.item || ""} loading="lazy" />
    {:else}
      <span class="text-[1.8rem] font-bold text-text-secondary opacity-40">
        {(entry.item || "?")[0]}
      </span>
    {/if}

    {#if entry.ducats}
      <span
        class="absolute top-[3px] left-[3px] rounded bg-[rgba(0,0,0,0.78)] px-[6px] py-[2px]
               text-[1.1rem] font-bold leading-[1.2] text-accent pointer-events-none"
      >{entry.ducats}</span>
    {/if}

    {#if owned}
      <span
        class="absolute bottom-[3px] right-[3px] flex h-6 w-6 items-center justify-center rounded-full
               bg-[rgba(34,139,34,0.85)] text-[1rem] font-bold leading-none text-white pointer-events-none"
      >✓</span>
    {/if}
  </div>

  <span
    class="overflow-hidden text-ellipsis whitespace-nowrap text-center text-[0.65rem]
           text-text-secondary {labelMaxW}"
  >{entry.item || "Unknown"}</span>
</button>
