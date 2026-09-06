<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";

  interface Props {
    messageKey: MessageKey;
    /** Marker attribute an e2e spec selects on; rendered valueless. */
    marker?: string;
  }

  let { messageKey, marker }: Props = $props();
</script>

<p class="m-0 py-4 text-center text-sm text-text-muted" {...marker ? { [marker]: "" } : {}}>
  {$tr(messageKey)}
</p>
