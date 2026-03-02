<script lang="ts">
  import { toasts, removeToast } from "../stores/toasts.js";

  const levelClass: Record<string, string> = {
    info: "border-blue-300/35 bg-blue-500/15 text-blue-100",
    success: "border-emerald-300/35 bg-emerald-500/15 text-emerald-100",
    warning: "border-amber-300/35 bg-amber-500/15 text-amber-100",
    error: "border-red-300/40 bg-red-500/20 text-red-100",
  };
  const titleClass: Record<string, string> = {
    info: "text-blue-200",
    success: "text-emerald-200",
    warning: "text-amber-200",
    error: "text-red-200",
  };
</script>

<div class="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+0.65rem)] z-[1200] flex w-[22rem] max-w-[90vw] flex-col gap-2">
  {#each $toasts as toast (toast.id)}
    <article class={`pointer-events-auto rounded-lg border p-3 shadow-2xl backdrop-blur ${levelClass[toast.level]}`}>
      <header class="mb-1 flex items-start justify-between gap-3">
        <strong class={`font-[var(--font-display)] text-sm tracking-wide ${titleClass[toast.level]}`}>
          {toast.title || toast.level}
        </strong>
        <button
          class="cursor-pointer rounded border border-white/15 px-1.5 py-0.5 text-xs text-white/80 transition-colors duration-150 hover:border-white/35 hover:text-white"
          on:click={() => removeToast(toast.id)}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          x
        </button>
      </header>
      <p class="text-sm leading-snug text-white/90">{toast.message}</p>
    </article>
  {/each}
</div>
