<script lang="ts">
  import type { Snippet } from "svelte";
  import { tr } from "../../lib/i18n.js";

  interface Props {
    // Optional because the Linux cards embed components that draw their own heading.
    title?: string;
    description?: string;
    info?: string;
    aside?: Snippet;
    sectionId?: string;
    children: Snippet;
  }

  let { title, description, info, aside, sectionId, children }: Props = $props();

  const infoId = $props.id();
  let infoOpen = $state(false);
</script>

{#snippet heading()}
  <div class="mb-1.5 flex items-center gap-1.5">
    <h3
      class="m-0 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary"
    >
      {title}
    </h3>
    {#if info}
      <button
        type="button"
        class="settings-info-button"
        aria-expanded={infoOpen}
        aria-controls={infoId}
        aria-label={$tr("settings.moreInfo")}
        title={$tr("settings.moreInfo")}
        data-settings-info-toggle
        onclick={() => (infoOpen = !infoOpen)}>i</button
      >
    {/if}
  </div>
  {#if description}
    <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">{description}</p>
  {/if}
  {#if info}
    <p
      id={infoId}
      class="settings-info-text mt-1.5 text-[var(--font-small-size,0.82rem)] leading-snug text-text-secondary"
      hidden={!infoOpen}
      data-settings-info
    >
      {info}
    </p>
  {/if}
{/snippet}

<article
  class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]"
  data-settings-section={sectionId}
>
  {#if title}
    {#if aside}
      <div class="flex items-start justify-between gap-3">
        <div>
          {@render heading()}
        </div>
        {@render aside()}
      </div>
    {:else}
      <div>
        {@render heading()}
      </div>
    {/if}
  {/if}
  {@render children()}
</article>

<style>
  .settings-info-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-display);
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .settings-info-button:hover,
  .settings-info-button[aria-expanded="true"] {
    border-color: var(--accent-dim);
    color: var(--accent);
  }

  .settings-info-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .settings-info-text {
    border-left: 2px solid var(--accent-dim);
    padding-left: 0.55rem;
  }
</style>
