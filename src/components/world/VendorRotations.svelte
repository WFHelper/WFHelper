<script lang="ts">
  import { onMount } from "svelte";

  import { timeTo } from "../../lib/format.js";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { log } from "../../lib/log.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { relicGroupForUniqueName } from "../../lib/relic.js";
  import { clockStore } from "../../lib/timers.js";
  import { circuitChoiceKey, resolveCircuitChoices } from "../../lib/world.js";
  import {
    bonusTier,
    codaItemsForBatch,
    loadAdversaryVendors,
    vendorBonusLookup,
    type AdversaryVendorItem,
    type AdversaryVendorsDoc,
  } from "../../lib/world/adversaryVendors.js";
  import { codaBatch, TENET_MELEE_STOCK, tenetRotatesAt } from "../../lib/world/dailiesLive.js";
  import { componentOwnership, inventoryData, itemDb } from "../../stores/data.js";
  import { activeItem, activeRelic } from "../../stores/modals.js";
  import { relicDb } from "../../stores/relics.js";
  import IconButtonCard from "./IconButtonCard.svelte";

  type VendorKind = "coda" | "tenet";

  interface Props {
    /** Blocks to render, in order. */
    vendors: readonly VendorKind[];
    /** "section" adds the vendor heading; "row" keeps the Dailies row indent. */
    variant?: "row" | "section";
  }

  const { vendors, variant = "row" }: Props = $props();

  const TITLE_KEYS: Record<VendorKind, MessageKey> = {
    coda: "dailies.task.codaWeapons",
    tenet: "dailies.task.tenetMelee",
  };
  const batchKey: MessageKey = "dailies.codaBatch";
  const rotatesInKey: MessageKey = "dailies.vendorRotatesIn";
  const bonusWikiKey: MessageKey = "dailies.vendorBonusWiki";

  const clock = clockStore(1000);
  let doc = $state<AdversaryVendorsDoc | null>(null);

  // Player-reported wiki figures the backend mirrors; absent, the strips render
  // weapons with no bonus column. The loader dedupes, so both call sites may ask.
  onMount(() => {
    let cancelled = false;
    void loadAdversaryVendors()
      .then((loaded) => {
        if (!cancelled) doc = loaded;
      })
      .catch((e: unknown) => {
        log.warn("[Vendors] adversary vendor load failed:", e);
      });
    return () => {
      cancelled = true;
    };
  });

  const nowMs = $derived($clock);
  // codaBatch hands back the same weapon array on every tick, so the resolved
  // strip below only recomputes when the batch actually flips.
  const coda = $derived(codaBatch(nowMs));
  const codaWeapons = $derived(coda.weapons);
  const codaLetter = $derived(coda.batch);
  const codaRotatesAt = $derived(coda.rotatesAt);
  const tenetRotatesAtMs = $derived(tenetRotatesAt(nowMs));

  const codaStock = $derived(resolveCircuitChoices(codaWeapons, $itemDb, $inventoryData));
  const tenetStock = $derived(resolveCircuitChoices(TENET_MELEE_STOCK, $itemDb, $inventoryData));

  const bonuses = $derived.by(() => {
    const loaded = doc;
    if (!loaded) return new Map<string, AdversaryVendorItem>();
    return vendorBonusLookup([...codaItemsForBatch(loaded, codaLetter), ...loaded.tenet]);
  });

  function openItem(uniqueName: string): void {
    const relicGroup = relicGroupForUniqueName($relicDb, uniqueName);
    if (relicGroup) {
      activeRelic.set(relicGroup);
      return;
    }
    const entry = $itemDb[uniqueName];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
  }
</script>

{#each vendors as kind (kind)}
  {@const names = kind === "coda" ? codaWeapons : TENET_MELEE_STOCK}
  {@const items = kind === "coda" ? codaStock : tenetStock}
  {@const rotatesMs = kind === "coda" ? codaRotatesAt : tenetRotatesAtMs}
  {@const rotatesIso = new Date(rotatesMs).toISOString()}
  <div class="vendor-block" class:vendor-block--section={variant === "section"}>
    {#if variant === "section"}
      <p
        class="m-0 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
      >
        {$tr(TITLE_KEYS[kind])}
        {#if kind === "coda"}
          <span
            class="rounded border border-accent/30 bg-accent/10 px-1 py-px text-[0.65rem] font-semibold normal-case tracking-normal text-accent"
            >{$tr(batchKey, { batch: codaLetter })}</span
          >
        {/if}
      </p>
    {/if}
    <div class="vendor-strip">
      {#each items as choice, index (circuitChoiceKey(choice))}
        {@const weapon = names[index] ?? ""}
        {@const bonus = weapon ? bonuses.get(weapon.toLowerCase()) : undefined}
        <div class="vendor-item" data-vendor-weapon={weapon || null}>
          <IconButtonCard
            name={choice.displayName ?? choice.name}
            imageUrl={choice.imageUrl}
            owned={choice.owned}
            subsumed={choice.subsumed}
            size={80}
            borderWidth="1.5"
            onClick={() => openItem(choice.uniqueName)}
          />
          {#if bonus}
            {@const tier = bonusTier(bonus.bonus)}
            <span
              class="vendor-bonus"
              class:vendor-bonus--mid={tier === "mid"}
              class:vendor-bonus--high={tier === "high"}
              data-vendor-bonus={bonus.bonus}>{bonus.element} · {bonus.bonus}%</span
            >
          {/if}
        </div>
      {/each}
    </div>
    <p class="vendor-note" data-vendor-rotates={rotatesIso}>
      {$tr(rotatesInKey, { time: timeTo(new Date(rotatesMs), nowMs) })} · {$tr(bonusWikiKey)}
    </p>
  </div>
{/each}

<style>
  /* Default padding is the Dailies row indent, so the strip keeps sitting under
     the checkbox column it expands from. */
  .vendor-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    padding: 0.25rem 0.75rem 0.6rem 2.05rem;
  }

  .vendor-item {
    align-items: center;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 0.1rem;
  }

  .vendor-bonus {
    color: var(--text-secondary);
    font-size: 0.64rem;
    line-height: 1.2;
    max-width: 5rem;
    text-align: center;
  }

  .vendor-bonus--mid {
    color: var(--accent);
  }

  .vendor-bonus--high {
    color: var(--success);
  }

  .vendor-note {
    color: var(--text-secondary);
    font-size: 0.66rem;
    margin: 0;
    opacity: 0.8;
    padding: 0 0.75rem 0.55rem 2.05rem;
  }

  .vendor-block--section .vendor-strip {
    padding: 0.3rem 0 0.4rem;
  }

  .vendor-block--section .vendor-note {
    padding: 0 0 0.45rem;
  }

  .vendor-block--section + .vendor-block--section {
    border-top: 1px dashed var(--surface-hover);
    padding-top: 0.5rem;
  }
</style>
