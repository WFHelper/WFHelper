<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import {
    getOverlayDescriptor,
    OVERLAY_LAYOUT_KINDS,
  } from "../../../config/shared/overlayLayout.js";
  import OverlayOpacitySlider from "./OverlayOpacitySlider.svelte";
</script>

<div class="mt-2.5 min-w-0" data-overlay-opacity-control>
  <OverlayOpacitySlider label={$tr("appearance.overlayOpacity")} />
</div>

<details class="mt-2 text-xs" data-overlay-opacity-overrides>
  <summary class="cursor-pointer text-text-secondary"
    >{$tr("appearance.overlayOpacityCustomize")}</summary
  >
  <div class="mt-2 space-y-3">
    {#each OVERLAY_LAYOUT_KINDS as kind (kind)}
      <OverlayOpacitySlider {kind} label={$tr(getOverlayDescriptor(kind).titleKey)} />
    {/each}
  </div>
</details>
