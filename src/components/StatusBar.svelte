<script lang="ts">
  import { statusText } from "../stores/app.js";
  import { appUpdateState } from "../stores/updates.js";
  import { addToast } from "../stores/toasts.js";
  import { invoke } from "../lib/ipc.js";

  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  let updateActionPending = false;

  $: updateButtonDisabled = updateActionPending || $appUpdateState.status === "checking";
  $: updateButtonText =
    $appUpdateState.status === "checking"
      ? "Checking..."
      : $appUpdateState.status === "downloading"
        ? `Downloading ${Math.round($appUpdateState.percent || 0)}%`
        : $appUpdateState.status === "downloaded"
          ? "Install update"
          : "Check updates";

  async function onUpdateAction(): Promise<void> {
    updateActionPending = true;
    try {
      if ($appUpdateState.status === "downloaded") {
        const result = await invoke("installDownloadedUpdate");
        if (!result.ok) {
          addToast({
            level: "warning",
            title: "Update Install",
            message: result.message || "No downloaded update is ready.",
          });
        }
        return;
      }

      const result = await invoke("checkForAppUpdates");
      if (!result.ok && result.message) {
        addToast({
          level: "warning",
          title: "Update Check",
          message: result.message,
        });
      } else if (result.state.status === "not-available") {
        addToast({
          level: "info",
          title: "Up To Date",
          message: "You already have the latest version.",
        });
      }
    } catch (err) {
      addToast({
        level: "error",
        title: "Update Error",
        message: normalizeErrorMessage(err),
      });
    } finally {
      updateActionPending = false;
    }
  }
</script>

<footer class="flex h-[var(--statusbar-height)] select-none items-center justify-between border-t border-border bg-bg-deep px-[0.875rem] text-[12px] text-text-muted">
  <span class="flex items-center gap-2">
    <span>{$statusText}</span>
  </span>
  <button
    class="ml-auto mr-2 cursor-pointer rounded-full border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] px-[0.625rem] py-0.5 font-body text-xs tracking-wide text-text-muted transition-[color,border-color] duration-150 hover:border-[rgba(255,255,255,0.3)] hover:text-text-primary disabled:cursor-default disabled:opacity-60"
    title={$appUpdateState.message || "Check for app updates"}
    on:click={onUpdateAction}
    disabled={updateButtonDisabled}
  >
    {updateButtonText}
  </button>
  <span class="text-[10px] opacity-50" title="App version">v{import.meta.env.VITE_APP_VERSION || '?'}</span>
</footer>
