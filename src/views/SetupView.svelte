<script lang="ts">
  import { onDestroy } from "svelte";
  import { onInventoryLoaded } from "../lib/actions.js";
  import { PRESET_KEYS, THEME_PRESETS } from "../config/themePresets.js";
  import { currentView } from "../stores/app.js";
  import { themeSettings } from "../stores/theme.js";
  import { invoke, on } from "../lib/ipc.js";
  import {
    hasInventoryShape,
    unwrapInventoryPayload as unwrapSharedInventoryPayload,
  } from "../../config/shared/inventoryPayload.js";
  import type { ThemeCornerStyle, ThemeSurfaceStyle } from "../types/theme.js";
  import type { RawInventoryData } from "../types/inventory.js";
  import type { HelperDownloadProgress } from "../types/ipc.js";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import BuiltInThemeDropdown from "../components/settings/BuiltInThemeDropdown.svelte";

  type Step = "configure" | "downloading" | "done" | "error";
  type InventorySource = "helper" | "import";

  let step: Step = "configure";
  let inventorySource: InventorySource = "helper";
  let progress: HelperDownloadProgress | null = null;
  let errorMessage = "";

  const sourceOptions: Array<{ value: InventorySource; label: string }> = [
    { value: "helper", label: "Install API helper" },
    { value: "import", label: "Import inventory JSON" },
  ];
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

  const unsubProgress = on("helper-download-progress", (p) => {
    progress = p;
    if (p.stage === "done") {
      step = "done";
    } else if (p.stage === "error") {
      step = "error";
      errorMessage = p.error || "Download failed";
    }
  });

  onDestroy(() => {
    unsubProgress();
  });

  async function startDownload() {
    step = "downloading";
    progress = null;
    const result = await invoke("downloadHelper");
    if (!result.ok && step === "downloading") {
      step = "error";
      errorMessage = "Download failed — check your internet connection.";
    }
  }

  async function importInventory() {
    try {
      const data = await invoke("openInventoryFile");
      if (!data || (typeof data === "object" && data !== null && "error" in data)) {
        errorMessage = "Inventory import failed. Choose an inventory JSON export and try again.";
        step = "error";
        return;
      }

      const unwrapped = unwrapSharedInventoryPayload(data, { returnInputOnFailure: false });
      if (!hasInventoryShape(unwrapped)) {
        errorMessage =
          "That file does not look like an inventory JSON export. AlecaFrame stats/trade exports are not inventory imports.";
        step = "error";
        return;
      }

      await onInventoryLoaded(unwrapped as RawInventoryData);
      completeSetup("inventory");
    } catch (error) {
      errorMessage = `Inventory import failed: ${(error as Error).message}`;
      step = "error";
    }
  }

  async function continueSetup() {
    if (inventorySource === "helper") {
      await startDownload();
      return;
    }

    await importInventory();
  }

  function completeSetup(nextView: "welcome" | "inventory" = "welcome") {
    localStorage.setItem("setup-completed", "1");
    currentView.set(nextView);
  }

  function finish() {
    completeSetup("welcome");
  }

  function skip() {
    completeSetup("welcome");
  }

  function retry() {
    step = "configure";
    errorMessage = "";
    progress = null;
  }

  $: effects = $themeSettings.effects;
  $: activePresetKey = PRESET_KEYS.includes($themeSettings.activePreset)
    ? $themeSettings.activePreset
    : "default";
  $: activePreset = THEME_PRESETS[activePresetKey] ?? THEME_PRESETS.default;

  $: progressPercent = progress?.percent ?? 0;
  $: bytesLabel = progress
    ? `${(progress.bytesReceived / 1024 / 1024).toFixed(1)} / ${(progress.bytesTotal / 1024 / 1024).toFixed(1)} MB`
    : "";
</script>

