<!--
  Themed control card / row.

  Shared wrapper for settings rows: a bordered, themed surface that holds a
  label on the left and a control (or controls) on the right. Replaces the
  repeated `border border-[var(--ui-control-border)] rounded-[var(--radius-lg)]
  bg-[var(--ui-control-bg)] ...` blocks across StyleSection, AppearanceCard,
  and FontSizeSection.

  Props:
    - as:      "div" | "label"  default "div".  Use "label" when the whole
                                  row should toggle a single nested input
                                  (checkbox/range) for accessibility.
    - density: "default" | "tight"
                                  Controls vertical padding.
                                  default = 0.52rem / 0.6rem (Style + Appearance)
                                  tight   = 0.45rem / 0.55rem (FontSize rows)
-->
<script lang="ts">
  export let as: "div" | "label" = "div";
  export let density: "default" | "tight" = "default";

  $: padClass =
    density === "tight" ? "py-2 px-2" : "py-2 px-2.5";
  $: baseClass =
    `border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] ${padClass}`;
</script>

{#if as === "label"}
  <label class="flex items-center justify-between gap-2.5 cursor-pointer {baseClass}">
    <slot />
  </label>
{:else}
  <div class={baseClass}>
    <slot />
  </div>
{/if}
