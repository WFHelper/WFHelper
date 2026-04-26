<script lang="ts">
  export let kind: "plat" | "ducat" | "ratio" = "plat";
  export let state: "has-value" | "loading" | "no-data" = "loading";
  export let value: string;
</script>

<span class={`relic-row-pill relic-row-pill-${kind} ${state}`}>
  {value}
</span>

<style>
  .relic-row-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: color-mix(in oklab, var(--bg-raised) 88%, var(--bg-base));
    padding: 0.2rem 0.6rem;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .relic-row-pill.has-value {
    border-color: color-mix(in oklab, var(--accent) 52%, transparent);
    background: color-mix(in oklab, var(--accent) 20%, var(--bg-raised));
    color: var(--accent-bright);
  }

  .relic-row-pill.no-data {
    border-color: color-mix(in oklab, var(--text-muted) 35%, transparent);
    background: color-mix(in oklab, var(--bg-raised) 84%, var(--bg-base));
    color: var(--text-muted);
  }

  .relic-row-pill-ratio {
    border-color: color-mix(in oklab, var(--success) 48%, transparent);
    background: color-mix(in oklab, var(--success) 16%, var(--bg-raised));
    color: color-mix(in oklab, var(--success) 82%, white);
  }
</style>
