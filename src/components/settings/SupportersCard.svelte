<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../lib/i18n.js";
  import {
    loadSupporters,
    SUPPORTER_TIER_ORDER,
    type Supporter,
    type SupporterTier,
  } from "../../lib/supporters.js";

  // Patreon tier product names, shown as-is in every locale.
  const TIER_LABELS: Record<SupporterTier, string> = {
    biggest: "Biggest Supporter",
    big: "Big Supporter",
    basic: "Basic",
  };

  let supporters: Supporter[] = $state([]);

  onMount(() => {
    void loadSupporters().then((list) => {
      supporters = list;
    });
  });

  const groups = $derived(
    SUPPORTER_TIER_ORDER.map((tier) => ({
      tier,
      label: TIER_LABELS[tier],
      names: supporters.filter((entry) => entry.tier === tier).map((entry) => entry.name),
    })).filter((group) => group.names.length > 0),
  );
</script>

{#if groups.length > 0}
  <aside class="supporters-panel w-full rounded-[var(--radius-xl)] p-4" data-supporters>
    <h3
      class="m-0 mb-1 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary"
    >
      <span class="text-accent">&hearts;</span>
      {$tr("settings.supportersTitle")}
    </h3>
    <p class="m-0 text-[var(--font-small-size,0.82rem)] text-text-secondary">
      {$tr("settings.supportersDesc")}
    </p>
    <div class="mt-3 grid gap-3">
      {#each groups as group (group.tier)}
        <div>
          <div class="mb-1.5 flex items-center gap-1.5">
            <span
              class={group.tier === "biggest"
                ? "tier-dot tier-dot-biggest"
                : group.tier === "big"
                  ? "tier-dot tier-dot-big"
                  : "tier-dot tier-dot-basic"}
            ></span>
            <span class="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-muted">
              {group.label}
            </span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <!-- Index key: patron display names are not unique and a duplicate
                 keyed entry is a fatal error in Svelte 5. -->
            {#each group.names as name, i (i)}
              <span
                class={group.tier === "biggest"
                  ? "max-w-full break-words rounded-full border border-accent-dim bg-accent-glow px-2.5 py-0.5 text-[var(--font-small-size,0.82rem)] text-accent"
                  : group.tier === "big"
                    ? "max-w-full break-words rounded-full border border-accent-dim px-2.5 py-0.5 text-[var(--font-small-size,0.82rem)] text-text-primary"
                    : "max-w-full break-words rounded-full border border-border px-2.5 py-0.5 text-[var(--font-small-size,0.82rem)] text-text-secondary"}
                >{name}</span
              >
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .supporters-panel {
    border: 1px solid var(--ui-panel-border);
    background: var(--ui-panel-bg);
    box-shadow: var(--ui-panel-shadow);
    backdrop-filter: var(--ui-backdrop-blur);
  }

  .tier-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 9999px;
    flex-shrink: 0;
  }

  .tier-dot-biggest {
    background: var(--accent);
  }

  .tier-dot-big {
    background: color-mix(in srgb, var(--accent) 65%, transparent);
  }

  .tier-dot-basic {
    background: var(--text-muted);
  }
</style>
