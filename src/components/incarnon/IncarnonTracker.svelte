<script lang="ts">
  import { onMount } from "svelte";
  import ItemImage from "../ItemImage.svelte";
  import { tr, type MessageKey, type Translator } from "../../lib/i18n.js";
  import {
    INCARNON_FILTERS,
    INCARNON_MAX_EVOLUTION,
    buildIncarnonWeapons,
    filterIncarnon,
    incarnonUnlockedLabel,
    summarizeIncarnon,
    type IncarnonFilter,
    type IncarnonWeapon,
  } from "../../lib/incarnon.js";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { persistedString } from "../../lib/persistence.js";
  import { circuitChoices, circuitWeeksLabel } from "../../lib/world.js";
  import { mountWorldPolling } from "../../lib/world/useWorldView.js";
  import { componentOwnership, inventoryData, itemDb } from "../../stores/data.js";
  import { activeItem } from "../../stores/modals.js";
  import { worldData } from "../../stores/world.js";

  const FILTER_LABELS: Record<IncarnonFilter, MessageKey> = {
    all: "common.all",
    unlocked: "incarnon.filterUnlocked",
    adapter: "incarnon.filterAdapter",
    missing: "common.missing",
  };
  const EVOLUTION_PIPS = Array.from({ length: INCARNON_MAX_EVOLUTION }, (_, i) => i + 1);

  const filter = persistedString<IncarnonFilter>(
    "mastery-incarnon-filter",
    INCARNON_FILTERS,
    "all",
  );

  onMount(() => mountWorldPolling());

  const weapons = $derived(
    buildIncarnonWeapons($itemDb, $inventoryData, circuitChoices($worldData, "hard")),
  );
  const summary = $derived(summarizeIncarnon(weapons));
  const visible = $derived(filterIncarnon(weapons, $filter));
  const groups = $derived(
    [
      {
        kind: "genesis",
        title: $tr("incarnon.genesis"),
        items: visible.filter((w) => w.kind === "genesis"),
      },
      {
        kind: "native",
        title: $tr("incarnon.native"),
        items: visible.filter((w) => w.kind === "native"),
      },
    ].filter((group) => group.items.length > 0),
  );

  function openWeapon(weapon: IncarnonWeapon): void {
    const db = weapon.uniqueName ? $itemDb[weapon.uniqueName] : undefined;
    if (!db) return;
    activeItem.set(buildParsedItemFromDb(weapon.uniqueName, db, $componentOwnership));
  }

  function statusLine(weapon: IncarnonWeapon, t: Translator): string {
    if (weapon.status === "unlocked") {
      return weapon.kind === "genesis" || weapon.evolution
        ? incarnonUnlockedLabel(weapon, t)
        : t("common.owned");
    }
    if (weapon.status === "adapter") {
      return t("incarnon.spareAdapters", { count: weapon.adapterCount });
    }
    if (weapon.kind === "native") {
      return weapon.blueprintOwned ? t("incarnon.blueprintOwned") : t("mastery.notOwned");
    }
    return weapon.circuitWeeks !== undefined
      ? t("incarnon.nextCircuit", { when: circuitWeeksLabel(weapon.circuitWeeks, t) })
      : t("common.missing");
  }

  function dotClass(weapon: IncarnonWeapon): string {
    if (weapon.status === "unlocked") return "bg-success";
    if (weapon.status === "adapter") return "bg-info";
    return "bg-danger opacity-70";
  }
</script>

<div data-incarnon-tracker>
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div
      class="filter-tabs"
      role="group"
      aria-label={$tr("incarnon.filterLabel")}
      data-incarnon-filters
    >
      {#each INCARNON_FILTERS as key (key)}
        <button
          type="button"
          class="filter-tab"
          class:active={$filter === key}
          aria-pressed={$filter === key}
          data-incarnon-filter={key}
          onclick={() => filter.set(key)}>{$tr(FILTER_LABELS[key])}</button
        >
      {/each}
    </div>
    <span class="text-sm text-text-secondary" data-incarnon-summary
      >{$tr("incarnon.summary", { unlocked: summary.unlocked, total: summary.total })}</span
    >
  </div>

  {#if !$inventoryData}
    <p class="mb-3 text-sm text-text-muted">{$tr("app.noInventoryLoaded")}</p>
  {/if}

  {#each groups as group (group.kind)}
    <div class="mb-4" data-incarnon-group={group.kind}>
      <div
        class="mb-2 font-display text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
      >
        {group.title} ({group.items.length})
      </div>
      <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {#each group.items as weapon (weapon.name)}
          <div
            class="item-card group {weapon.status === 'unlocked'
              ? 'border-success/25'
              : weapon.status === 'adapter'
                ? 'border-info/30'
                : 'opacity-70'}"
            role="button"
            tabindex="0"
            aria-label={$tr("common.openDetailsFor", { name: itemLabel(weapon) })}
            data-incarnon-card={weapon.name}
            data-incarnon-status={weapon.status}
            onclick={() => openWeapon(weapon)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") openWeapon(weapon);
            }}
          >
            <div
              class="relative flex h-24 items-center justify-center border-b border-border bg-surface-card p-2"
            >
              <ItemImage
                src={weapon.imageUrl || null}
                alt={itemLabel(weapon)}
                auditKey={weapon.name}
                cls="max-h-20 max-w-full"
              />
              {#if weapon.adapterCount > 0}
                <span
                  class="absolute left-1.5 top-1.5 rounded-[var(--radius-sm)] border border-info/40 bg-bg-deep/80 px-1 font-display text-[11px] font-bold leading-4 text-info"
                  title={$tr("incarnon.spareAdapters", { count: weapon.adapterCount })}
                  data-incarnon-adapters={weapon.adapterCount}>x{weapon.adapterCount}</span
                >
              {/if}
              <span
                class="absolute bottom-1.5 right-1.5 h-1.5 w-1.5 rounded-full {dotClass(weapon)}"
              ></span>
            </div>
            <div class="item-body">
              <span class="item-name">{itemLabel(weapon)}</span>
              <span class="item-type" data-incarnon-line>{statusLine(weapon, $tr)}</span>
              {#if weapon.status === "adapter" && !weapon.weaponOwned}
                <span class="text-[11px] text-warning">{$tr("incarnon.weaponMissing")}</span>
              {/if}
              {#if weapon.evolution}
                <div
                  class="mt-1 flex gap-0.5"
                  title={$tr("incarnon.evolution", {
                    tier: weapon.evolution,
                    max: INCARNON_MAX_EVOLUTION,
                  })}
                  data-incarnon-evolution={weapon.evolution}
                >
                  {#each EVOLUTION_PIPS as pip (pip)}
                    <span
                      class="h-1 flex-1 rounded-full {pip <= (weapon.evolution ?? 0)
                        ? 'bg-success'
                        : 'bg-border'}"
                    ></span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <p class="text-sm text-text-muted">{$tr("world.noData")}</p>
  {/each}
</div>
