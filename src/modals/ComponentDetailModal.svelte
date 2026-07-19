<script lang="ts">
  import { activeComponent } from "../stores/modals.js";
  import ComponentPanel from "../components/ComponentPanel.svelte";
  import DetailModalBase from "./DetailModalBase.svelte";

  $: data = $activeComponent;
  $: comp = data?.comp;
  $: parentName = data?.parentName || "";

  function close() {
    activeComponent.set(null);
  }
</script>

{#if comp}
  <DetailModalBase
    ariaLabel={comp.name || "Component details"}
    overlayClass="comp-overlay"
    onClose={close}
    wrapPanel={false}
  >
    <ComponentPanel {comp} {parentName} panelClass="comp-panel" onClose={close} />
  </DetailModalBase>
{/if}
