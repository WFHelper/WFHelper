<script lang="ts">
  import { onDestroy } from "svelte";
  import { currentView } from "../stores/app.js";
  import { invoke, on } from "../lib/ipc.js";
  import type { HelperDownloadProgress } from "../types/ipc.js";

  type Step = "welcome" | "consent" | "downloading" | "done" | "error";

  let step: Step = "welcome";
  let progress: HelperDownloadProgress | null = null;
  let errorMessage = "";

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

  function finish() {
    localStorage.setItem("setup-completed", "1");
    currentView.set("welcome");
  }

  function skip() {
    localStorage.setItem("setup-completed", "1");
    currentView.set("welcome");
  }

  function retry() {
    step = "consent";
    errorMessage = "";
    progress = null;
  }

  $: progressPercent = progress?.percent ?? 0;
  $: bytesLabel = progress
    ? `${(progress.bytesReceived / 1024 / 1024).toFixed(1)} / ${(progress.bytesTotal / 1024 / 1024).toFixed(1)} MB`
    : "";
</script>

<section class="view active">
  <div class="flex max-w-[680px] mx-auto my-8 border border-border rounded-xl bg-bg-surface overflow-hidden min-h-[380px]">
    <!-- Left panel — branding -->
    <div class="setup-left w-[190px] shrink-0 flex flex-col items-center pt-7 px-4 pb-6 bg-gradient-to-b from-bg-deep to-bg-raised border-r border-border">
      <div class="setup-logo">
        <svg class="w-14 h-14 text-accent opacity-70" viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="40,5 75,65 5,65" stroke-width="2"/>
          <circle cx="40" cy="45" r="10" stroke-width="2"/>
          <line x1="40" y1="20" x2="40" y2="30" stroke-width="2"/>
        </svg>
      </div>
      <div class="mt-8 flex flex-col gap-4 w-full">
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'welcome' ? 'text-accent font-semibold' : 'text-success'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'welcome' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : 'bg-success'}"></span> Welcome
        </div>
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'consent' ? 'text-accent font-semibold' : (step === 'downloading' || step === 'done') ? 'text-success' : 'text-text-muted'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'consent' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : (step === 'downloading' || step === 'done') ? 'bg-success' : 'bg-text-muted'}"></span> Component Setup
        </div>
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'downloading' ? 'text-accent font-semibold' : step === 'done' ? 'text-success' : 'text-text-muted'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'downloading' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : step === 'done' ? 'bg-success' : 'bg-text-muted'}"></span> Download
        </div>
        <div class="flex items-center gap-2 text-[0.78rem] transition-colors duration-200 {step === 'done' ? 'text-accent font-semibold' : 'text-text-muted'}">
          <span class="w-2 h-2 rounded-full shrink-0 transition-[background] duration-200 {step === 'done' ? 'bg-accent shadow-[0_0_6px_var(--accent)]' : 'bg-text-muted'}"></span> Finish
        </div>
      </div>
    </div>

    <!-- Right panel — content -->
    <div class="flex-1 flex flex-col pt-7 px-6 pb-5">
      <div class="setup-content flex-1">
        {#if step === "welcome"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Welcome to Warframe Companion</h2>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">This setup wizard will help you configure the required components to get started.</p>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">Warframe Companion uses <strong>warframe-api-helper</strong> to read your in-game inventory data. This small tool needs to be downloaded once (~1 MB).</p>
          <p class="!text-text-muted !text-[0.78rem] !mt-4">Click <strong>Next</strong> to continue, or <strong>Skip</strong> if you already have it installed.</p>
        {:else if step === "consent"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Download warframe-api-helper</h2>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">The following component will be downloaded from GitHub:</p>
          <div class="border border-border rounded-lg bg-bg-raised py-[0.65rem] px-[0.85rem] my-3">
            <div class="flex justify-between items-center">
              <span class="font-display text-[0.84rem] font-semibold text-text-primary">warframe-api-helper.exe</span>
              <span class="text-xs text-text-muted">~1 MB</span>
            </div>
            <span class="block mt-1 text-[0.72rem] text-text-muted">Source: github.com/Sainan/warframe-api-helper</span>
          </div>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">This tool connects to the Warframe API to fetch your inventory data. It runs silently in the background every 10 minutes while the app is open.</p>
          <p class="!text-text-muted !text-[0.78rem] !mt-4">Click <strong>Install</strong> to download, or <strong>Skip</strong> to set it up yourself later.</p>
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
          <p class="!text-text-muted !text-[0.78rem] !mt-4">Click <strong>Finish</strong> to start using Warframe Companion.</p>
        {:else if step === "error"}
          <h2 class="mb-3 font-display text-[1.2rem] font-bold tracking-[0.02em]">Download Failed</h2>
          <p class="!text-danger !font-semibold mb-[0.65rem] text-[0.84rem] leading-[1.55]">{errorMessage}</p>
          <p class="mb-[0.65rem] text-[0.84rem] text-text-secondary leading-[1.55]">You can retry the download, or skip and manually download <strong>warframe-api-helper</strong> from GitHub later.</p>
        {/if}
      </div>

      <!-- Bottom button bar -->
      <div class="flex justify-end gap-2 pt-4 border-t border-border mt-2">
        {#if step === "welcome"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={() => (step = "consent")}>Next &gt;</button>
        {:else if step === "consent"}
          <button class="btn-secondary btn-sm" on:click={skip}>Skip</button>
          <button class="btn-primary btn-sm" on:click={startDownload}>Install</button>
        {:else if step === "downloading"}
          <span></span>
          <!-- no buttons during download -->
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

