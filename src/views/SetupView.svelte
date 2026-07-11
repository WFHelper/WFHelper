<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { onInventoryLoaded } from "../lib/actions.js";
  import { PRESET_KEYS, THEME_PRESETS } from "../config/themePresets.js";
  import { currentView, statusText } from "../stores/app.js";
  import { themeSettings } from "../stores/theme.js";
  import { invoke, on } from "../lib/ipc.js";
  import { APP_LOGO_URL, SETUP_OVERLAY_BG_URLS } from "../lib/assetUrls.js";
  import { writeStorage } from "../lib/persistence.js";
  import { shouldAutoStartTour, startTour } from "../stores/tour.js";
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
    if (shouldAutoStartTour()) startTour();
  }

  function continueFromConfigure(): void {
    step = "inventory";
  }

  // Overlay placement: draggable dummy panels over a game screenshot. The
  // preview box maps 1:1 onto the primary display's work area, so dropping a
  // dummy saves where the real overlay window will appear.
  type PlacementKey = "reward" | "planner" | "rivenLeft" | "rivenRight" | "arbiSummary";
  type PlacementRect = { x: number; y: number; width: number; height: number };

  const overlayPlacementSteps: Array<{
    key: "reward" | "planner" | "riven" | "arbiSummary";
    dummies: PlacementKey[];
    title: string;
    text: string;
  }> = [
    {
      key: "reward",
      dummies: ["reward"],
      title: "Relic reward overlay",
      text: "Pops up when your squad opens relics and prices every reward. Drag the panel to where it should sit over your game.",
    },
    {
      key: "planner",
      dummies: ["planner"],
      title: "Relic planner overlay",
      text: "Ranks your owned relics on the relic selection screen. Drag it into place.",
    },
    {
      key: "riven",
      dummies: ["rivenLeft", "rivenRight"],
      title: "Riven scanner overlay",
      text: "Compares old and new roll while you reroll rivens. Drag both panels into place.",
    },
    {
      key: "arbiSummary",
      dummies: ["arbiSummary"],
      title: "Arbitration summary",
      text: "Shows your run stats when an arbitration ends. Drag it into place.",
    },
  ];

  const dummyLabels: Record<PlacementKey, string> = {
    reward: "RELIC REWARDS",
    planner: "RELIC PLANNER",
    rivenLeft: "RIVEN - CURRENT",
    rivenRight: "RIVEN - NEW ROLL",
    arbiSummary: "ARBITRATION SUMMARY",
  };

  let overlayStepIndex = 0;
  let placementArea = { width: 1920, height: 1080 };
  let placementPos: Record<PlacementKey, PlacementRect> | null = null;
  let placementScales: Record<PlacementKey, number> = {
    reward: 1,
    planner: 1,
    rivenLeft: 1,
    rivenRight: 1,
    arbiSummary: 1,
  };
  let previewW = 0;
  let dragging: {
    key: PlacementKey;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null = null;

  function clampToArea(rect: PlacementRect): PlacementRect {
    return {
      ...rect,
      x: Math.min(Math.max(0, rect.x), Math.max(0, placementArea.width - rect.width)),
      y: Math.min(Math.max(0, rect.y), Math.max(0, placementArea.height - rect.height)),
    };
  }

  async function enterOverlaysStep(): Promise<void> {
    step = "overlays";
    overlayStepIndex = 0;
    try {
      const layout = await invoke("getOverlayPlacementLayout");
      placementArea = layout.area;
      placementPos = {
        reward: clampToArea(layout.overlays.reward),
        planner: clampToArea(layout.overlays.planner),
        rivenLeft: clampToArea(layout.overlays.rivenLeft),
        rivenRight: clampToArea(layout.overlays.rivenRight),
        arbiSummary: clampToArea(layout.overlays.arbiSummary),
      };
      placementScales = {
        reward: layout.overlays.reward.scale,
        planner: layout.overlays.planner.scale,
        rivenLeft: layout.overlays.rivenLeft.scale,
        rivenRight: layout.overlays.rivenRight.scale,
        arbiSummary: layout.overlays.arbiSummary.scale,
      };
    } catch {
      // No dummies then - the wizard must never get stuck on this step.
      placementPos = null;
    }
  }

  function overlayNext(): void {
    if (overlayStepIndex < overlayPlacementSteps.length - 1) {
      overlayStepIndex += 1;
    } else {
      finishOverlaysStep();
    }
  }

  function overlayBack(): void {
    if (overlayStepIndex > 0) overlayStepIndex -= 1;
  }

  function finishOverlaysStep(): void {
    completeSetup("inventory");
  }

  function onDummyPointerDown(key: PlacementKey, event: PointerEvent): void {
    if (event.button !== 0 || !placementPos || previewScale <= 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const p = placementPos[key];
    dragging = {
      key,
      pointerId: event.pointerId,
      offsetX: event.clientX - p.x * previewScale,
      offsetY: event.clientY - p.y * previewScale,
    };
  }

  function onDummyPointerMove(event: PointerEvent): void {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    if (!placementPos || previewScale <= 0) return;
    const p = placementPos[dragging.key];
    placementPos = {
      ...placementPos,
      [dragging.key]: clampToArea({
        ...p,
        x: (event.clientX - dragging.offsetX) / previewScale,
        y: (event.clientY - dragging.offsetY) / previewScale,
      }),
    };
  }

  function onDummyPointerUp(event: PointerEvent): void {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const key = dragging.key;
    dragging = null;
    if (!placementPos) return;
    const p = placementPos[key];
    invoke("saveOverlayPlacement", key, {
      xFrac: p.x / placementArea.width,
      yFrac: p.y / placementArea.height,
    }).catch(() => {});
  }

  // Live slider preview scales the dummy footprint exactly like the real
  // window's zoom factor would; commit persists on release.
  function applyScalePreview(value: number): void {
    if (!placementPos) return;
    const next = { ...placementPos };
    for (const key of placementStep.dummies) {
      const prev = placementScales[key] || 1;
      const rect = next[key];
      next[key] = clampToArea({
        ...rect,
        width: (rect.width / prev) * value,
        height: (rect.height / prev) * value,
      });
      placementScales = { ...placementScales, [key]: value };
    }
    placementPos = next;
  }

  function commitScale(): void {
    for (const key of placementStep.dummies) {
      invoke("saveOverlayScale", key, placementScales[key]).catch(() => {});
    }
  }

  const finish = (): void => void enterOverlaysStep();
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
  $: previewScale = previewW > 0 && placementArea.width > 0 ? previewW / placementArea.width : 0;
  $: stepScale = placementScales[placementStep.dummies[0]] ?? 1;
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
    <div class="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-bg-deep px-6 py-5">
      <div
        class="relative min-h-0 overflow-hidden rounded-xl border border-border-strong bg-black shadow-2xl"
        style="aspect-ratio: {placementArea.width} / {placementArea.height}; width: min(100%, calc((100vh - 230px) * {(placementArea.width / Math.max(1, placementArea.height)).toFixed(4)}));"
        bind:clientWidth={previewW}
      >
        <img
          src={SETUP_OVERLAY_BG_URLS[placementStep.key] || SETUP_OVERLAY_BG_URLS.reward}
          alt=""
          draggable="false"
          class="absolute inset-0 h-full w-full select-none object-cover opacity-80"
        />
        <div class="absolute inset-0 bg-black/20"></div>
        {#if placementPos && previewScale > 0}
          {#each placementStep.dummies as key (placementStep.key + "-" + key)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              data-placement-dummy={key}
              class="absolute flex cursor-move touch-none select-none flex-col overflow-hidden rounded border bg-bg-deep/85 shadow-lg {dragging?.key === key
                ? 'border-accent ring-1 ring-accent'
                : 'border-border-strong hover:border-accent'}"
              style="left: {placementPos[key].x * previewScale}px; top: {placementPos[key].y * previewScale}px; width: {placementPos[key].width * previewScale}px; height: {placementPos[key].height * previewScale}px;"
              on:pointerdown={(e) => onDummyPointerDown(key, e)}
              on:pointermove={onDummyPointerMove}
              on:pointerup={onDummyPointerUp}
              on:pointercancel={() => (dragging = null)}
            >
              <div class="flex items-center justify-between gap-2 border-b border-border bg-bg-surface/90 px-2 py-1">
                <span class="truncate font-display text-[10px] font-bold tracking-widest text-accent">{dummyLabels[key]}</span>
                <span class="shrink-0 text-[9px] uppercase tracking-wider text-text-muted">drag me</span>
              </div>
              <div class="min-h-0 flex-1 p-1.5 opacity-80">
                {#if key === "reward"}
                  <div class="flex h-full gap-1.5">
                    {#each Array(4) as _}
                      <div class="flex flex-1 flex-col gap-1 rounded-sm border border-border/60 bg-bg-raised/70 p-1">
                        <div class="mx-auto h-2/5 w-3/5 rounded-sm bg-bg-hover"></div>
                        <div class="h-1.5 w-full rounded-sm bg-bg-hover"></div>
                        <div class="h-1.5 w-2/3 rounded-sm bg-bg-hover"></div>
                      </div>
                    {/each}
                  </div>
                {:else if key === "planner"}
                  <div class="flex h-full flex-col gap-1.5">
                    {#each Array(3) as _}
                      <div class="flex items-center gap-1.5 rounded-sm border border-border/60 bg-bg-raised/70 px-1.5 py-2">
                        <div class="h-1.5 flex-1 rounded-sm bg-bg-hover"></div>
                        <div class="h-1.5 w-8 shrink-0 rounded-sm bg-bg-hover"></div>
                      </div>
                    {/each}
                  </div>
                {:else if key === "arbiSummary"}
                  <div class="grid h-full grid-cols-2 gap-1.5">
                    {#each Array(4) as _}
                      <div class="flex flex-col justify-center gap-1 rounded-sm border border-border/60 bg-bg-raised/70 px-1.5">
                        <div class="h-1.5 w-1/2 rounded-sm bg-bg-hover"></div>
                        <div class="h-2 w-2/3 rounded-sm bg-bg-hover"></div>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="flex h-full flex-col gap-1.5">
                    <div class="h-1/4 shrink-0 rounded-sm border border-border/60 bg-bg-raised/70"></div>
                    {#each Array(5) as _}
                      <div class="flex items-center gap-1.5 px-0.5">
                        <div class="h-1.5 flex-1 rounded-sm bg-bg-hover"></div>
                        <div class="h-1.5 w-6 shrink-0 rounded-sm bg-bg-hover"></div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="w-[560px] max-w-full shrink-0 rounded-xl border border-border bg-bg-surface p-4 shadow-2xl">
        <div class="mb-1 flex items-center justify-between gap-3">
          <h2 class="m-0 font-display text-base font-bold tracking-[0.02em]">{placementStep.title}</h2>
          <span class="shrink-0 text-xs text-text-muted">{overlayStepIndex + 1} / {overlayPlacementSteps.length}</span>
        </div>
        <p class="m-0 text-sm leading-snug text-text-secondary">{placementStep.text}</p>
        <p class="m-0 mt-1.5 text-xs leading-snug text-text-muted">
          Saved instantly. In game you can move overlays any time: unlock with the hotkey shown on them, then drag with either mouse button.
        </p>
        <div class="mt-2.5 flex items-center gap-3">
          <span class="shrink-0 text-xs text-text-muted">Size</span>
          <input
            type="range"
            min="0.75"
            max="1.5"
            step="0.05"
            value={stepScale}
            disabled={!placementPos}
            on:input={(e) => applyScalePreview(Number(e.currentTarget.value))}
            on:change={commitScale}
            class="h-1.5 flex-1 cursor-pointer"
            style="accent-color: var(--accent);"
          />
          <span class="w-10 shrink-0 text-right text-xs text-text-muted">{Math.round(stepScale * 100)}%</span>
        </div>
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
