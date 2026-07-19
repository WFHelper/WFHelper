<script lang="ts">
  import { addToast } from "../stores/toasts.js";
  import { log } from "../lib/log.js";
  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  // <svelte:boundary> catches render/effect crashes and swaps in the failed
  // snippet (reset remounts the subtree). Async errors never reach a boundary,
  // so window 'error'/'unhandledrejection' are reported separately as toasts
  // and don't tear down the UI.
  function reportAsync(reason: unknown): void {
    addToast({
      level: "error",
      title: "Renderer Error",
      message: normalizeErrorMessage(reason, "Unknown renderer error"),
      sticky: true,
    });
  }

  function onWindowError(event: Event): void {
    const err = event as ErrorEvent;
    reportAsync(err.error ?? err.message);
  }

  function onUnhandledRejection(event: Event): void {
    reportAsync((event as PromiseRejectionEvent).reason);
  }

  function onRenderCrash(error: unknown): void {
    log.error("[Renderer] render boundary caught", error);
  }
</script>

<svelte:window on:error={onWindowError} on:unhandledrejection={onUnhandledRejection} />

<svelte:boundary onerror={onRenderCrash}>
  <slot />

  {#snippet failed(error, reset)}
    <section class="m-6 rounded-xl border border-red-300/35 bg-danger/10 p-5 text-[#fee2e2]">
      <h2 class="font-display text-2xl tracking-wide">Renderer crashed</h2>
      <p class="mt-2 text-sm leading-relaxed text-red-100/90">
        {normalizeErrorMessage(error, "Unknown renderer error")}
      </p>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="cursor-pointer rounded border border-red-200/40 bg-danger/20 px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-red-100/70 hover:bg-danger/30"
          on:click={reset}
        >
          Try recover
        </button>
        <button
          class="cursor-pointer rounded border border-white/25 bg-white/10 px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-white/40 hover:bg-white/15"
          on:click={() => window.location.reload()}
        >
          Reload app
        </button>
      </div>
    </section>
  {/snippet}
</svelte:boundary>
