<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import { invoke } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import type { PopoutTarget, PopoutView } from "../../../config/shared/popoutTypes.js";

  interface Props {
    target: PopoutTarget | PopoutView;
    /** The host owns the look: a view header and the section toolbar size the
        button differently, so classes and icon size come from the call site. */
    class: string;
    iconSize?: number;
    /** data-* hooks the e2e specs and the section toolbar select on. */
    [attribute: `data-${string}`]: string | undefined;
  }

  const { target, class: className, iconSize = 14, ...rest }: Props = $props();

  function targetLabel(): string {
    if (typeof target === "string") return target;
    return target.kind === "view" ? target.view : "section";
  }

  async function openInWindow(): Promise<void> {
    try {
      await invoke("popoutOpen", target);
    } catch (err) {
      log.warn(`[Popout] open ${targetLabel()} failed:`, err);
    }
  }
</script>

<button
  type="button"
  aria-label={$tr("common.openInWindow")}
  title={$tr("common.openInWindow")}
  class={className}
  onclick={openInWindow}
  {...rest}
>
  <svg
    viewBox="0 0 16 16"
    width={iconSize}
    height={iconSize}
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 8 8" />
    <path d="M12.5 9.5V13H3V3.5h3.5" />
  </svg>
</button>
