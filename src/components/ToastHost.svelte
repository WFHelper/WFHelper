<script lang="ts">
  import { toasts, removeToast } from "../stores/toasts.js";

  const LEVEL_CLASSES: Record<string, string> = {
    info: "border-blue-300/35 bg-blue-500/15 text-[#dbeafe]",
    success: "border-emerald-300/35 bg-emerald-500/15 text-[#d1fae5]",
    warning: "border-yellow-300/35 bg-warning/15 text-[#fef3c7]",
    error: "border-red-300/40 bg-danger/20 text-[#fee2e2]",
  };
  const TITLE_CLASSES: Record<string, string> = {
    info: "text-[#bfdbfe]",
    success: "text-[#a7f3d0]",
    warning: "text-[#fde68a]",
    error: "text-[#fecaca]",
  };
</script>

<div
  class="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+0.65rem)] z-[1200] flex w-16 max-w-[90vw] flex-col gap-2"
>
  {#each $toasts as toast (toast.id)}
    <article
      class="pointer-events-auto rounded-lg border p-3 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm {LEVEL_CLASSES[
        toast.level
      ] || ''}"
    >
      <header class="mb-1 flex items-start justify-between gap-3">
        <strong class="font-display text-sm tracking-wide {TITLE_CLASSES[toast.level] || ''}">
          {toast.title || toast.level}
        </strong>
        <button
          class="cursor-pointer rounded border border-white/15 bg-transparent px-1.5 py-0.5 text-xs text-white/80 transition-[border-color,color] duration-150 hover:border-white/35 hover:text-white"
          on:click={() => removeToast(toast.id)}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          x
        </button>
      </header>
      <p class="text-sm leading-[1.375] text-white/90">{toast.message}</p>
    </article>
  {/each}
</div>
