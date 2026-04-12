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
  <section class="error-boundary">
    <h2 class="error-boundary-title">Renderer crashed</h2>
    <p class="error-boundary-message">
      {errorMessage}
    </p>
    <div class="error-boundary-actions">
      <button
        class="error-boundary-btn error-boundary-btn--recover"
        on:click={resetBoundary}
      >
        Try recover
      </button>
      <button
        class="error-boundary-btn error-boundary-btn--reload"
        on:click={reloadApp}
      >
        Reload app
      </button>
    </div>
  </section>
{:else}
  <slot />
{/if}

<style>
  .error-boundary {
    margin: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid rgba(252,165,165,0.35);
    background: rgba(239,68,68,0.1);
    padding: 1.25rem;
    color: #fee2e2;
  }
  .error-boundary-title {
    font-family: var(--font-display);
    font-size: 1.5rem;
    letter-spacing: 0.05em;
  }
  .error-boundary-message {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.625;
    color: rgba(254,226,226,0.9);
  }
  .error-boundary-actions {
    margin-top: 1rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .error-boundary-btn {
    cursor: pointer;
    border-radius: 4px;
    padding: 0.375rem 0.75rem;
    font-size: 0.875rem;
    transition: border-color 0.15s, background 0.15s;
  }
  .error-boundary-btn--recover {
    border: 1px solid rgba(254,202,202,0.45);
    background: rgba(239,68,68,0.2);
  }
  .error-boundary-btn--recover:hover {
    border-color: rgba(254,226,226,0.7);
    background: rgba(239,68,68,0.3);
  }
  .error-boundary-btn--reload {
    border: 1px solid rgba(255,255,255,0.25);
    background: rgba(255,255,255,0.1);
  }
  .error-boundary-btn--reload:hover {
    border-color: rgba(255,255,255,0.45);
    background: rgba(255,255,255,0.15);
  }
</style>
