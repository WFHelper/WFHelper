<script lang="ts">
  import { toasts, removeToast } from "../stores/toasts.js";
  import { tr } from "../lib/i18n.js";

  const LEVEL_CLASSES: Record<string, string> = {
    info: "border-info-dim bg-info-bg text-info",
    success: "border-success-dim bg-success-bg text-success",
    warning: "border-warning-dim bg-warning-bg text-warning",
    error: "border-danger-dim bg-danger-bg text-danger",
  };
  const TITLE_CLASSES: Record<string, string> = {
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    error: "text-danger",
  };
</script>

<div
  class="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+0.65rem)] z-[1200] flex w-80 max-w-[90vw] flex-col gap-2"
>
  {#each $toasts as toast (toast.id)}
    <article
      class="pointer-events-auto rounded-lg border p-3 backdrop-blur-sm {LEVEL_CLASSES[
        toast.level
      ] || ''}"
    >
      <header class="mb-1 flex items-start justify-between gap-3">
        <strong class="font-display text-sm tracking-wide {TITLE_CLASSES[toast.level] || ''}">
          {toast.title || toast.level}
        </strong>
        <button
          class="cursor-pointer rounded border border-border-subtle bg-transparent px-1.5 py-0.5 text-xs text-text-secondary transition-[border-color,color] duration-150 hover:border-border-strong hover:text-text-primary"
          on:click={() => removeToast(toast.id)}
          aria-label={$tr("common.dismissNotification")}
          title={$tr("common.dismiss")}
        >
          x
        </button>
      </header>
      <p class="text-sm leading-[1.375] text-text-primary">{toast.message}</p>
    </article>
  {/each}
</div>
