<script lang="ts">
  import ModalShell from "../components/ModalShell.svelte";

  export let ariaLabel: string;
  export let onClose: () => void;
  export let overlayClass = "";
  export let containerClass = "";
  export let panelClass = "";
  export let sideState: "none" | "component" | "reward" = "none";
  export let wrapPanel = true;
</script>

<ModalShell {ariaLabel} {onClose} {overlayClass}>
  {#if wrapPanel}
    <div
      class="detail-dual-container {containerClass}"
      class:has-comp={sideState === "component"}
      class:has-reward={sideState === "reward"}
    >
      <div class="detail-panel {panelClass}">
        <slot />
      </div>
      <slot name="sidePanel" />
    </div>
  {:else}
    <slot />
  {/if}
</ModalShell>
