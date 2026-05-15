<script lang="ts">
  import { onMount } from "svelte";
  import { addToast } from "../stores/toasts.js";
  import { captureRendererException } from "../lib/crashReporting.js";

  const DUPLICATE_SUPPRESSION_MS = 2000;

  let hasError = false;
  let errorMessage = "";
  let lastNotifiedMessage = "";
  let lastNotificationAt = 0;

  function toMessage(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
    if (reason && typeof reason === "object") {
      const maybeMessage = (reason as { message?: unknown }).message;
      if (typeof maybeMessage === "string" && maybeMessage.trim()) {
        return maybeMessage.trim();
      }
    }
    return "Unknown renderer error";
  }

  function setBoundaryError(reason: unknown): void {
    const message = toMessage(reason);
    hasError = true;
    errorMessage = message;
    captureRendererException(reason, { source: "ErrorBoundary" });

    const now = Date.now();
    const isDuplicate =
      message === lastNotifiedMessage &&
      now - lastNotificationAt < DUPLICATE_SUPPRESSION_MS;
    if (!isDuplicate) {
      lastNotifiedMessage = message;
      lastNotificationAt = now;
      addToast({
        level: "error",
        title: "Renderer Error",
        message,
        sticky: true,
      });
    }
  }

  function onWindowError(event: ErrorEvent): void {
    setBoundaryError(event.error || event.message);
  }

  function onUnhandledRejection(event: PromiseRejectionEvent): void {
    setBoundaryError(event.reason);
  }

  function resetBoundary(): void {
    hasError = false;
    errorMessage = "";
  }

  function reloadApp(): void {
    window.location.reload();
  }

  onMount(() => {
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  });
</script>

{#if hasError}
  <section class="m-6 rounded-xl border border-red-300/35 bg-danger/10 p-5 text-[#fee2e2]">
    <h2 class="font-display text-2xl tracking-wide">Renderer crashed</h2>
    <p class="mt-2 text-sm leading-relaxed text-red-100/90">
      {errorMessage}
    </p>
    <div class="mt-4 flex flex-wrap gap-2">
      <button
        class="cursor-pointer rounded border border-red-200/40 bg-danger/20 px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-red-100/70 hover:bg-danger/30"
        on:click={resetBoundary}
      >
        Try recover
      </button>
      <button
        class="cursor-pointer rounded border border-white/25 bg-white/10 px-3 py-1.5 text-sm transition-[border-color,background] duration-150 hover:border-white/40 hover:bg-white/15"
        on:click={reloadApp}
      >
        Reload app
      </button>
    </div>
  </section>
{:else}
  <slot />
{/if}

