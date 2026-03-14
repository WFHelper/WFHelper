<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { onInventoryLoaded } from "../lib/actions.js";
  import { currentView, statusText } from "../stores/app.js";
  import { ipc } from "../lib/ipc.js";
  import type { HelperStatus } from "../types/ipc.js";

  let helperStatus: "checking" | "found" | "not_found" | "error" = "checking";
  let helperPath: string | null = null;
  let loadingApi = false;
  let runnerStatus: HelperStatus | null = null;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  onMount(async () => {
    await refreshHelperStatus();
    // Also get runner status
    try {
      runnerStatus = await ipc.getHelperStatus();
    } catch { /* ignore */ }

    if (destroyed) return;

    // Poll for inventory appearing (helper runs in background)
    pollingTimer = setInterval(async () => {
      await refreshHelperStatus();
      // If inventory appeared, auto-load it
      if (helperStatus === "found" && !loadingApi) {
        await loadApiHelper(false);
      }
    }, 5000);
  });

  onDestroy(() => {
    destroyed = true;
    if (pollingTimer) clearInterval(pollingTimer);
  });

  async function refreshHelperStatus() {
    try {
      const status = await ipc.getInventoryStatus();
      if (status?.found) {
        helperStatus = "found";
        helperPath = status.path || null;
      } else {
        helperStatus = "not_found";
        helperPath = null;
      }
    } catch (error) {
      helperStatus = "error";
      helperPath = null;
      console.error("[Welcome] getInventoryStatus failed:", error);
    }
  }

  function getLoadErrorMessage(data: unknown): string | null {
    if (!data || typeof data !== "object" || !("error" in data)) return null;
    const error = (data as { error?: unknown }).error;
    return typeof error === "string" ? error : null;
  }

  async function loadApiHelper(preferPicker = false) {
    loadingApi = true;
    statusText.set("Loading inventory.json from warframe-api-helper...");
    try {
      let data = null;
      let errorMessage: string | null = null;

      if (!preferPicker) {
        data = await ipc.getInventory();
        errorMessage = getLoadErrorMessage(data);
      }

      if (!data || errorMessage) {
        data = await ipc.openInventoryFile();
        errorMessage = getLoadErrorMessage(data);
      }

      if (data && !errorMessage) {
        await onInventoryLoaded(data);
        if (!destroyed) {
          currentView.set("inventory");
        }
        await refreshHelperStatus();
      } else {
        statusText.set(errorMessage || "Failed to load inventory JSON");
      }
    } catch (error) {
      statusText.set(`Inventory load error: ${(error as Error).message}`);
    } finally {
      loadingApi = false;
    }
  }

  async function triggerHelperRun() {
    try {
      statusText.set("Running warframe-api-helper...");
      await ipc.runHelperNow();
      statusText.set("Helper finished — waiting for inventory...");
    } catch {
      statusText.set("Failed to run helper");
    }
  }
</script>

<section class="view active">
  <div class="welcome-card">
    <div class="welcome-icon">
      <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.5">
        <polygon points="40,5 75,65 5,65" stroke-width="2"/>
        <circle cx="40" cy="45" r="10" stroke-width="2"/>
        <line x1="40" y1="20" x2="40" y2="30" stroke-width="2"/>
      </svg>
    </div>
    <h1>Welcome, Tenno</h1>
    <p>Choose how to load your Warframe inventory data.</p>

    <div class="source-cards">

      {#if helperStatus === "not_found" && runnerStatus?.exeFound}
        <div class="source-card" style="border-color: var(--accent-warning, #f59e0b); background: rgba(245, 158, 11, 0.06);">
          <div class="source-header">
            <span class="source-badge" style="background: var(--accent-warning, #f59e0b); color: #000;">WAITING FOR DATA</span>
            <h3>Go in-game to generate inventory data</h3>
            <p class="source-desc">
              The helper is running in the background. Log into Warframe and it will automatically fetch your inventory.
              This page will update automatically once data is available.
            </p>
          </div>
          <div class="source-actions">
            <button class="btn-primary btn-sm" on:click={triggerHelperRun}>
              Run helper now
            </button>
            <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>
              Browse for JSON
            </button>
          </div>
        </div>
      {/if}

      <div class="source-card">
        <div class="source-header">
          <span class="source-badge">RECOMMENDED</span>
          <h3>warframe-api-helper</h3>
          <p class="source-desc">Use the official API snapshot (`inventory.json`) as the primary source.</p>
        </div>

        <div class="source-status">
          {#if helperStatus === "checking"}
            <span class="status-checking">Checking…</span>
          {:else if helperStatus === "found"}
            <span class="status-ok">Found inventory.json</span>
          {:else if helperStatus === "not_found"}
            <span class="status-warn">No auto-detected inventory.json</span>
          {:else}
            <span class="status-error">Inventory detection failed</span>
          {/if}
        </div>

        {#if helperPath}
          <div class="source-fallback">
            <p class="source-desc">Detected path: <code>{helperPath}</code></p>
          </div>
        {/if}

        <div class="source-steps-mini">
          <!-- svelte-ignore a11y-invalid-attribute -->
          <span>1. <a href="#" on:click|preventDefault={() => ipc.openExternal('https://github.com/Sainan/warframe-api-helper/releases')}>Download warframe-api-helper</a></span>
          <span>2. Run it while Warframe is open</span>
          <span>3. Load the generated <code>inventory.json</code></span>
        </div>
        <div class="source-actions">
          <button class="btn-primary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(false)}>
            {loadingApi ? "Loading..." : helperPath ? "Load detected inventory.json" : "Select inventory.json"}
          </button>
          <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>
            Browse for JSON
          </button>
        </div>
      </div>

      <!-- Manual JSON Source -->
      <div class="source-card source-card-compact">
        <div class="source-header">
          <h3>Legacy Sources</h3>
          <p class="source-desc">Only use this if your API-helper file is unavailable.</p>
        </div>
        <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>Browse for File</button>
      </div>

    </div>
  </div>
</section>
