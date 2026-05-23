<script lang="ts">
  import { activeComponent } from "../stores/modals.js";
  import ModalShell from "../components/ModalShell.svelte";
  import ComponentPanel from "../components/ComponentPanel.svelte";

  $: data = $activeComponent;
  $: comp = data?.comp;
  $: parentName = data?.parentName || '';

  function close() {
    activeComponent.set(null);
  }
</script>

{#if comp}
  <ModalShell
    ariaLabel={comp.name || 'Component details'}
    overlayClass="comp-overlay"
    onClose={close}
  >
    <ComponentPanel
      {comp}
      {parentName}
      panelClass="comp-panel"
      onClose={close}
    />
  </ModalShell>
{/if}
