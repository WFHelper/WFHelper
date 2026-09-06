<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { onInventoryLoaded } from "../lib/actions.js";
  import { tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";
  import { currentView, SETUP_COMPLETED_KEY, statusText } from "../stores/app.js";
  import { getPlatform, invoke, on } from "../lib/ipc.js";
  import { APP_LOGO_URL } from "../lib/assetUrls.js";
  import { writeStorage } from "../lib/persistence.js";
  import { shouldAutoStartTour, startTour } from "../stores/tour.js";
  import {
    hasInventoryShape,
    unwrapInventoryPayload as unwrapSharedInventoryPayload,
  } from "../../config/shared/inventoryPayload.js";
  import type { RawInventoryData } from "../types/inventory.js";
  import type { InventorySource } from "../../config/shared/inventorySource.js";
  import type { HelperDownloadProgress, HelperStatus } from "../types/ipc.js";
  import OverlayPlacementStep from "../components/setup/OverlayPlacementStep.svelte";
  import ConfigureStep from "../components/setup/ConfigureStep.svelte";

  type Step = "configure" | "inventory" | "downloading" | "done" | "overlays" | "error";
  type HelperInventoryStatus = "checking" | "found" | "not_found" | "error";

  let step: Step = "configure";
  const isLinux = getPlatform() === "linux";
  let inventorySource: InventorySource = "helper";
  let progress: HelperDownloadProgress | null = null;
  let errorMessage = "";
  let helperStatus: HelperInventoryStatus = "checking";
  let helperPath: string | null = null;
  let loadingApi = false;
  let runnerStatus: HelperStatus | null = null;
  let destroyed = false;
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  const STATUS_POLL_MS = 5_000;
  let removeProgressListener: (() => void) | null = null;
  let removeInventoryListener: (() => void) | null = null;
  let pendingInventoryData: unknown = null;

  onMount(async () => {
    removeProgressListener = on("helper-download-progress", (p) => {
      progress = p;
      if (p.stage === "done") {
        step = "done";
      } else if (p.stage === "error") {
        step = "error";
        errorMessage = p.error || $tr("setup.downloadFailedGeneric");
      }
    });

    removeInventoryListener = on("inventory-updated", async (data) => {
      if (destroyed || loadingApi) return;
      if (step === "configure") {
        // App.svelte already ingested it; don't yank the user off the theme step
        pendingInventoryData = data;
        return;
      }
      try {
        await acceptInventoryData(data, $tr("setup.liveInventoryUpdateFailed"));
      } catch {
        // The user can still choose a file import source on this screen.
      }
    });

    await refreshRunnerStatus();
    if (destroyed) return;

    if (runnerStatus?.installerAutoInstallHelper === false) {
      inventorySource = "manual";
    }

    await refreshHelperStatus();
    if (destroyed) return;

    // Keep the waiting-for-data banner's failure reason live: the helper now
    // retries about every 90s on its own, so the hint changes without clicks.
    statusPollTimer = setInterval(() => {
      void refreshRunnerStatus();
    }, STATUS_POLL_MS);
  });

  onDestroy(() => {
    destroyed = true;
    if (statusPollTimer) clearInterval(statusPollTimer);
    removeInventoryListener?.();
    removeProgressListener?.();
  });

  async function refreshRunnerStatus(): Promise<void> {
    try {
      runnerStatus = await invoke("getHelperStatus");
    } catch {
      runnerStatus = null;
    }
  }

  async function refreshHelperStatus(): Promise<void> {
    try {
      const status = await invoke("getInventoryStatus");
      if (status?.found) {
        helperStatus = "found";
        helperPath = status.path || null;
      } else {
        helperStatus = "not_found";
        helperPath = null;
      }
    } catch (error) {
      if (helperStatus === "checking") {
        helperStatus = "error";
      }
      helperPath = null;
      console.error("[Setup] getInventoryStatus failed:", error);
    }
  }

  function getLoadErrorMessage(data: unknown): string | null {
    if (!data || typeof data !== "object" || !("error" in data)) return null;
    const error = (data as { error?: unknown }).error;
    return typeof error === "string" ? error : null;
  }

  async function acceptInventoryData(data: unknown, failureMessage: string): Promise<void> {
    const loadError = getLoadErrorMessage(data);
    if (!data || loadError) {
      throw new Error(loadError || failureMessage);
    }

    const unwrapped = unwrapSharedInventoryPayload(data, { returnInputOnFailure: false });
    if (!hasInventoryShape(unwrapped)) {
      throw new Error(failureMessage);
    }

    await onInventoryLoaded(unwrapped as RawInventoryData);
    if (!destroyed && step !== "overlays") {
      finish();
    }
  }

  async function startDownload(): Promise<void> {
    step = "downloading";
    progress = null;
    const result = await invoke("downloadHelper");
    if (destroyed) return;
    if (result.ok) {
      step = "done";
      await refreshRunnerStatus();
      return;
    }
    if (step === "downloading") {
      step = "error";
      errorMessage = result.error || $tr("setup.downloadFailedConnection");
    }
  }

  // Remember the pick so a restart does not silently switch back to something
  // else. Only the helper needs this - the file pickers record their own source.
  async function persistHelperInventorySource(): Promise<void> {
    try {
      await invoke("setInventorySource", "helper");
    } catch {
      // non-fatal: the chosen data still loads for this session
    }
  }

  async function importFromFile(
    pick: () => Promise<unknown>,
    hintKey: MessageKey,
    failedPrefixKey: MessageKey,
  ): Promise<void> {
    loadingApi = true;
    try {
      await acceptInventoryData(await pick(), $tr(hintKey));
    } catch (error) {
      errorMessage = $tr(failedPrefixKey, { message: (error as Error).message });
      step = "error";
    } finally {
      loadingApi = false;
    }
  }

  const importInventory = (): Promise<void> =>
    importFromFile(
      () => invoke("openInventoryFile", "manual"),
      "setup.importJsonFailedMsg",
      "setup.importJsonFailedPrefix",
    );

  const importAlecaFrameInventory = (): Promise<void> =>
    importFromFile(
      () => invoke("openAlecaFrameInventoryFile"),
      "setup.importAlecaHint",
      "setup.importAlecaFailedPrefix",
    );

  async function loadApiHelper(preferPicker = false): Promise<void> {
    loadingApi = true;
    statusText.set({ key: "setup.status.loadingInventory" });
    try {
      let data: unknown = null;
      let loadError: string | null = null;

      if (!preferPicker) {
        data = await invoke("getInventory");
        loadError = getLoadErrorMessage(data);
      }

      // "Browse for JSON" replaces the helper; the silent fallback only seeds it.
      if (!data || loadError) {
        data = await invoke("openInventoryFile", preferPicker ? "manual" : "helper");
        loadError = getLoadErrorMessage(data);
      }

      await acceptInventoryData(data, loadError || $tr("setup.loadInventoryJsonFailed"));
      await refreshHelperStatus();
    } catch (error) {
      if (!destroyed) {
        statusText.set({
          key: "setup.status.loadError",
          params: { message: (error as Error).message },
        });
        errorMessage = (error as Error).message;
      }
    } finally {
      loadingApi = false;
    }
  }

  async function triggerHelperRun(): Promise<void> {
    try {
      statusText.set({ key: "setup.status.runningHelper" });
      await invoke("runHelperNow");
      await refreshRunnerStatus();
      statusText.set({ key: "setup.status.helperFinished" });
    } catch {
      statusText.set({ key: "setup.status.helperRunFailed" });
    }
  }

  async function useSelectedInventorySource(): Promise<void> {
    if (inventorySource === "helper") {
      await persistHelperInventorySource();
      if (runnerStatus?.exeFound) {
        await loadApiHelper(false);
        return;
      }
      await startDownload();
      return;
    }

    if (inventorySource === "manual") {
      await importInventory();
      return;
    }

    if (inventorySource === "aleca") {
      await importAlecaFrameInventory();
      return;
    }
  }

  function completeSetup(nextView: "inventory" = "inventory"): void {
    writeStorage(SETUP_COMPLETED_KEY, "1");
    // legacy key: a downgrade to a pre-v2 build must not re-run setup either
    writeStorage("setup-completed", "1");
    // Arm the tour before navigating. currentView subscribers run synchronously
    // and the auto-focus-search guard reads tourActive, so navigating first would
    // let the search box steal focus as the tour paints its first step.
    const autoStart = shouldAutoStartTour();
    if (autoStart) startTour();
    currentView.set(nextView);
  }

  async function continueFromConfigure(): Promise<void> {
    step = "inventory";
    if (pendingInventoryData === null) return;
    const data = pendingInventoryData;
    pendingInventoryData = null;
    try {
      await acceptInventoryData(data, $tr("setup.liveInventoryUpdateFailed"));
    } catch {
      // bad payload - stay on the source step and let the user pick manually
    }
  }

  const finish = (): void => void (step = "overlays");
  const skip = (): void => completeSetup("inventory");

  function retry(): void {
    step = "configure";
    errorMessage = "";
    progress = null;
  }

  // reactive state comes in as parameters so the template re-evaluates these
  function sourceButtonClass(source: InventorySource, current: InventorySource): string {
    const selected = current === source;
    return [
      "w-full cursor-pointer rounded-lg border px-3 py-3 text-left transition-colors duration-150",
      selected
        ? "border-accent bg-accent/10 text-text-primary"
        : "border-border bg-bg-raised text-text-secondary hover:border-border-strong hover:text-text-primary",
    ].join(" ");
  }

  type StepTarget = "configure" | "inventory" | "overlays" | "done";

  const PROGRESS_STEPS: Array<{ target: StepTarget; labelKey: MessageKey }> = [
    { target: "configure", labelKey: "setup.step.configure" },
    { target: "inventory", labelKey: "setup.step.inventorySource" },
    { target: "overlays", labelKey: "common.overlays" },
    { target: "done", labelKey: "setup.step.finish" },
  ];

  function stepFlags(target: StepTarget, current: Step): { active: boolean; complete: boolean } {
    const active =
      current === target ||
      (target === "inventory" && (current === "downloading" || current === "error")) ||
      (target === "done" && current === "overlays");
    const complete =
      (target === "configure" && current !== "configure") ||
      (target === "inventory" && (current === "done" || current === "overlays"));
    return { active, complete };
  }

  function stepTextClass(target: StepTarget, current: Step): string {
    const { active, complete } = stepFlags(target, current);
    if (current === "error" && target === "inventory") return "text-danger";
    if (active) return "text-accent font-semibold";
    if (complete) return "text-success";
    return "text-text-muted";
  }

  function stepDotClass(target: StepTarget, current: Step): string {
    const { active, complete } = stepFlags(target, current);
    if (current === "error" && target === "inventory") return "bg-danger";
    if (active) return "bg-accent shadow-[0_0_6px_var(--accent)]";
    if (complete) return "bg-success";
    return "bg-text-muted";
  }

  $: progressPercent = progress?.percent ?? 0;
  $: bytesLabel = progress?.bytesTotal
    ? `${(progress.bytesReceived / 1024 / 1024).toFixed(1)} / ${(progress.bytesTotal / 1024 / 1024).toFixed(1)} MB`
    : "";
</script>

<section class="view active">
  {#if step === "overlays"}
    <OverlayPlacementStep onFinish={() => completeSetup("inventory")} />
  {:else}
    <div
      class="mx-auto my-8 flex min-h-[620px] w-full max-w-[1080px] overflow-hidden rounded-xl border border-border bg-bg-surface"
    >
      <div
        class="setup-left flex w-[190px] shrink-0 flex-col items-center border-r border-border bg-gradient-to-b from-bg-deep to-bg-raised px-4 pb-6 pt-7"
      >
        <div class="setup-logo">
          <img src={APP_LOGO_URL} alt={$tr("setup.appLogoAlt")} class="h-14 w-14 object-contain" />
        </div>
        <div class="mt-8 flex w-full flex-col gap-4">
          {#each PROGRESS_STEPS as entry (entry.target)}
            <div
              class="flex items-center gap-2 text-xs transition-colors duration-200 {stepTextClass(
                entry.target,
                step,
              )}"
            >
              <span
                class="h-2 w-2 shrink-0 rounded-full transition-[background] duration-200 {stepDotClass(
                  entry.target,
                  step,
                )}"
              ></span>
              {$tr(entry.labelKey)}
            </div>
          {/each}
        </div>
      </div>

      <div class="flex flex-1 flex-col px-6 pb-5 pt-7">
        <div class="setup-content flex-1">
          {#if step === "configure"}
            <ConfigureStep />
          {:else if step === "inventory"}
            <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
              {$tr("setup.inventory.title")}
            </h2>
            <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
              {$tr("setup.inventory.desc")}
            </p>

            {#if helperStatus === "not_found" && runnerStatus?.exeFound}
              <div class="mb-3 rounded-lg border border-warning bg-warning/10 px-3 py-3">
                <span
                  class="mb-1 inline-block rounded bg-warning px-2 py-0.5 font-display text-xs font-bold tracking-widest text-text-on-accent"
                  >{$tr("setup.waiting.badge")}</span
                >
                <h3 class="font-display text-sm font-semibold text-text-primary">
                  {$tr("setup.waiting.title")}
                </h3>
                <p class="mt-0.5 text-xs leading-snug text-text-secondary">
                  {$tr("setup.waiting.desc")}
                </p>
                {#if runnerStatus?.lastRunReason === "access-denied"}
                  <p class="mt-1 text-xs font-semibold leading-snug text-warning">
                    {$tr("setup.waiting.accessDenied")}
                  </p>
                {:else if runnerStatus?.lastRunReason === "not-logged-in"}
                  <p class="mt-1 text-xs leading-snug text-text-secondary">
                    {$tr("setup.waiting.notLoggedIn")}
                  </p>
                {:else if runnerStatus?.lastRunReason === "token-not-found"}
                  <p class="mt-1 text-xs font-semibold leading-snug text-warning">
                    {$tr("setup.waiting.tokenNotFound")}
                  </p>
                {:else if runnerStatus?.lastRunReason === "game-not-running"}
                  <p class="mt-1 text-xs leading-snug text-text-secondary">
                    {$tr("setup.waiting.gameNotRunning")}
                  </p>
                {/if}
                <div class="mt-2 flex gap-2">
                  <button
                    class="btn-primary btn-sm"
                    disabled={loadingApi}
                    on:click={triggerHelperRun}>{$tr("setup.runHelperNow")}</button
                  >
                  <button
                    class="btn-secondary btn-sm"
                    disabled={loadingApi}
                    on:click={() => loadApiHelper(true)}>{$tr("setup.browseForJson")}</button
                  >
                </div>
              </div>
            {/if}

            <div class="grid gap-2">
              <button
                type="button"
                class={sourceButtonClass("helper", inventorySource)}
                aria-pressed={inventorySource === "helper"}
                on:click={() => (inventorySource = "helper")}
              >
                <div class="flex items-center justify-between gap-3">
                  <!-- Windows shows the executable's real name on GitHub Releases, never
                       localised; Linux has no executable, it reads the running game. -->
                  <span class="font-display text-sm font-semibold"
                    >{isLinux ? $tr("setup.source.helper.linuxTitle") : "warframe-api-helper"}</span
                  >
                  <span
                    class="rounded bg-success/15 px-2 py-0.5 font-display text-xs font-bold tracking-widest text-success"
                    >{$tr("common.recommended")}</span
                  >
                </div>
                <div class="mt-1 text-xs leading-snug">
                  {$tr(isLinux ? "setup.source.helper.linuxDesc" : "setup.source.helper.desc")}
                </div>
                <div class="mt-2 text-xs text-text-muted">
                  {#if helperStatus === "checking"}
                    {$tr("setup.source.helper.checking")}
                  {:else if helperStatus === "found"}
                    {$tr("setup.source.helper.found", { path: helperPath ?? "" })}
                  {:else if runnerStatus?.exeFound}
                    {$tr(isLinux ? "setup.source.helper.linuxReady" : "setup.source.helper.ready")}
                  {:else}
                    {$tr("setup.source.helper.notInstalled")}
                  {/if}
                </div>
              </button>

              <button
                type="button"
                class={sourceButtonClass("manual", inventorySource)}
                aria-pressed={inventorySource === "manual"}
                on:click={() => (inventorySource = "manual")}
              >
                <span class="font-display text-sm font-semibold"
                  >{$tr("setup.source.json.name")}</span
                >
                <div class="mt-1 text-xs leading-snug">
                  {$tr("setup.source.json.desc")}
                </div>
              </button>

              <button
                type="button"
                class={sourceButtonClass("aleca", inventorySource)}
                aria-pressed={inventorySource === "aleca"}
                on:click={() => (inventorySource = "aleca")}
              >
                <span class="font-display text-sm font-semibold"
                  >{$tr("setup.source.aleca.name")}</span
                >
                <div class="mt-1 text-xs leading-snug">
                  {$tr("setup.source.aleca.desc")}
                </div>
              </button>
            </div>
          {:else if step === "downloading"}
            <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
              {$tr("setup.downloading.title")}
            </h2>
            <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
              {$tr("setup.downloading.desc")}
            </p>
            <div class="my-4">
              <div class="h-2 overflow-hidden rounded border border-border bg-bg-raised">
                <div
                  class="h-full rounded bg-accent transition-[width] duration-300 ease-in-out"
                  style="width: {progressPercent}%"
                ></div>
              </div>
              <div class="mt-1.5 flex justify-between text-xs text-text-muted">
                <span>{progressPercent}%</span>
                <span>{bytesLabel}</span>
              </div>
            </div>
            <p class="!mt-4 !text-xs !text-text-muted">
              {$tr("setup.downloading.wait")}
            </p>
          {:else if step === "done"}
            <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
              {$tr("setup.done.title")}
            </h2>
            <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
              {$tr("setup.done.ready")}
            </p>
            <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
              {$tr("setup.done.background")}
            </p>
            <div class="my-4 flex justify-center text-success">
              <svg
                class="h-10 w-10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p class="!mt-4 !text-xs !text-text-muted">
              {$tr("setup.done.clickHint", { button: $tr("common.next") })}
            </p>
          {:else if step === "error"}
            <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
              {$tr("setup.error.title")}
            </h2>
            <p class="mb-2.5 text-sm font-semibold leading-[1.55] text-danger">{errorMessage}</p>
            <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
              {$tr("setup.error.desc")}
            </p>
          {/if}
        </div>

        <div class="mt-2 flex justify-end gap-2 border-t border-border pt-4">
          {#if step === "configure"}
            <button class="btn-secondary btn-sm" on:click={skip}>{$tr("setup.skip")}</button>
            <button class="btn-primary btn-sm" on:click={continueFromConfigure}
              >{$tr("common.next")}</button
            >
          {:else if step === "inventory"}
            <button class="btn-secondary btn-sm" on:click={skip}>{$tr("setup.skip")}</button>
            <button
              class="btn-primary btn-sm"
              disabled={loadingApi}
              on:click={useSelectedInventorySource}
            >
              {#if loadingApi}
                {$tr("common.loading")}
              {:else if inventorySource === "helper"}
                {runnerStatus?.exeFound ? $tr("setup.loadHelperData") : $tr("setup.installHelper")}
              {:else if inventorySource === "manual"}
                {$tr("setup.importJsonButton")}
              {:else if inventorySource === "aleca"}
                {$tr("setup.importAlecaButton")}
              {/if}
            </button>
          {:else if step === "done"}
            <button class="btn-primary btn-sm" on:click={finish}>{$tr("common.next")}</button>
          {:else if step === "error"}
            <button class="btn-secondary btn-sm" on:click={skip}>{$tr("setup.skip")}</button>
            <button class="btn-primary btn-sm" on:click={retry}>{$tr("common.retry")}</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>
