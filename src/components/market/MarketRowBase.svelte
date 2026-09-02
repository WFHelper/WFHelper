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
  export let onOpen: () => void;
  export let fallbackThumb: string | null = null;

  // A dead thumb URL (mirror miss on a brand-new item) degrades to the
  // fallback art, then to the no-thumb placeholder - never a broken-image glyph.
  let thumbFailed = false;
  let useFallbackThumb = false;
  $: if (thumb) {
    thumbFailed = false;
    useFallbackThumb = false;
  }
  $: displayThumb = useFallbackThumb ? fallbackThumb : thumb;
  $: showThumb = Boolean(displayThumb) && !thumbFailed;

  function onThumbError(): void {
    if (fallbackThumb && !useFallbackThumb && thumb !== fallbackThumb) {
      useFallbackThumb = true;
      return;
    }
    thumbFailed = true;
  }

  function handleOpen(): void {
    onOpen();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleOpen();
  }
</script>

{#if compact}
  <div
    class="order-row flex flex-col overflow-hidden p-0 text-left"
    role="button"
    tabindex="0"
    on:click={handleOpen}
    on:keydown={handleKeydown}
  >
    <div class="flex items-center gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5">
      <slot name="headerStart" />
      {#if badgeLabel}
        <span class="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold tracking-wide {badgeClass}">
          {badgeLabel}
        </span>
      {/if}
      <!-- Chips sit outside the truncating span so a long name clips instead of pushing them out. -->
      <span class="flex min-w-0 flex-1 items-baseline">
        <span class="min-w-0 truncate font-display text-sm font-bold text-text-primary" {title}>
          {title}
        </span>
        <span class="flex shrink-0 items-baseline"><slot name="titleMeta" /></span>
      </span>
      {#each rankBadges as label}
        <span class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
          {label}
        </span>
      {/each}
      <slot name="headerEnd" />
    </div>

    <div class={compactBodyClass}>
      {#if showThumb}
        <img
          src={displayThumb}
          alt={title}
          class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-surface-card object-contain"
          loading="lazy"
          on:error={onThumbError}
        />
      {:else}
        <div class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-surface-hover"></div>
      {/if}
      <slot name="compactBody" />
      <slot name="compactActions" />
    </div>
  </div>
{:else}
  <div
    class="order-row {fullClass} text-left"
    role="button"
    tabindex="0"
    on:click={handleOpen}
    on:keydown={handleKeydown}
  >
    <slot name="fullStart" />
    <div class={fullMainClass}>
      {#if showThumb}
        <img
          src={displayThumb}
          alt={title}
          class={fullImageClass}
          loading="lazy"
          on:error={onThumbError}
        />
      {:else}
        <div class="{fullImageClass} bg-surface-hover"></div>
      {/if}
      <div class={fullContentClass}>
        <span class="flex min-w-0 items-baseline">
          <span class="order-item-name min-w-0 truncate" {title}>{title}</span>
          <span class="flex shrink-0 items-baseline">
            {#each rankBadges as label}
              <span class="ml-1 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
                {label}
              </span>
            {/each}
            <slot name="titleMeta" />
          </span>
        </span>
        <slot name="fullBody" />
      </div>
    </div>
    <slot name="fullActions" />
  </div>
{/if}
