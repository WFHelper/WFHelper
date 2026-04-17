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
  <div class="setup-wizard">
    <!-- Left panel — branding -->
    <div class="setup-left">
      <div class="setup-logo">
        <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="40,5 75,65 5,65" stroke-width="2"/>
          <circle cx="40" cy="45" r="10" stroke-width="2"/>
          <line x1="40" y1="20" x2="40" y2="30" stroke-width="2"/>
        </svg>
      </div>
      <div class="setup-steps">
        <div class="setup-step" class:active={step === "welcome"} class:done={step !== "welcome"}>
          <span class="step-dot"></span> Welcome
        </div>
        <div class="setup-step" class:active={step === "consent"} class:done={step === "downloading" || step === "done"}>
          <span class="step-dot"></span> Component Setup
        </div>
        <div class="setup-step" class:active={step === "downloading"} class:done={step === "done"}>
          <span class="step-dot"></span> Download
        </div>
        <div class="setup-step" class:active={step === "done"}>
          <span class="step-dot"></span> Finish
        </div>
      </div>
    </div>

    <!-- Right panel — content -->
    <div class="setup-right">
      <div class="setup-content">
        {#if step === "welcome"}
          <h2>Welcome to Warframe Companion</h2>
          <p>This setup wizard will help you configure the required components to get started.</p>
          <p>Warframe Companion uses <strong>warframe-api-helper</strong> to read your in-game inventory data. This small tool needs to be downloaded once (~1 MB).</p>
          <p class="setup-hint">Click <strong>Next</strong> to continue, or <strong>Skip</strong> if you already have it installed.</p>
        {:else if step === "consent"}
          <h2>Download warframe-api-helper</h2>
          <p>The following component will be downloaded from GitHub:</p>
          <div class="setup-component-box">
            <div class="component-row">
              <span class="component-name">warframe-api-helper.exe</span>
              <span class="component-size">~1 MB</span>
            </div>
            <span class="component-source">Source: github.com/Sainan/warframe-api-helper</span>
          </div>
          <p>This tool connects to the Warframe API to fetch your inventory data. It runs silently in the background every 10 minutes while the app is open.</p>
          <p class="setup-hint">Click <strong>Install</strong> to download, or <strong>Skip</strong> to set it up yourself later.</p>
        {:else if step === "downloading"}
          <h2>Downloading…</h2>
          <p>Fetching warframe-api-helper from GitHub Releases.</p>
          <div class="setup-progress-container">
            <div class="setup-progress-bar">
              <div class="setup-progress-fill" style="width: {progressPercent}%"></div>
            </div>
            <div class="setup-progress-info">
              <span>{progressPercent}%</span>
              <span>{bytesLabel}</span>
            </div>
          </div>
          <p class="setup-hint">Please wait — this should only take a moment.</p>
        {:else if step === "done"}
          <h2>Setup Complete</h2>
          <p>warframe-api-helper has been downloaded and is ready to use.</p>
          <p>The helper will run automatically in the background every 10 minutes to keep your inventory data fresh. Make sure Warframe is running for it to work.</p>
          <div class="setup-done-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <p class="setup-hint">Click <strong>Finish</strong> to start using Warframe Companion.</p>
        {:else if step === "error"}
          <h2>Download Failed</h2>
          <p class="setup-error-msg">{errorMessage}</p>
          <p>You can retry the download, or skip and manually download <strong>warframe-api-helper</strong> from GitHub later.</p>
        {/if}
      </div>

      <!-- Bottom button bar -->
      <div class="setup-buttons">
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

<style>
  .setup-wizard {
    display: flex;
    max-width: 680px;
    margin: 2rem auto;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--bg-surface);
    overflow: hidden;
    min-height: 380px;
  }

  /* ── Left panel ── */
  .setup-left {
    width: 190px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1.75rem 1rem 1.5rem;
    background: linear-gradient(180deg, var(--bg-deep) 0%, var(--bg-raised) 100%);
    border-right: 1px solid var(--border);
  }

  .setup-logo svg {
    width: 3.5rem;
    height: 3.5rem;
    color: var(--accent);
    opacity: 0.7;
  }

  .setup-steps {
    margin-top: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
  }

  .setup-step {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: var(--text-muted);
    transition: color 0.2s;
  }
  .setup-step.active {
    color: var(--accent);
    font-weight: 600;
  }
  .setup-step.done {
    color: var(--success);
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .setup-step.active .step-dot {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }
  .setup-step.done .step-dot {
    background: var(--success);
  }

  /* ── Right panel ── */
  .setup-right {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 1.75rem 1.5rem 1.25rem;
  }

  .setup-content {
    flex: 1;
  }

  .setup-content h2 {
    margin: 0 0 0.75rem;
    font-family: var(--font-display);
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .setup-content p {
    margin: 0 0 0.65rem;
    font-size: 0.84rem;
    color: var(--text-secondary);
    line-height: 1.55;
  }

  .setup-hint {
    color: var(--text-muted) !important;
    font-size: 0.78rem !important;
    margin-top: 1rem !important;
  }

  /* ── Component box ── */
  .setup-component-box {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-raised);
    padding: 0.65rem 0.85rem;
    margin: 0.75rem 0;
  }

  .component-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .component-name {
    font-family: var(--font-display);
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .component-size {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .component-source {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  /* ── Progress bar ── */
  .setup-progress-container {
    margin: 1rem 0;
  }

  .setup-progress-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-raised);
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .setup-progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .setup-progress-info {
    display: flex;
    justify-content: space-between;
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* ── Done icon ── */
  .setup-done-icon {
    display: flex;
    justify-content: center;
    margin: 1rem 0;
  }
  .setup-done-icon svg {
    width: 2.5rem;
    height: 2.5rem;
    color: var(--success);
  }

  /* ── Error ── */
  .setup-error-msg {
    color: var(--danger) !important;
    font-weight: 600;
  }

  /* ── Buttons ── */
  .setup-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    margin-top: 0.5rem;
  }
</style>
