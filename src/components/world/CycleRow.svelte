<script lang="ts">
  // Cycle row used in the Planet Cycles section. Each row shows a planet icon,
  // current state badge, time remaining, and an optional notification toggle.
  type CycleAlertKey = "earth" | "cetus" | "vallis" | "cambion" | "duviri";

  export let name: string;
  export let iconSrc: string;
  export let stateLabel: string;
  export let stateClass: string;
  export let nextLabel: string;
  export let time: string;
  export let urgent: boolean;
  export let alertKey: CycleAlertKey | null = null;
  export let alertOn = false;
  export let onToggleAlert: ((key: CycleAlertKey) => void) | null = null;
</script>

<div class="flex items-center justify-between border-b border-dashed border-white/[0.06] py-1.5">
  <div class="flex min-w-0 items-center gap-1.5">
    <img class="h-[33px] w-[33px] shrink-0 rounded-full object-cover" src={iconSrc} alt="" />
    <span class="whitespace-nowrap text-sm font-semibold text-text-primary">{name}</span>
    <span
      class="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-bold whitespace-nowrap"
      class:world-state-day={stateClass === "day"}
      class:world-state-night={stateClass === "night"}
      class:world-state-warm={stateClass === "warm"}
      class:world-state-cold={stateClass === "cold"}
      class:world-state-fass={stateClass === "fass"}
      class:world-state-vome={stateClass === "vome"}
      class:world-state-anger={stateClass === "anger"}
      class:world-state-joy={stateClass === "joy"}
      class:world-state-envy={stateClass === "envy"}
      class:world-state-sorrow={stateClass === "sorrow"}
      class:world-state-fear={stateClass === "fear"}
    >{stateLabel}</span>
  </div>

  <span class="flex shrink-0 items-center gap-1">
    <span class="whitespace-nowrap text-xs text-text-secondary">{nextLabel} in</span>
    <span
      class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
      class:world-timer-urgent={urgent}
    >{time}</span>

    {#if alertKey && onToggleAlert}
      <button
        class="inline-flex shrink-0 items-center justify-center w-5 h-5 rounded-[var(--radius-md)]
               border border-border bg-transparent p-0 text-text-muted opacity-35 cursor-pointer
               transition-[opacity,background,color,border-color] duration-150
               hover:opacity-80 hover:bg-white/[0.06]
               data-[active]:opacity-100 data-[active]:text-warning
               data-[active]:border-[rgba(251,191,36,0.4)] data-[active]:bg-[rgba(251,191,36,0.1)]"
        data-active={alertOn || undefined}
        title={alertOn ? `Disable ${alertKey} notification` : `Enable ${alertKey} notification`}
        on:click={() => onToggleAlert?.(alertKey)}
        aria-pressed={alertOn}
      >
        {#if alertOn}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M8 1a5 5 0 0 0-5 5v2.586l-.707.707A1 1 0 0 0 3 11h10a1 1 0 0 0 .707-1.707L13 8.586V6a5 5 0 0 0-5-5zM6.5 14a1.5 1.5 0 0 0 3 0H6.5z" />
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.586l-.707.707A1 1 0 0 0 3.5 11h9a1 1 0 0 0 .707-1.707L12.5 8.586V6a4.5 4.5 0 0 0-4.5-4.5z" />
            <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
          </svg>
        {/if}
      </button>
    {/if}
  </span>
</div>
