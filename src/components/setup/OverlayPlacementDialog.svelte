<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import OverlayPlacementStep from "./OverlayPlacementStep.svelte";
  import { tr } from "../../lib/i18n.js";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();
</script>

<ModalShell ariaLabel={$tr("overlayPlacement.title")} {onClose}>
  <section
    data-overlay-placement-dialog
    class="relative z-[1] flex h-[calc(100vh-2rem)] w-[1400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-surface p-5"
  >
    <h2 class="m-0 mb-3 font-display text-lg font-semibold text-text-primary">
      {$tr("overlayPlacement.title")}
    </h2>
    <OverlayPlacementStep variant="dialog" onFinish={onClose} />
  </section>
</ModalShell>
