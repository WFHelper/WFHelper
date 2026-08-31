<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    // Widened because a caller computes it, and exactOptionalPropertyTypes is on.
    hint?: string | undefined;
    hintTitle?: string;
    dataSetting?: string;
    // A label forwards its clicks to the first control inside it, which is wrong
    // for a row whose control is a group of buttons.
    as?: "label" | "div";
    inputRow?: boolean;
    // For a control that is itself a wrapping group: let it shrink so it wraps
    // inside the card instead of overflowing into the neighbouring column.
    wrapControl?: boolean;
    dimmed?: boolean;
    children: Snippet;
  }

  let {
    label,
    hint,
    hintTitle,
    dataSetting,
    as = "label",
    inputRow = false,
    wrapControl = false,
    dimmed = false,
    children,
  }: Props = $props();
</script>

{#snippet body()}
  <span>
    {label}
    {#if hint}
      <span class="block text-xs text-text-secondary" title={hintTitle}>{hint}</span>
    {/if}
  </span>
  {@render children()}
{/snippet}

{#if as === "label"}
  <label
    class="settings-control-row"
    class:settings-control-row-input={inputRow}
    class:settings-control-row-wrap={wrapControl}
    class:opacity-50={dimmed}
    data-setting={dataSetting}
  >
    {@render body()}
  </label>
{:else}
  <div
    class="settings-control-row"
    class:settings-control-row-input={inputRow}
    class:settings-control-row-wrap={wrapControl}
    class:opacity-50={dimmed}
    data-setting={dataSetting}
  >
    {@render body()}
  </div>
{/if}

<style>
  /* Same degradation as .settings-credit-row: a narrow card drops the control
     under the label instead of squeezing both into ragged columns. */
  .settings-control-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.1rem 0.7rem;
    border-radius: var(--radius-md);
    padding: 0.34rem 0.45rem;
    margin: 0 -0.45rem;
    cursor: pointer;
  }

  /* Basis is the longest word, so the label wraps its own text first and the
     control only drops to a second line once that no longer fits beside it. */
  .settings-control-row > :first-child {
    flex: 1 1 min-content;
    min-width: 0;
  }

  /* Never squeeze a control below its size, and keep it at the right edge once
     it is alone on the wrapped line. :global because the control is authored in
     the caller and so carries the caller's scope hash, never this one. */
  .settings-control-row > :global(:last-child) {
    flex-shrink: 0;
    margin-left: auto;
  }

  .settings-control-row:hover {
    background: var(--bg-hover);
  }

  /* :global also reaches the spans the caller slots in, as the one-file version did. */
  .settings-control-row :global(span) {
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .settings-control-row-input {
    cursor: default;
  }

  /* Caps the group at the card so its own flex-wrap engages, while keeping the
     no-squeeze rule (flex-shrink stays 0) the layout E2E measures. */
  .settings-control-row-wrap > :global(:last-child) {
    max-width: 100%;
  }
</style>
