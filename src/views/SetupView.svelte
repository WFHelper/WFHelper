<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { onInventoryLoaded } from "../lib/actions.js";
  import { PRESET_KEYS, THEME_PRESETS } from "../config/themePresets.js";
  import { currentView, statusText } from "../stores/app.js";
  import { themeSettings } from "../stores/theme.js";
  import { invoke, on, send } from "../lib/ipc.js";
  import { APP_LOGO_URL, SETUP_OVERLAY_BG_URLS } from "../lib/assetUrls.js";
  import { writeStorage } from "../lib/persistence.js";
  import {
    hasInventoryShape,
    unwrapInventoryPayload as unwrapSharedInventoryPayload,
  } from "../../config/shared/inventoryPayload.js";
  import type { ThemeCornerStyle, ThemeSurfaceStyle } from "../types/theme.js";
  import type { RawInventoryData } from "../types/inventory.js";
  import type { HelperDownloadProgress, HelperStatus } from "../types/ipc.js";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import BuiltInThemeDropdown from "../components/settings/BuiltInThemeDropdown.svelte";

  type Step = "configure" | "inventory" | "downloading" | "done" | "overlays" | "error";
  type InventorySource = "helper" | "json" | "aleca";
  type HelperInventoryStatus = "checking" | "found" | "not_found" | "error";

  let step: Step = "configure";
  let inventorySource: InventorySource = "helper";
  let progress: HelperDownloadProgress | null = null;
  let errorMessage = "";
  let helperStatus: HelperInventoryStatus = "checking";
  let helperPath: string | null = null;
  let loadingApi = false;
  let runnerStatus: HelperStatus | null = null;
  let destroyed = false;
  let removeProgressListener: (() => void) | null = null;
  let removeInventoryListener: (() => void) | null = null;

  const surfaceOptions: Array<{ value: ThemeSurfaceStyle; label: string }> = [
    { value: "full", label: "Full" },
    { value: "border", label: "Border" },
    { value: "minimal", label: "Minimal" },
  ];
  const cornerOptions: Array<{ value: ThemeCornerStyle; label: string }> = [
    { value: "sharp", label: "Sharp" },
    { value: "soft", label: "Soft" },
    { value: "round", label: "Round" },
  ];

  onMount(async () => {
    removeProgressListener = on("helper-download-progress", (p) => {
      progress = p;
      if (p.stage === "done") {
        step = "done";
      } else if (p.stage === "error") {
        step = "error";
        errorMessage = p.error || "Download failed";
      }
    });

    removeInventoryListener = on("inventory-updated", async (data) => {
      if (destroyed || loadingApi) return;
      try {
        await acceptInventoryData(data, "Live inventory update failed");
      } catch {
        // The user can still choose a file import source on this screen.
      }
    });

    await refreshRunnerStatus();
    if (destroyed) return;

    if (runnerStatus?.installerAutoInstallHelper === false) {
      inventorySource = "json";
    }

    await refreshHelperStatus();
    if (destroyed) return;
  });

  onDestroy(() => {
    destroyed = true;
    removeInventoryListener?.();
    removeProgressListener?.();
    if (placementActive) {
      placementActive = false;
      void setPlacementDemo(null);
    }
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
      errorMessage = result.error || "Download failed. Check your internet connection.";
    }
  }

  async function importInventory(): Promise<void> {
    loadingApi = true;
    try {
      const data = await invoke("openInventoryFile");
      await acceptInventoryData(
        data,
        "That file does not look like an inventory JSON export. AlecaFrame stats/trade exports are not inventory imports.",
      );
    } catch (error) {
      errorMessage = `Inventory import failed: ${(error as Error).message}`;
      step = "error";
    } finally {
      loadingApi = false;
    }
  }

  async function importAlecaFrameInventory(): Promise<void> {
    loadingApi = true;
    try {
      const data = await invoke("openAlecaFrameInventoryFile");
      await acceptInventoryData(data, "Choose AlecaFrame lastData.dat from %LOCALAPPDATA%\\AlecaFrame.");
    } catch (error) {
      errorMessage = `AlecaFrame import failed: ${(error as Error).message}`;
      step = "error";
    } finally {
      loadingApi = false;
    }
  }

  async function loadApiHelper(preferPicker = false): Promise<void> {
    loadingApi = true;
    statusText.set("Loading inventory.json from warframe-api-helper...");
    try {
      let data: unknown = null;
      let loadError: string | null = null;

      if (!preferPicker) {
        data = await invoke("getInventory");
        loadError = getLoadErrorMessage(data);
      }

      if (!data || loadError) {
        data = await invoke("openInventoryFile");
        loadError = getLoadErrorMessage(data);
      }

      await acceptInventoryData(data, loadError || "Failed to load inventory JSON");
      await refreshHelperStatus();
    } catch (error) {
      if (!destroyed) {
        statusText.set(`Inventory load error: ${(error as Error).message}`);
        errorMessage = (error as Error).message;
      }
    } finally {
      loadingApi = false;
    }
  }

  async function triggerHelperRun(): Promise<void> {
    try {
      statusText.set("Running warframe-api-helper...");
      await invoke("runHelperNow");
      await refreshRunnerStatus();
      statusText.set("Helper finished - waiting for inventory...");
    } catch {
      statusText.set("Failed to run helper");
    }
  }

  async function useSelectedInventorySource(): Promise<void> {
    if (inventorySource === "helper") {
      if (runnerStatus?.exeFound) {
        await loadApiHelper(false);
        return;
      }
      await startDownload();
      return;
    }

    if (inventorySource === "json") {
      await importInventory();
      return;
    }

    if (inventorySource === "aleca") {
      await importAlecaFrameInventory();
      return;
    }
  }

  function completeSetup(nextView: "inventory" = "inventory"): void {
    writeStorage("setup-completed", "1");
    currentView.set(nextView);
  }

  function continueFromConfigure(): void {
    step = "inventory";
  }

  // Overlay placement: each sub-step shows the real overlay window with demo
  // content over a game screenshot, so the user right-drags it into place.
  const overlayPlacementSteps = [
    {
      key: "reward",
      title: "Relic reward overlay",
      text: "Pops up when your squad opens relics and prices every reward. Drag it with the right mouse button to where you want it - the spot is saved.",
    },
    {
      key: "planner",
      title: "Relic planner overlay",
      text: "Ranks your owned relics on the relic selection screen. Right-drag to place it.",
    },
    {
      key: "riven",
      title: "Riven scanner overlay",
      text: "Compares old and new roll while you reroll rivens. Right-drag both panels to place them.",
    },
    {
      key: "arbiSummary",
      title: "Arbitration summary",
      text: "Shows your run stats when an arbitration ends. Right-drag to place it.",
    },
  ] as const;

  let overlayStepIndex = 0;
  let placementActive = false;

  async function setPlacementDemo(
    target: "reward" | "planner" | "riven" | "arbiSummary" | null,
  ): Promise<void> {
    try {
      await invoke("setOverlayPlacementDemo", target);
    } catch {
      // placement demo is best-effort; setup must never get stuck on it
    }
  }

  function enterOverlaysStep(): void {
    step = "overlays";
    overlayStepIndex = 0;
    placementActive = true;
    send("window-maximize");
    void setPlacementDemo(overlayPlacementSteps[0].key);
  }

  function overlayNext(): void {
    if (overlayStepIndex < overlayPlacementSteps.length - 1) {
      overlayStepIndex += 1;
      void setPlacementDemo(overlayPlacementSteps[overlayStepIndex].key);
    } else {
      finishOverlaysStep();
    }
  }

  function overlayBack(): void {
    if (overlayStepIndex === 0) return;
    overlayStepIndex -= 1;
    void setPlacementDemo(overlayPlacementSteps[overlayStepIndex].key);
  }

  function finishOverlaysStep(): void {
    placementActive = false;
    void setPlacementDemo(null);
    send("window-maximize");
    completeSetup("inventory");
  }

  const finish = (): void => enterOverlaysStep();
  const skip = (): void => completeSetup("inventory");

  function retry(): void {
    step = "configure";
    errorMessage = "";
    progress = null;
  }

  function sourceButtonClass(source: InventorySource): string {
    const selected = inventorySource === source;
    return [
      "w-full cursor-pointer rounded-lg border px-3 py-3 text-left transition-colors duration-150",
      selected
        ? "border-accent bg-accent/10 text-text-primary"
        : "border-border bg-bg-raised text-text-secondary hover:border-border-strong hover:text-text-primary",
    ].join(" ");
  }

  type StepTarget = "configure" | "inventory" | "overlays" | "done";

  function stepFlags(target: StepTarget): { active: boolean; complete: boolean } {
    const active =
      step === target || (target === "inventory" && (step === "downloading" || step === "done"));
    const complete =
      (target === "configure" && step !== "configure") ||
      (target === "inventory" && step === "overlays");
    return { active, complete };
  }

  function stepTextClass(target: StepTarget): string {
    const { active, complete } = stepFlags(target);
    if (step === "error" && target === "inventory") return "text-danger";
    if (active) return "text-accent font-semibold";
    if (complete) return "text-success";
    return "text-text-muted";
  }

  function stepDotClass(target: StepTarget): string {
    const { active, complete } = stepFlags(target);
    if (step === "error" && target === "inventory") return "bg-danger";
    if (active) return "bg-accent shadow-[0_0_6px_var(--accent)]";
    if (complete) return "bg-success";
    return "bg-text-muted";
  }

  $: placementStep = overlayPlacementSteps[overlayStepIndex];
  $: effects = $themeSettings.effects;
  $: activePresetKey = PRESET_KEYS.includes($themeSettings.activePreset)
    ? $themeSettings.activePreset
    : "default";
  $: activePreset = THEME_PRESETS[activePresetKey] ?? THEME_PRESETS.default;
  $: progressPercent = progress?.percent ?? 0;
  $: bytesLabel = progress?.bytesTotal
    ? `${(progress.bytesReceived / 1024 / 1024).toFixed(1)} / ${(progress.bytesTotal / 1024 / 1024).toFixed(1)} MB`
    : "";
