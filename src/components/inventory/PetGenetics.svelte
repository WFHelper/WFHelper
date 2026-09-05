<script lang="ts">
  import { tr, type LocaleCode, type Translator } from "../../lib/i18n.js";
  import {
    PET_TRAIT_ORDER,
    petTraitLabelKey,
    resolvePetTrait,
    type PetImprint,
    type PetInstance,
    type PetTraitInfo,
    type PetTraitKind,
    type PetTraits,
  } from "../../lib/inventory/petGenetics.js";

  interface Props {
    pets: PetInstance[];
    prints: PetImprint[];
    locale: LocaleCode;
  }

  let { pets, prints, locale }: Props = $props();

  interface TraitRow {
    kind: PetTraitKind;
    dominant: PetTraitInfo | null;
    recessive: PetTraitInfo | null;
  }

  // Translator passed in rather than read inside: keeps the dependency textual.
  function traitRows(
    dominant: PetTraits,
    recessive: PetTraits,
    code: LocaleCode,
    t: Translator,
  ): TraitRow[] {
    const rows: TraitRow[] = [];
    for (const kind of PET_TRAIT_ORDER) {
      const dominantInfo = resolvePetTrait(kind, dominant[kind], code, t);
      const recessiveInfo = resolvePetTrait(kind, recessive[kind], code, t);
      // A species without a tail or a head has neither side, so the row goes.
      if (!dominantInfo && !recessiveInfo) continue;
      rows.push({ kind, dominant: dominantInfo, recessive: recessiveInfo });
    }
    return rows;
  }

  const petBlocks = $derived(
    pets.map((pet) => ({ pet, rows: traitRows(pet.dominant, pet.recessive, locale, $tr) })),
  );

  const printBlocks = $derived(
    prints.map((imprint) => ({
      imprint,
      rows: traitRows(imprint.dominant, imprint.recessive, locale, $tr),
    })),
  );
</script>

{#snippet chip(info: PetTraitInfo | null)}
  {#if info}
    <span class="flex items-center gap-1.5">
      {#if info.hex}
        <span
          class="h-3.5 w-3.5 shrink-0 rounded-[var(--radius-sm)] border border-border"
          style="background: {info.hex}"
          data-pet-swatch={info.hex}
        ></span>
      {:else}
        <span
          class="h-3.5 w-3.5 shrink-0 rounded-[var(--radius-sm)] border border-border bg-surface-hover"
        ></span>
      {/if}
      <span>{info.label}</span>
    </span>
  {:else}
    <span class="text-text-muted">{$tr("common.none")}</span>
  {/if}
{/snippet}

{#snippet traitTable(rows: TraitRow[])}
  <div class="mt-1 text-xs text-text-secondary">
    <div
      class="grid grid-cols-[5rem_1fr_1fr] gap-x-2 font-display text-[0.62rem] font-semibold tracking-wide text-text-muted uppercase"
    >
      <span></span>
      <span>{$tr("pet.dominant")}</span>
      <span>{$tr("pet.recessive")}</span>
    </div>
    {#each rows as row (row.kind)}
      <div
        class="grid grid-cols-[5rem_1fr_1fr] items-center gap-x-2 border-b border-dashed border-border-subtle py-1 last:border-b-0"
      >
        <span class="text-text-muted">{$tr(petTraitLabelKey(row.kind))}</span>
        {@render chip(row.dominant)}
        {@render chip(row.recessive)}
      </div>
    {/each}
  </div>
{/snippet}

<div class="grid gap-3">
  {#each petBlocks as block, petIndex (block.pet.instanceId ?? petIndex)}
    <div data-pet-instance={block.pet.instanceId ?? petIndex}>
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-muted">
        {#if block.pet.name}
          <span class="font-display text-sm font-semibold text-text-primary">{block.pet.name}</span>
        {/if}
        <span>{block.pet.isMale ? $tr("pet.male") : $tr("pet.female")}</span>
        <span>{block.pet.statusKey ? $tr(block.pet.statusKey) : block.pet.statusLabel}</span>
        <span>{$tr("pet.size", { value: block.pet.size.toFixed(2) })}</span>
        <span>{$tr("pet.printsRemaining", { count: block.pet.printsRemaining })}</span>
        {#if block.pet.hatchDate}
          <span>
            {$tr("pet.hatched", { date: block.pet.hatchDate.toLocaleDateString(locale) })}
          </span>
        {/if}
      </div>
      {@render traitTable(block.rows)}
    </div>
  {/each}

  {#if printBlocks.length > 0}
    <div>
      <div class="font-display text-xs font-semibold tracking-wide text-text-muted uppercase">
        {$tr("pet.imprints")}
      </div>
      {#each printBlocks as block, printIndex (block.imprint.instanceId ?? printIndex)}
        <div class="mt-2" data-pet-imprint={block.imprint.instanceId ?? printIndex}>
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-muted">
            <span class="text-text-secondary">
              {$tr("pet.imprintOf", { name: block.imprint.name })}
            </span>
            <span>{block.imprint.isMale ? $tr("pet.male") : $tr("pet.female")}</span>
            <span>{$tr("pet.size", { value: block.imprint.size.toFixed(2) })}</span>
          </div>
          {@render traitTable(block.rows)}
        </div>
      {/each}
    </div>
  {/if}
</div>
