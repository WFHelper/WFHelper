<script lang="ts">
  import { invoke } from "../../../lib/ipc.js";
  import { tr, type MessageKey } from "../../../lib/i18n.js";
  import { parsedItems, wfmItems } from "../../../stores/data.js";
  import { savedSelections } from "../../../stores/inventorySelection.js";
  import { ownedCountForAlertItem } from "../../../lib/marketAlerts/ownedCount.js";
  import { getAlertSellLink, setAlertSellLink } from "./alertBulkSell.js";
  import { statLabel } from "./alertResolve.js";
  import ThemedInput from "../../ThemedInput.svelte";
  import { titleFromSlug } from "../../../../config/shared/wfm.js";
  import {
    MARKET_ALERT_DEFAULT_COOLDOWN_MINUTES,
    MARKET_ALERT_MAX_ATTRIBUTES,
    MARKET_ALERT_MAX_COOLDOWN_MINUTES,
    MARKET_ALERT_MAX_NAME_CHARS,
    MARKET_ALERT_MAX_STAT_BOUNDS,
    MARKET_ALERT_MIN_COOLDOWN_MINUTES,
    MARKET_ALERT_SELLER_STATUSES,
    MARKET_ORDER_SIDES,
    RIVEN_POLARITIES,
  } from "../../../../config/shared/marketAlertTypes.js";
  import type {
    ItemAlertMatch,
    MarketAlertBinding,
    MarketAlertRule,
    MarketAlertRuleInput,
    MarketAlertSavePayload,
    MarketAlertSellerStatus,
    RivenAlertMatch,
    RivenPolarity,
    RivenStatBound,
  } from "../../../../config/shared/marketAlertTypes.js";
  import type { RivenStatOption } from "../../../types/ipc.js";
  import type { WfmSearchItem } from "../../../types/market.js";

  let {
    rule = null,
    binding = null,
    statOptions = [],
    onClose,
  }: {
    rule?: MarketAlertRule | null;
    binding?: MarketAlertBinding | null;
    statOptions?: RivenStatOption[];
    onClose: (saved: boolean) => void;
  } = $props();

  // The editor seeds from its props exactly once; the parent remounts it per
  // rule, so the initial value is the only one that can ever arrive.
  // svelte-ignore state_referenced_locally
  const initialRule = rule;
  // svelte-ignore state_referenced_locally
  const initialBinding = binding;
  const riven: RivenAlertMatch | null = initialRule?.riven ?? null;
  const item: ItemAlertMatch | null = initialRule?.item ?? null;

  let kind = $state<"riven" | "item">(initialRule?.kind === "item" ? "item" : "riven");
  let name = $state(initialRule?.name ?? "");
  let cooldownMinutes = $state(
    initialRule?.cooldownMinutes ?? MARKET_ALERT_DEFAULT_COOLDOWN_MINUTES,
  );
  let native = $state(initialBinding?.native !== false);
  let enabled = $state(initialRule?.enabled !== false);
  let error = $state("");
  let saving = $state(false);

  // Riven form state; number fields stay strings so "" cleanly means "unset".
  const existingWeaponSlug = riven?.weaponUrlName ?? "";
  let weaponInput = $state(existingWeaponSlug ? titleFromSlug(existingWeaponSlug) : "");
  let weaponDirty = $state(false);
  let requirePositive = $state<string[]>([...(riven?.requirePositive ?? [])]);
  let requireNegative = $state<string[]>([...(riven?.requireNegative ?? [])]);
  let excludeAttributes = $state<string[]>([...(riven?.excludeAttributes ?? [])]);
  let statBounds = $state<Array<{ attribute: string; min: string; max: string }>>(
    (riven?.statBounds ?? []).map((b) => ({
      attribute: b.attribute,
      min: b.min !== undefined ? String(b.min) : "",
      max: b.max !== undefined ? String(b.max) : "",
    })),
  );
  let curseMode = $state<"any" | "required" | "forbidden">(
    riven?.hasNegative === true ? "required" : riven?.hasNegative === false ? "forbidden" : "any",
  );
  let similarityPct = $state(
    riven?.minSimilarityPct !== undefined ? String(riven.minSimilarityPct) : "",
  );
  let minMastery = $state(riven?.minMasteryRank !== undefined ? String(riven.minMasteryRank) : "");
  let maxMastery = $state(riven?.maxMasteryRank !== undefined ? String(riven.maxMasteryRank) : "");
  let polarity = $state<string>(riven?.polarity ?? "");
  let minModRank = $state(riven?.minModRank !== undefined ? String(riven.minModRank) : "");
  let maxModRank = $state(riven?.maxModRank !== undefined ? String(riven.maxModRank) : "");
  let minPlat = $state(
    riven?.minPlatinum !== undefined
      ? String(riven.minPlatinum)
      : item?.minPlatinum !== undefined
        ? String(item.minPlatinum)
        : "",
  );
  let maxPlat = $state(
    riven?.maxPlatinum !== undefined
      ? String(riven.maxPlatinum)
      : item?.maxPlatinum !== undefined
        ? String(item.maxPlatinum)
        : "",
  );
  let minRerolls = $state(riven?.minRerolls !== undefined ? String(riven.minRerolls) : "");
  let maxRerolls = $state(riven?.maxRerolls !== undefined ? String(riven.maxRerolls) : "");
  let minEndoPerPlat = $state(
    riven?.minEndoPerPlat !== undefined ? String(riven.minEndoPerPlat) : "",
  );

  // Item form state
  let itemSlug = $state(item?.itemUrlName ?? "");
  let itemLabel = $state(item ? titleFromSlug(item.itemUrlName) : "");
  let itemQuery = $state("");
  let itemResults = $state<WfmSearchItem[]>([]);
  let side = $state<"sell" | "buy">(item?.side ?? "sell");
  let minQuantity = $state(item?.minQuantity !== undefined ? String(item.minQuantity) : "");
  let statuses = $state<MarketAlertSellerStatus[]>([...(item?.statuses ?? ["ingame"])]);
  let ownedBelow = $state(item?.ownedBelow !== undefined ? String(item.ownedBelow) : "");
  let ownedAbove = $state(item?.ownedAbove !== undefined ? String(item.ownedAbove) : "");

  // Device-local: which saved selection "Open Bulk Sell" applies for this rule.
  let sellLink = $state(initialRule?.id ? getAlertSellLink(initialRule.id) : "");
  // A link whose selection was deleted stays listed, so saving keeps it instead
  // of silently dropping it behind the user's back.
  const sellLinkOptions = $derived(
    sellLink && !$savedSelections.some((entry) => entry.name === sellLink)
      ? [sellLink, ...$savedSelections.map((entry) => entry.name)]
      : $savedSelections.map((entry) => entry.name),
  );

  let weaponNames = $state<string[]>([]);

  const sectionTitle =
    "m-0 font-display text-[0.7rem] font-bold uppercase tracking-[0.09em] text-text-muted";

  $effect(() => {
    void invoke("getRivenWeaponNames").then((names) => {
      weaponNames = names;
    });
  });

  let searchToken = 0;
  async function searchItems(): Promise<void> {
    const query = itemQuery.trim();
    if (query.length < 3) {
      itemResults = [];
      return;
    }
    const token = ++searchToken;
    const results = await invoke("wfmSearchItems", query, 8);
    // The search invoke can answer with a WfmMutationError object instead.
    if (token === searchToken && Array.isArray(results)) itemResults = results;
  }

  function pickItem(entry: WfmSearchItem): void {
    if (!entry.url_name) return;
    itemSlug = entry.url_name;
    itemLabel = entry.item_name;
    itemResults = [];
    itemQuery = "";
  }

  function toggleStatus(status: MarketAlertSellerStatus): void {
    statuses = statuses.includes(status)
      ? statuses.filter((s) => s !== status)
      : [...statuses, status];
  }

  // Numeric inputs hand back numbers through bind:value, empty ones strings.
  function numOrUndef(raw: string | number): number | undefined {
    const text = String(raw).trim();
    if (!text) return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }

  function buildRivenMatch(): RivenAlertMatch | null {
    if (!existingWeaponSlug && !weaponInput.trim()) {
      error = $tr("marketAlerts.weaponRequired");
      return null;
    }
    const bounds: RivenStatBound[] = [];
    for (const row of statBounds) {
      if (!row.attribute) continue;
      const min = numOrUndef(row.min);
      const max = numOrUndef(row.max);
      if (min === undefined && max === undefined) continue;
      const bound: RivenStatBound = { attribute: row.attribute };
      if (min !== undefined) bound.min = min;
      if (max !== undefined) bound.max = max;
      bounds.push(bound);
    }
    const match: RivenAlertMatch = {
      // Replaced by main when a weapon display name travels with the save; left
      // empty the rule fails the slug check instead of alerting on nothing.
      weaponUrlName: existingWeaponSlug,
      requirePositive,
      requireNegative,
      excludeAttributes,
      statBounds: bounds,
    };
    if (curseMode === "required") match.hasNegative = true;
    if (curseMode === "forbidden") match.hasNegative = false;
    const optional: Array<[keyof RivenAlertMatch, number | undefined]> = [
      ["minSimilarityPct", numOrUndef(similarityPct)],
      ["minMasteryRank", numOrUndef(minMastery)],
      ["maxMasteryRank", numOrUndef(maxMastery)],
      ["minModRank", numOrUndef(minModRank)],
      ["maxModRank", numOrUndef(maxModRank)],
      ["minPlatinum", numOrUndef(minPlat)],
      ["maxPlatinum", numOrUndef(maxPlat)],
      ["minRerolls", numOrUndef(minRerolls)],
      ["maxRerolls", numOrUndef(maxRerolls)],
      ["minEndoPerPlat", numOrUndef(minEndoPerPlat)],
    ];
    for (const [key, value] of optional) {
      if (value !== undefined) (match as unknown as Record<string, number>)[key] = value;
    }
    if (polarity) match.polarity = polarity as RivenPolarity;
    return match;
  }

  function buildItemMatch(): ItemAlertMatch | null {
    if (!itemSlug) {
      error = $tr("marketAlerts.itemRequired");
      return null;
    }
    const match: ItemAlertMatch = { itemUrlName: itemSlug, side, statuses };
    const optional: Array<[keyof ItemAlertMatch, number | undefined]> = [
      ["minPlatinum", numOrUndef(minPlat)],
      ["maxPlatinum", numOrUndef(maxPlat)],
      ["minQuantity", numOrUndef(minQuantity)],
      ["ownedBelow", numOrUndef(ownedBelow)],
      ["ownedAbove", numOrUndef(ownedAbove)],
    ];
    for (const [key, value] of optional) {
      if (value !== undefined) (match as unknown as Record<string, number>)[key] = value;
    }
    if (match.minPlatinum === undefined && match.maxPlatinum === undefined) {
      error = $tr("marketAlerts.priceRequired");
      return null;
    }
    return match;
  }

  async function save(): Promise<void> {
    error = "";
    const trimmedName = name.trim();
    if (!trimmedName) {
      error = $tr("marketAlerts.nameRequired");
      return;
    }
    const input: MarketAlertRuleInput = {
      name: trimmedName,
      kind,
      enabled,
      cooldownMinutes: Number(cooldownMinutes) || MARKET_ALERT_DEFAULT_COOLDOWN_MINUTES,
    };
    if (rule?.id) input.id = rule.id;
    if (kind === "riven") {
      const match = buildRivenMatch();
      if (!match) return;
      input.riven = match;
    } else {
      const match = buildItemMatch();
      if (!match) return;
      input.item = match;
    }

    const payload: MarketAlertSavePayload = { rule: input, binding: { native } };
    if (kind === "riven" && (weaponDirty || !existingWeaponSlug)) {
      payload.weaponName = weaponInput.trim();
    }
    if (kind === "item" && itemSlug) {
      payload.ownedCount = ownedCountForAlertItem(
        itemSlug,
        itemLabel || titleFromSlug(itemSlug),
        $parsedItems,
        $wfmItems,
      );
    }

    saving = true;
    try {
      // $state arrays are proxies and proxies fail the IPC structured clone.
      const result = await invoke("marketAlertsSave", $state.snapshot(payload));
      if (!result.ok) {
        error = $tr("marketAlerts.saveFailed", { error: result.error });
        return;
      }
      // Only now is the id known for a rule main just created.
      if (kind === "item") setAlertSellLink(result.rule.id, sellLink);
      onClose(true);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet statPicker(labelKey: MessageKey, list: string[], set: (next: string[]) => void)}
  <div class="text-sm">
    <span class="text-text-secondary">{$tr(labelKey)}</span>
    <div class="mt-1 flex flex-wrap items-center gap-1.5">
      {#each list as stat (stat)}
        <span class="flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
          {statLabel(stat, statOptions)}
          <button
            class="link-btn"
            aria-label={$tr("common.delete")}
            onclick={() => set(list.filter((s) => s !== stat))}>x</button
          >
        </span>
      {/each}
      {#if list.length < MARKET_ALERT_MAX_ATTRIBUTES}
        <select
          class="shared-filter-select"
          value=""
          onchange={(event) => {
            const next = event.currentTarget.value;
            if (next && !list.includes(next)) set([...list, next]);
            event.currentTarget.value = "";
          }}
        >
          <option value="">+</option>
          {#each statOptions as option (option.wfmUrlName)}
            {#if !list.includes(option.wfmUrlName)}
              <option value={option.wfmUrlName}>{option.displayName}</option>
            {/if}
          {/each}
        </select>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet rangePair(labelKey: MessageKey, lo: { v: string }, hi: { v: string })}
  <div class="flex flex-col gap-1 text-sm">
    <span class="text-text-secondary">{$tr(labelKey)}</span>
    <div class="flex gap-1">
      <ThemedInput bind:value={lo.v} placeholder={$tr("common.min")} className="w-full" />
      <ThemedInput bind:value={hi.v} placeholder={$tr("common.max")} className="w-full" />
    </div>
  </div>
{/snippet}

<div class="rounded-xl border border-border bg-bg-surface p-4" data-testid="alert-rule-editor">
  <div class="mb-3 flex items-center justify-between">
    <h3 class="m-0 font-display text-lg font-bold">
      {rule ? $tr("marketAlerts.editRule") : $tr("marketAlerts.newRule")}
    </h3>
    {#if !rule}
      <div class="flex gap-1">
        <button
          class={kind === "riven" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
          onclick={() => (kind = "riven")}>{$tr("rivens.type.riven")}</button
        >
        <button
          class={kind === "item" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
          onclick={() => (kind = "item")}>{$tr("common.item")}</button
        >
      </div>
    {/if}
  </div>

  <section class="flex flex-col gap-3" data-alert-section="watch">
    <h4 class={sectionTitle}>{$tr("marketAlerts.section.watch")}</h4>
    <div class="grid gap-3 md:grid-cols-2">
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-text-secondary">{$tr("marketAlerts.ruleName")}</span>
        <ThemedInput bind:value={name} placeholder={$tr("marketAlerts.ruleName")} />
      </label>
      {#if kind === "riven"}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("rivens.finder.weapon")}</span>
          <input
            class="rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] bg-[var(--ui-control-bg)] px-2.5 py-2 text-sm text-text-primary outline-none"
            list="market-alert-weapon-names"
            maxlength={MARKET_ALERT_MAX_NAME_CHARS * 2}
            bind:value={weaponInput}
            oninput={() => (weaponDirty = true)}
          />
          <datalist id="market-alert-weapon-names">
            {#each weaponNames as weaponName (weaponName)}
              <option value={weaponName}></option>
            {/each}
          </datalist>
        </label>
      {:else}
        <div class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("common.item")}</span>
          {#if itemSlug}
            <div class="flex items-center gap-2">
              <span class="rounded-full border border-border px-2 py-0.5">{itemLabel}</span>
              <button
                class="link-btn"
                onclick={() => {
                  itemSlug = "";
                  itemLabel = "";
                }}>{$tr("common.delete")}</button
              >
            </div>
          {:else}
            <ThemedInput
              bind:value={itemQuery}
              placeholder={$tr("common.searchPlaceholder")}
              onInput={() => void searchItems()}
            />
            {#if itemResults.length > 0}
              <div class="flex flex-col rounded border border-border bg-bg-surface">
                {#each itemResults as result (result.id)}
                  <button class="link-btn px-2 py-1 text-left" onclick={() => pickItem(result)}>
                    {result.item_name}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("common.orderType")}</span>
          <select class="shared-filter-select" bind:value={side}>
            {#each MARKET_ORDER_SIDES as orderSide (orderSide)}
              <option value={orderSide}>
                {orderSide === "sell" ? $tr("market.tab.sell") : $tr("market.tab.buy")}
              </option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </section>

  <section
    class="mt-4 flex flex-col gap-3 border-t border-border-subtle pt-3.5"
    data-alert-section="filters"
  >
    <h4 class={sectionTitle}>{$tr("common.filters")}</h4>

    {#if kind === "riven"}
      <div class="grid gap-3 md:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.curse")}</span>
          <select class="shared-filter-select" bind:value={curseMode}>
            <option value="any">{$tr("filters.any")}</option>
            <option value="required">{$tr("marketAlerts.curseRequired")}</option>
            <option value="forbidden">{$tr("marketAlerts.curseForbidden")}</option>
          </select>
        </label>
      </div>

      {@render statPicker("marketAlerts.requiredPositive", requirePositive, (next) => {
        requirePositive = next;
      })}
      {@render statPicker("marketAlerts.requiredNegative", requireNegative, (next) => {
        requireNegative = next;
      })}
      {@render statPicker("marketAlerts.excludedStats", excludeAttributes, (next) => {
        excludeAttributes = next;
      })}

      <div class="text-sm">
        <span class="text-text-secondary">{$tr("marketAlerts.statBounds")}</span>
        {#each statBounds as bound, index (index)}
          <div class="mt-1 flex items-center gap-2">
            <select class="shared-filter-select" bind:value={bound.attribute}>
              {#each statOptions as option (option.wfmUrlName)}
                <option value={option.wfmUrlName}>{option.displayName}</option>
              {/each}
            </select>
            <ThemedInput bind:value={bound.min} placeholder={$tr("common.min")} className="w-24" />
            <ThemedInput bind:value={bound.max} placeholder={$tr("common.max")} className="w-24" />
            <button
              class="link-btn"
              onclick={() => (statBounds = statBounds.filter((_row, i) => i !== index))}
              >{$tr("common.delete")}</button
            >
          </div>
        {/each}
        {#if statBounds.length < MARKET_ALERT_MAX_STAT_BOUNDS && statOptions.length > 0}
          <button
            class="link-btn mt-1"
            onclick={() =>
              (statBounds = [
                ...statBounds,
                { attribute: statOptions[0].wfmUrlName, min: "", max: "" },
              ])}>{$tr("marketAlerts.addBound")}</button
          >
        {/if}
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.similarity")}</span>
          <ThemedInput type="number" min="0" max="100" bind:value={similarityPct} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.polarity")}</span>
          <select class="shared-filter-select" bind:value={polarity}>
            <option value="">{$tr("filters.any")}</option>
            {#each RIVEN_POLARITIES as pol (pol)}
              <option value={pol}>{pol}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.minEndoPerPlat")}</span>
          <ThemedInput type="number" min="0" bind:value={minEndoPerPlat} />
        </label>
      </div>

      <div class="grid gap-3 md:grid-cols-4">
        {@render rangePair(
          "marketAlerts.masteryRank",
          {
            get v() {
              return minMastery;
            },
            set v(next: string) {
              minMastery = next;
            },
          },
          {
            get v() {
              return maxMastery;
            },
            set v(next: string) {
              maxMastery = next;
            },
          },
        )}
        {@render rangePair(
          "common.rank",
          {
            get v() {
              return minModRank;
            },
            set v(next: string) {
              minModRank = next;
            },
          },
          {
            get v() {
              return maxModRank;
            },
            set v(next: string) {
              maxModRank = next;
            },
          },
        )}
        {@render rangePair(
          "common.platinum",
          {
            get v() {
              return minPlat;
            },
            set v(next: string) {
              minPlat = next;
            },
          },
          {
            get v() {
              return maxPlat;
            },
            set v(next: string) {
              maxPlat = next;
            },
          },
        )}
        {@render rangePair(
          "common.rerolls",
          {
            get v() {
              return minRerolls;
            },
            set v(next: string) {
              minRerolls = next;
            },
          },
          {
            get v() {
              return maxRerolls;
            },
            set v(next: string) {
              maxRerolls = next;
            },
          },
        )}
      </div>
    {:else}
      <div class="grid gap-3 md:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("common.min")} {$tr("common.platinum")}</span>
          <ThemedInput type="number" min="0" bind:value={minPlat} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("common.max")} {$tr("common.platinum")}</span>
          <ThemedInput type="number" min="0" bind:value={maxPlat} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.minQuantity")}</span>
          <ThemedInput type="number" min="1" bind:value={minQuantity} />
        </label>
      </div>

      <div class="grid gap-3 md:grid-cols-3">
        <div class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.sellerStatus")}</span>
          <div class="flex gap-3">
            {#each MARKET_ALERT_SELLER_STATUSES as status (status)}
              <label class="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={statuses.includes(status)}
                  onchange={() => toggleStatus(status)}
                />
                {status === "ingame" ? $tr("common.inGame") : $tr("common.online")}
              </label>
            {/each}
          </div>
        </div>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.ownedBelow")}</span>
          <ThemedInput type="number" min="0" bind:value={ownedBelow} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.ownedAbove")}</span>
          <ThemedInput type="number" min="0" bind:value={ownedAbove} />
        </label>
      </div>
    {/if}
  </section>

  <section
    class="mt-4 flex flex-col gap-3 border-t border-border-subtle pt-3.5"
    data-alert-section="delivery"
  >
    <h4 class={sectionTitle}>{$tr("marketAlerts.section.delivery")}</h4>
    <div class="grid gap-3 md:grid-cols-2">
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-text-secondary">{$tr("marketAlerts.cooldownMinutes")}</span>
        <ThemedInput
          type="number"
          min={MARKET_ALERT_MIN_COOLDOWN_MINUTES}
          max={MARKET_ALERT_MAX_COOLDOWN_MINUTES}
          bind:value={cooldownMinutes}
        />
      </label>
      <div class="flex items-end gap-4 text-sm">
        <label class="flex items-center gap-1.5">
          <input type="checkbox" bind:checked={enabled} />
          {$tr("marketAlerts.enabled")}
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" bind:checked={native} />
          {$tr("marketAlerts.desktopNotification")}
        </label>
      </div>
      {#if kind === "item"}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-text-secondary">{$tr("marketAlerts.sellSelection")}</span>
          <select class="shared-filter-select" data-alert-sell-link bind:value={sellLink}>
            <option value="">{$tr("marketAlerts.sellSelectionItem")}</option>
            {#each sellLinkOptions as selectionName (selectionName)}
              <option value={selectionName}>{selectionName}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </section>

  {#if error}
    <p class="mt-3 text-sm text-danger">{error}</p>
  {/if}

  <div class="mt-4 flex justify-end gap-2">
    <button class="btn-secondary" onclick={() => onClose(false)}>{$tr("common.cancel")}</button>
    <button class="btn-primary" disabled={saving} onclick={() => void save()}>
      {$tr("common.save")}
    </button>
  </div>
</div>
