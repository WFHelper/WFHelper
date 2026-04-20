<script lang="ts">
  import { toasts, removeToast } from "../stores/toasts.js";

  const LEVEL_CLASSES: Record<string, string> = {
    info: "border-[rgba(147,197,253,0.35)] bg-[rgba(59,130,246,0.15)] text-[#dbeafe]",
    success: "border-[rgba(110,231,183,0.35)] bg-[rgba(16,185,129,0.15)] text-[#d1fae5]",
    warning: "border-[rgba(252,211,77,0.35)] bg-[rgba(245,158,11,0.15)] text-[#fef3c7]",
    error: "border-[rgba(252,165,165,0.4)] bg-[rgba(239,68,68,0.2)] text-[#fee2e2]",
  };
  const TITLE_CLASSES: Record<string, string> = {
    info: "text-[#bfdbfe]",
    success: "text-[#a7f3d0]",
    warning: "text-[#fde68a]",
    error: "text-[#fecaca]",
  };
</script>

<div class="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+0.65rem)] z-[1200] flex w-[22rem] max-w-[90vw] flex-col gap-2">
  {#each $toasts as toast (toast.id)}
    <article class="pointer-events-auto rounded-lg border p-3 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm {LEVEL_CLASSES[toast.level] || ''}">
      <header class="mb-1 flex items-start justify-between gap-3">
        <strong class="font-display text-sm tracking-wide {TITLE_CLASSES[toast.level] || ''}">
          {toast.title || toast.level}
        </strong>
        <button
          class="cursor-pointer rounded border border-[rgba(255,255,255,0.15)] bg-transparent px-1.5 py-0.5 text-xs text-[rgba(255,255,255,0.8)] transition-[border-color,color] duration-150 hover:border-[rgba(255,255,255,0.35)] hover:text-white"
          on:click={() => removeToast(toast.id)}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          x
        </button>
      </header>
      <p class="text-sm leading-[1.375] text-[rgba(255,255,255,0.9)]">{toast.message}</p>
    </article>
  {/each}
</div>