</script>

<section class="view active">
  {#if step === "overlays"}
    <div class="fixed inset-0 z-40 bg-bg-deep">
      <img
        src={SETUP_OVERLAY_BG_URLS[placementStep.key] || SETUP_OVERLAY_BG_URLS.reward}
        alt=""
        class="absolute inset-0 h-full w-full object-cover opacity-60"
      />
      <div class="absolute inset-0 bg-black/30"></div>

      <div class="absolute left-1/2 top-8 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-xl border border-border bg-bg-surface/95 p-4 shadow-2xl [backdrop-filter:blur(6px)]">
        <div class="mb-1 flex items-center justify-between gap-3">
          <h2 class="m-0 font-display text-base font-bold tracking-[0.02em]">{placementStep.title}</h2>
          <span class="shrink-0 text-xs text-text-muted">{overlayStepIndex + 1} / {overlayPlacementSteps.length}</span>
        </div>
        <p class="m-0 text-sm leading-snug text-text-secondary">{placementStep.text}</p>
        <div class="mt-3 flex items-center justify-between">
          <button class="btn-secondary btn-sm" on:click={finishOverlaysStep}>Skip</button>
          <div class="flex gap-2">
            {#if overlayStepIndex > 0}
              <button class="btn-secondary btn-sm" on:click={overlayBack}>Back</button>
            {/if}
            <button class="btn-primary btn-sm" on:click={overlayNext}>
              {overlayStepIndex === overlayPlacementSteps.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  {:else}
  <div class="mx-auto my-8 flex min-h-[520px] max-w-[900px] overflow-hidden rounded-xl border border-border bg-bg-surface">
    <div class="setup-left flex w-[190px] shrink-0 flex-col items-center border-r border-border bg-gradient-to-b from-bg-deep to-bg-raised px-4 pb-6 pt-7">
      <div class="setup-logo">
        <img src={APP_LOGO_URL} alt="App Logo" class="h-14 w-14 object-contain" />
      </div>
      <div class="mt-8 flex w-full flex-col gap-4">
        <div class="flex items-center gap-2 text-xs transition-colors duration-200 {stepTextClass('configure')}">
          <span class="h-2 w-2 shrink-0 rounded-full transition-[background] duration-200 {stepDotClass('configure')}"></span> Configure
        </div>
        <div class="flex items-center gap-2 text-xs transition-colors duration-200 {stepTextClass('inventory')}">
          <span class="h-2 w-2 shrink-0 rounded-full transition-[background] duration-200 {stepDotClass('inventory')}"></span> Inventory Source
        </div>
        <div class="flex items-center gap-2 text-xs transition-colors duration-200 {stepTextClass('overlays')}">
          <span class="h-2 w-2 shrink-0 rounded-full transition-[background] duration-200 {stepDotClass('overlays')}"></span> Overlays
        </div>
        <div class="flex items-center gap-2 text-xs transition-colors duration-200 {stepTextClass('done')}">
          <span class="h-2 w-2 shrink-0 rounded-full transition-[background] duration-200 {stepDotClass('done')}"></span> Finish
        </div>
      </div>
    </div>

    <div class="flex flex-1 flex-col px-6 pb-5 pt-7">
      <div class="setup-content flex-1">
        {#if step === "configure"}
          <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">Welcome to WFHelper</h2>

          <div class="grid gap-3">
            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-sm font-semibold text-text-primary">Default theme</h3>
                  <p class="mt-0.5 text-xs leading-snug text-text-muted">Choose one of the built-in themes.</p>
                </div>
              </div>
              <BuiltInThemeDropdown
                activePreset={activePresetKey}
                label="Built-in themes"
                fallbackLabel={activePreset.label}
                className="w-full"
                onSelect={(presetKey) => themeSettings.applyPreset(presetKey)}
              />
            </div>

            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-sm font-semibold text-text-primary">UI style</h3>
                  <p class="mt-0.5 text-xs leading-snug text-text-muted">Uses the same setting as Appearance.</p>
                </div>
              </div>
              <SegmentedControl
                value={effects.surfaceStyle}
                options={surfaceOptions}
                onChange={(surfaceStyle) => themeSettings.setEffects({ surfaceStyle })}
              />
            </div>

            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-sm font-semibold text-text-primary">Border style</h3>
                  <p class="mt-0.5 text-xs leading-snug text-text-muted">Choose how sharp or rounded app controls should feel.</p>
                </div>
              </div>
              <SegmentedControl
                value={effects.cornerStyle}
                options={cornerOptions}
                onChange={(cornerStyle) => themeSettings.setEffects({ cornerStyle })}
              />
            </div>
          </div>
        {:else if step === "inventory"}
          <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">
            Choose Inventory Source
          </h2>
          <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">
            Load your account inventory from the helper, an existing JSON export, or AlecaFrame's encrypted cache.
          </p>

          {#if helperStatus === "not_found" && runnerStatus?.exeFound}
            <div class="mb-3 rounded-lg border border-warning bg-warning/10 px-3 py-3">
              <span class="mb-1 inline-block rounded bg-warning px-2 py-0.5 font-display text-xs font-bold tracking-widest text-black">WAITING FOR DATA</span>
              <h3 class="font-display text-sm font-semibold text-text-primary">Go in-game to generate inventory data</h3>
              <p class="mt-0.5 text-xs leading-snug text-text-secondary">The helper is installed. Log into Warframe, then run the helper to create inventory.json.</p>
              <div class="mt-2 flex gap-2">
                <button class="btn-primary btn-sm" disabled={loadingApi} on:click={triggerHelperRun}>Run helper now</button>
                <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>Browse for JSON</button>
              </div>
            </div>
          {/if}

          <div class="grid gap-2">
            <button type="button" class={sourceButtonClass("helper")} aria-pressed={inventorySource === "helper"} on:click={() => (inventorySource = "helper")}>
              <div class="flex items-center justify-between gap-3">
                <span class="font-display text-sm font-semibold">warframe-api-helper</span>
                <span class="rounded bg-success/15 px-2 py-0.5 font-display text-xs font-bold tracking-widest text-success">RECOMMENDED</span>
              </div>
              <div class="mt-1 text-xs leading-snug">Use the pinned helper executable and load its inventory.json snapshot.</div>
              <div class="mt-2 text-xs text-text-muted">
                {#if helperStatus === "checking"}
                  Checking for inventory.json...
                {:else if helperStatus === "found"}
                  Found: {helperPath}
                {:else if runnerStatus?.exeFound}
                  Helper is installed and ready to run.
                {:else}
                  Helper is not installed yet.
                {/if}
              </div>
            </button>

            <button type="button" class={sourceButtonClass("json")} aria-pressed={inventorySource === "json"} on:click={() => (inventorySource = "json")}>
              <span class="font-display text-sm font-semibold">Import inventory JSON</span>
              <div class="mt-1 text-xs leading-snug">Open an existing inventory.json created by warframe-api-helper.</div>
            </button>

            <button type="button" class={sourceButtonClass("aleca")} aria-pressed={inventorySource === "aleca"} on:click={() => (inventorySource = "aleca")}>
              <span class="font-display text-sm font-semibold">Import AlecaFrame cache</span>
              <div class="mt-1 text-xs leading-snug">Decrypt lastData.dat from %LOCALAPPDATA%\AlecaFrame and load its embedded inventory payload.</div>
            </button>
          </div>
        {:else if step === "downloading"}
          <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">Downloading...</h2>
          <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">Fetching warframe-api-helper from GitHub Releases.</p>
          <div class="my-4">
            <div class="h-2 overflow-hidden rounded border border-border bg-bg-raised">
              <div class="h-full rounded bg-accent transition-[width] duration-300 ease-in-out" style="width: {progressPercent}%"></div>
            </div>
            <div class="mt-1.5 flex justify-between text-xs text-text-muted">
              <span>{progressPercent}%</span>
              <span>{bytesLabel}</span>
            </div>
          </div>
          <p class="!mt-4 !text-xs !text-text-muted">Please wait - this should only take a moment.</p>
        {:else if step === "done"}
          <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">Setup Complete</h2>
          <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">warframe-api-helper is ready to use.</p>
          <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">Run Warframe, then the helper can refresh inventory data in the background every 10 minutes.</p>
          <div class="my-4 flex justify-center text-success">
            <svg class="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p class="!mt-4 !text-xs !text-text-muted">Click <strong>Next</strong> to position your in-game overlays.</p>
        {:else if step === "error"}
          <h2 class="mb-3 font-display text-lg font-bold tracking-[0.02em]">Setup Needs Attention</h2>
          <p class="mb-2.5 text-sm font-semibold leading-[1.55] text-danger">{errorMessage}</p>
          <p class="mb-2.5 text-sm leading-[1.55] text-text-secondary">You can retry this setup path or skip and configure inventory loading later.</p>
        {/if}
      </div>

      <div class="mt-2 flex justify-end gap-2 border-t border-border pt-4">
        {#if step === "configure"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={continueFromConfigure}>Next</button>
        {:else if step === "inventory"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" disabled={loadingApi} on:click={useSelectedInventorySource}>
            {#if loadingApi}
              Loading...
            {:else if inventorySource === "helper"}
              {runnerStatus?.exeFound ? "Load Helper Data" : "Install Helper"}
            {:else if inventorySource === "json"}
              Import JSON
            {:else if inventorySource === "aleca"}
              Import AlecaFrame
            {/if}
          </button>
        {:else if step === "downloading"}
          <span></span>
        {:else if step === "done"}
          <button class="btn-primary btn-sm" on:click={finish}>Next</button>
        {:else if step === "error"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={retry}>Retry</button>
        {/if}
      </div>
    </div>
  </div>
  {/if}
</section>
