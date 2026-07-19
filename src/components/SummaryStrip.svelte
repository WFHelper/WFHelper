<script context="module" lang="ts">
  export type SummaryStripItem = {
    key: string;
    label: string;
    value: string | number;
    tone?: "default" | "success" | "warning" | "danger";
    icon?: string | null;
    subtext?: string;
  };
</script>

<script lang="ts">
  import ThemedPanel from "./ThemedPanel.svelte";

  export let items: SummaryStripItem[] = [];
  export let variant: "stats" | "mastery" = "stats";

  function toneClass(tone: SummaryStripItem["tone"]): string {
    if (tone === "success") return "text-success";
    if (tone === "warning") return "text-warning";
    if (tone === "danger") return "text-danger";
    return "text-text-primary";
  }
</script>

<ThemedPanel
  className={variant === "mastery"
    ? "inline-flex flex-wrap items-stretch px-7 py-5"
    : "flex flex-wrap items-stretch px-6 py-4"}
>
  {#each items as item, index (item.key)}
    {#if index > 0}
      <span class="self-stretch w-px bg-[color:var(--ui-panel-border)]" aria-hidden="true"></span>
    {/if}

    {#if variant === "mastery"}
      <div class="flex items-center gap-4 px-6">
        <span class="font-display text-5xl font-bold leading-none {toneClass(item.tone)}"
          >{item.value}</span
        >
        <span class="text-2xl font-semibold text-text-secondary">{item.label}</span>
      </div>
    {:else}
      <div class="flex flex-1 items-center gap-3 px-5 min-w-16">
        {#if item.icon}
          <img src={item.icon} alt="" class="w-9 h-9 object-contain opacity-90 shrink-0" />
        {/if}
        <div class="flex flex-col gap-1 min-w-0 flex-1">
          <div class="flex items-baseline gap-2 flex-wrap">
            <!-- nowrap so labels can't collide with values in image captures -->
            <span
              class="whitespace-nowrap text-base font-semibold uppercase tracking-wide text-text-primary"
            >
              {item.label}
            </span>
            <span
              class="whitespace-nowrap text-2xl font-bold leading-none tracking-tight {toneClass(
                item.tone,
              )}"
            >
              {item.value}
            </span>
          </div>
          {#if item.subtext}
            <span class="text-xs font-semibold text-text-secondary">{item.subtext}</span>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</ThemedPanel>
