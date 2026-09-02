<script lang="ts">
  import { statusText } from "../stores/app.js";
  import { appUpdateState } from "../stores/updates.js";
  import { addToast } from "../stores/toasts.js";
  import { invoke } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import UpdateModal from "./UpdateModal.svelte";
  import NotificationHistory from "./NotificationHistory.svelte";
  import { markNotificationsSeen, notificationsUnread } from "../stores/notifications.js";

  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  let updateActionPending = false;
  let showChangelog = false;
  let showNotifications = false;

  function openNotifications() {
    markNotificationsSeen();
    showNotifications = true;
  }
  /** Version the changelog already popped for, so it opens once per update. */
  let autoOpenedVersion: string | null = null;

  $: statusLabel = $statusText ? $tr($statusText.key, $statusText.params) : "";

  // available / downloading / downloaded all mean "there is an update": the pill
  // turns green and opens the changelog instead of re-checking the feed.
  $: hasUpdate =
    $appUpdateState.status === "available" ||
    $appUpdateState.status === "downloading" ||
    $appUpdateState.status === "downloaded";

  function autoOpenChangelog(version: string): void {
    autoOpenedVersion = version;
    showChangelog = true;
  }

  // The startup check finding an update opens the changelog on its own; the pill
  // stays the way back in after it is closed.
  $: if (hasUpdate && $appUpdateState.version && autoOpenedVersion !== $appUpdateState.version) {
    autoOpenChangelog($appUpdateState.version);
  }

  $: updateButtonDisabled = updateActionPending || $appUpdateState.status === "checking";
  $: updateButtonText =
    $appUpdateState.status === "checking"
      ? $tr("statusbar.checking")
      : $appUpdateState.status === "available"
        ? $tr("statusbar.updateAvailable")
        : $appUpdateState.status === "downloading"
          ? $tr("statusbar.downloading", { percent: Math.round($appUpdateState.percent || 0) })
          : $appUpdateState.status === "downloaded"
            ? $tr("statusbar.restartToUpdate")
            : $tr("statusbar.checkUpdates");

  async function runCheck(): Promise<void> {
    updateActionPending = true;
    try {
      const result = await invoke("checkForAppUpdates");
      if (!result.ok && result.message) {
        addToast({
          level: "warning",
          title: $tr("statusbar.updateCheckTitle"),
          message: result.message,
        });
      } else if (result.state.status === "not-available") {
        addToast({
          level: "info",
          title: $tr("statusbar.upToDateTitle"),
          message: $tr("statusbar.upToDateMessage"),
        });
      }
    } catch (err) {
      addToast({
        level: "error",
        title: $tr("statusbar.updateErrorTitle"),
        message: normalizeErrorMessage(err),
      });
    } finally {
      updateActionPending = false;
    }
  }

  async function runDownload(): Promise<void> {
    updateActionPending = true;
    try {
      const result = await invoke("downloadAppUpdate");
      if (!result.ok && result.message) {
        addToast({
          level: "warning",
          title: $tr("statusbar.updateDownloadTitle"),
          message: result.message,
        });
      }
    } catch (err) {
      addToast({
        level: "error",
        title: $tr("statusbar.updateErrorTitle"),
        message: normalizeErrorMessage(err),
      });
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
          title: $tr("statusbar.updateInstallTitle"),
          message: result.message || $tr("statusbar.noUpdateReady"),
        });
      }
    } catch (err) {
      addToast({
        level: "error",
        title: $tr("statusbar.updateErrorTitle"),
        message: normalizeErrorMessage(err),
      });
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
  <span class="flex min-w-0 items-center gap-2">
    <span class="truncate">{statusLabel}</span>
  </span>
  <button
    class="notification-bell ml-auto mr-2 shrink-0"
    data-notification-open
    title={$tr("notifications.open")}
    aria-label={$tr("notifications.open")}
    on:click={openNotifications}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {#if $notificationsUnread > 0}
      <span class="bell-count">{$notificationsUnread}</span>
    {/if}
  </button>
  <button
    class="update-pill mr-2 shrink-0 whitespace-nowrap font-body"
    class:is-update={hasUpdate}
    title={$appUpdateState.message || $tr("statusbar.checkForUpdates")}
    on:click={onUpdateButton}
    disabled={updateButtonDisabled}
  >
    {#if $appUpdateState.status === "available"}
      <span class="update-dot" aria-hidden="true"></span>
    {/if}
    {updateButtonText}
  </button>
  <span class="shrink-0 text-[10px] opacity-50" title={$tr("statusbar.appVersionTitle")}
    >v{import.meta.env.VITE_APP_VERSION || "?"}</span
  >
</footer>

{#if showNotifications}
  <NotificationHistory onClose={() => (showNotifications = false)} />
{/if}

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
  .notification-bell {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: none;
    background: none;
    padding: 0.1rem 0.2rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .notification-bell:hover {
    color: var(--text-primary);
  }
  .notification-bell svg {
    width: 0.95rem;
    height: 0.95rem;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .bell-count {
    font-size: 0.66rem;
    line-height: 1;
    color: var(--accent);
  }
  .update-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-hover);
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
    border-color: var(--border-strong);
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
