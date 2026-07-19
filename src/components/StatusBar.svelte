<script lang="ts">
  import { statusText } from "../stores/app.js";
  import { appUpdateState } from "../stores/updates.js";
  import { addToast } from "../stores/toasts.js";
  import { invoke } from "../lib/ipc.js";
  import UpdateModal from "./UpdateModal.svelte";

  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  let updateActionPending = false;
  let showChangelog = false;

  // available / downloading / downloaded all mean "there is an update": the pill
  // turns green and opens the changelog instead of re-checking the feed.
  $: hasUpdate =
    $appUpdateState.status === "available" ||
    $appUpdateState.status === "downloading" ||
    $appUpdateState.status === "downloaded";

  $: updateButtonDisabled = updateActionPending || $appUpdateState.status === "checking";
  $: updateButtonText =
    $appUpdateState.status === "checking"
      ? "Checking…"
      : $appUpdateState.status === "available"
        ? "Update available"
        : $appUpdateState.status === "downloading"
          ? `Downloading ${Math.round($appUpdateState.percent || 0)}%`
          : $appUpdateState.status === "downloaded"
            ? "Restart to update"
            : "Check updates";

  async function runCheck(): Promise<void> {
    updateActionPending = true;
    try {
      const result = await invoke("checkForAppUpdates");
      if (!result.ok && result.message) {
        addToast({ level: "warning", title: "Update Check", message: result.message });
      } else if (result.state.status === "not-available") {
        addToast({
          level: "info",
          title: "Up To Date",
          message: "You already have the latest version.",
        });
      }
    } catch (err) {
      addToast({ level: "error", title: "Update Error", message: normalizeErrorMessage(err) });
    } finally {
      updateActionPending = false;
    }
  }

  async function runDownload(): Promise<void> {
    updateActionPending = true;
    try {
      const result = await invoke("downloadAppUpdate");
      if (!result.ok && result.message) {
        addToast({ level: "warning", title: "Update Download", message: result.message });
      }
    } catch (err) {
      addToast({ level: "error", title: "Update Error", message: normalizeErrorMessage(err) });
    } finally {
      updateActionPending = false;
    }
  }

  async function runInstall(): Promise<void> {
    updateActionPending = true;
    try {
      const result = await invoke("installDownloadedUpdate");
      if (!result.ok) {
        addToast({
          level: "warning",
          title: "Update Install",
          message: result.message || "No downloaded update is ready.",
        });
      }
    } catch (err) {
      addToast({ level: "error", title: "Update Error", message: normalizeErrorMessage(err) });
    } finally {
      updateActionPending = false;
    }
  }

  // Green pill click: if an update is waiting, show the changelog; otherwise
  // run a manual check (auto-checks already run in the background).
  function onUpdateButton(): void {
    if (hasUpdate) {
      showChangelog = true;
      return;
    }
    void runCheck();
  }
</script>

<footer
  class="flex h-[var(--statusbar-height)] select-none items-center justify-between border-t border-border bg-bg-deep px-3.5 text-[12px] text-text-muted"
>
  <span class="flex items-center gap-2">
    <span>{$statusText}</span>
  </span>
  <button
    class="update-pill ml-auto mr-2 font-body"
    class:is-update={hasUpdate}
    title={$appUpdateState.message || "Check for app updates"}
    on:click={onUpdateButton}
    disabled={updateButtonDisabled}
  >
    {#if $appUpdateState.status === "available"}
      <span class="update-dot" aria-hidden="true"></span>
    {/if}
    {updateButtonText}
  </button>
  <span class="text-[10px] opacity-50" title="App version"
    >v{import.meta.env.VITE_APP_VERSION || "?"}</span
  >
</footer>

{#if showChangelog}
  <UpdateModal
    state={$appUpdateState}
    pending={updateActionPending}
    onClose={() => (showChangelog = false)}
    onDownload={runDownload}
    onInstall={runInstall}
  />
{/if}

<style>
  .update-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border-radius: 999px;
    border: 1px solid rgb(255 255 255 / 0.2);
    background: rgb(255 255 255 / 0.05);
    padding: 0.1rem 0.7rem;
    font-size: 0.72rem;
    letter-spacing: 0.03em;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background 0.15s ease;
  }
  .update-pill:hover:not(:disabled) {
    border-color: rgb(255 255 255 / 0.3);
    color: var(--text-primary);
  }
  .update-pill:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .update-pill.is-update {
    border-color: color-mix(in oklab, var(--success) 55%, transparent);
    background: color-mix(in oklab, var(--success) 16%, transparent);
    color: var(--success);
  }
  .update-pill.is-update:hover:not(:disabled) {
    border-color: var(--success);
    background: color-mix(in oklab, var(--success) 26%, transparent);
    color: var(--success);
  }
  .update-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--success);
    animation: update-pulse 1.8s ease-out infinite;
  }
  @keyframes update-pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--success) 55%, transparent);
    }
    70% {
      box-shadow: 0 0 0 0.35rem color-mix(in oklab, var(--success) 0%, transparent);
    }
    100% {
      box-shadow: 0 0 0 0 color-mix(in oklab, var(--success) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .update-dot {
      animation: none;
    }
  }
</style>
