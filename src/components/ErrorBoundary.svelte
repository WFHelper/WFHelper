<script lang="ts">
  import { addToast } from "../stores/toasts.js";
  import { log } from "../lib/log.js";
  import { tr } from "../lib/i18n.js";
  import { restartInSafeMode } from "../lib/customCss/safeMode.js";
  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  // Svelte boundaries handle render failures, but not async errors. Report window
  // errors separately without replacing the UI.
  function reportAsync(reason: unknown): void {
    addToast({
      level: "error",
      title: $tr("common.rendererErrorTitle"),
      message: normalizeErrorMessage(reason, $tr("common.unknownRendererError")),
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
    <section class="m-6 rounded-xl border border-danger-dim bg-danger-bg p-5 text-text-primary">
      <h2 class="font-display text-2xl tracking-wide">{$tr("common.rendererCrashed")}</h2>
      <p class="mt-2 text-sm leading-relaxed text-text-secondary">
        {normalizeErrorMessage(error, $tr("common.unknownRendererError"))}
      </p>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          class="cursor-pointer rounded border border-danger-dim bg-danger-bg px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-danger hover:bg-danger/30"
          on:click={reset}
        >
          {$tr("common.tryRecover")}
        </button>
        <button
          class="cursor-pointer rounded border border-border-subtle bg-surface-hover px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-border-strong hover:bg-bg-hover"
          on:click={() => window.location.reload()}
        >
          {$tr("common.reloadApp")}
        </button>
        <button
          class="cursor-pointer rounded border border-border-subtle bg-surface-hover px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-border-strong hover:bg-bg-hover"
          data-restart-safe-mode
          on:click={restartInSafeMode}
        >
          {$tr("common.restartSafeMode")}
        </button>
      </div>
    </section>
  {/snippet}
</svelte:boundary>
