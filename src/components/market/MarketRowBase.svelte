<script lang="ts">
  export let compact = false;
  export let title = "";
  export let thumb: string | null | undefined = null;
  export let badgeLabel = "";
  export let badgeClass = "";
  export let rankBadges: string[] = [];
  export let fullClass = "flex items-center gap-2 px-2.5 py-2";
  export let fullMainClass = "flex min-w-0 flex-1 items-center gap-2";
  export let fullContentClass = "grid min-w-0 gap-1";
  export let fullImageClass = "h-9 w-9 rounded-[var(--radius-md)] object-contain";
  export let compactBodyClass = "flex items-center gap-2.5 px-2.5 py-2";
  export let onOpen: (() => void) | null = null;

  function handleOpen(): void {
    onOpen?.();
  }
</script>

{#if compact}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="order-row flex flex-col overflow-hidden p-0 text-left" on:click={handleOpen}>
    <div class="flex items-center gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5">
      <slot name="headerStart" />
      {#if badgeLabel}
        <span class="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold tracking-wide {badgeClass}">
          {badgeLabel}
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate font-display text-sm font-bold text-text-primary" title={title}>
        {title}
        <slot name="titleMeta" />
      </span>
      {#each rankBadges as label}
        <span class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
          {label}
        </span>
      {/each}
      <slot name="headerEnd" />
    </div>

    <div class={compactBodyClass}>
      {#if thumb}
        <img src={thumb} alt={title} class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-black/30 object-contain" loading="lazy" />
      {:else}
        <div class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <slot name="compactBody" />
      <slot name="compactActions" />
    </div>
  </div>
{:else}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="order-row {fullClass} text-left" on:click={handleOpen}>
    <slot name="fullStart" />
    <div class={fullMainClass}>
      {#if thumb}
        <img src={thumb} alt={title} class={fullImageClass} loading="lazy" />
      {:else}
        <div class="{fullImageClass} bg-white/5"></div>
      {/if}
      <div class={fullContentClass}>
        <span class="order-item-name">
          {title}
          {#each rankBadges as label}
            <span class="ml-1 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
              {label}
            </span>
          {/each}
          <slot name="titleMeta" />
        </span>
        <slot name="fullBody" />
      </div>
    </div>
    <slot name="fullActions" />
  </div>
{/if}