<section class="view active">
  <div class="flex max-w-[760px] mx-auto my-8 border border-border rounded-xl bg-bg-surface overflow-hidden min-h-[430px]">
    <div class="setup-left w-[190px] shrink-0 flex flex-col items-center pt-7 px-4 pb-6 bg-gradient-to-b from-bg-deep to-bg-raised border-r border-border">
      <div class="setup-logo">
        <img src={new URL("../../assets/logo.png", import.meta.url).href} alt="App Logo" class="w-14 h-14 object-contain" />
      </div>
      <div class="mt-8 flex flex-col gap-4 w-full">
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'configure' ? 'text-accent font-semibold' : step === 'error' ? 'text-danger' : 'text-success'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'configure' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : step === 'error' ? 'bg-danger' : 'bg-success'}"></span> Configure
        </div>
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'downloading' ? 'text-accent font-semibold' : step === 'done' ? 'text-success' : 'text-text-muted'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'downloading' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : step === 'done' ? 'bg-success' : 'bg-text-muted'}"></span> Inventory Source
        </div>
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'done' ? 'text-accent font-semibold' : 'text-text-muted'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'done' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : 'bg-text-muted'}"></span> Finish
        </div>
      </div>
    </div>

    <div class="flex-1 flex flex-col pt-7 px-6 pb-5">
      <div class="setup-content flex-1">
        {#if step === "configure"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Welcome to WFhelper</h2>

          <div class="grid gap-3">
            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-[0.92rem] font-semibold text-text-primary">Inventory source</h3>
                  <p class="mt-0.5 text-[0.76rem] leading-snug text-text-muted">Choose the first data path for this install.</p>
                </div>
              </div>
              <SegmentedControl value={inventorySource} options={sourceOptions} onChange={(value) => (inventorySource = value)} />
              <div class="mt-2 text-[0.78rem] leading-snug text-text-secondary">
                {#if inventorySource === "helper"}
                  Downloads warframe-api-helper and uses its inventory JSON on startup.
                {:else}
                  Opens an existing inventory JSON export now. AlecaFrame stats/trade exports belong in Stats.
                {/if}
              </div>
            </div>

            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-[0.92rem] font-semibold text-text-primary">Default theme</h3>
                  <p class="mt-0.5 text-[0.76rem] leading-snug text-text-muted">Choose one of the built-in themes.</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <BuiltInThemeDropdown
                  activePreset={activePresetKey}
                  label="Built-in themes"
                  fallbackLabel={activePreset.label}
                  className="w-full"
                  onSelect={(presetKey) => themeSettings.applyPreset(presetKey)}
                />
              </div>
            </div>

            <div class="rounded-lg border border-border bg-bg-raised px-3 py-3">
              <div class="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 class="m-0 font-display text-[0.92rem] font-semibold text-text-primary">UI style</h3>
                  <p class="mt-0.5 text-[0.76rem] leading-snug text-text-muted">Uses the same setting as Appearance.</p>
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
                  <h3 class="m-0 font-display text-[0.92rem] font-semibold text-text-primary">Border style</h3>
                  <p class="mt-0.5 text-[0.76rem] leading-snug text-text-muted">Choose how sharp or rounded app controls should feel.</p>
                </div>
              </div>
              <SegmentedControl
                value={effects.cornerStyle}
                options={cornerOptions}
                onChange={(cornerStyle) => themeSettings.setEffects({ cornerStyle })}
              />
            </div>
          </div>
        {:else if step === "downloading"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Downloading…</h2>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">Fetching warframe-api-helper from GitHub Releases.</p>
          <div class="my-4">
            <div class="h-2 rounded bg-bg-raised overflow-hidden border border-border">
              <div class="h-full bg-accent rounded transition-[width] duration-300 ease-in-out" style="width: {progressPercent}%"></div>
            </div>
            <div class="flex justify-between mt-[0.35rem] text-xs text-text-muted">
              <span>{progressPercent}%</span>
              <span>{bytesLabel}</span>
            </div>
          </div>
          <p class="!text-text-muted !text-[0.78rem] !mt-4">Please wait — this should only take a moment.</p>
        {:else if step === "done"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Setup Complete</h2>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">warframe-api-helper has been downloaded and is ready to use.</p>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">The helper will run automatically in the background every 10 minutes to keep your inventory data fresh. Make sure Warframe is running for it to work.</p>
          <div class="flex justify-center my-4">
            <svg class="w-10 h-10 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <p class="!text-text-muted !text-[0.78rem] !mt-4">Click <strong>Finish</strong> to start using WFHelper.</p>
        {:else if step === "error"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Setup Needs Attention</h2>
          <p class="!text-danger !font-semibold mb-[0.65rem] text-[0.84rem] leading-[1.55]">{errorMessage}</p>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">You can retry this setup path or skip and configure inventory loading later.</p>
        {/if}
      </div>

      <div class="flex justify-end gap-2 pt-4 border-t border-border mt-2">
        {#if step === "configure"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={continueSetup}>{inventorySource === "helper" ? "Install" : "Import"}</button>
        {:else if step === "downloading"}
          <span></span>
        {:else if step === "done"}
          <span></span>
          <button class="btn-primary btn-sm" on:click={finish}>Finish</button>
        {:else if step === "error"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={retry}>Retry</button>
        {/if}
      </div>
    </div>
  </div>
</section>

