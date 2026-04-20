<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { onInventoryLoaded } from "../lib/actions.js";
  import { currentView, statusText } from "../stores/app.js";
  import { invoke, on, send } from "../lib/ipc.js";
  import type { HelperStatus } from "../types/ipc.js";

  let helperStatus: "checking" | "found" | "not_found" | "error" = "checking";
  let helperPath: string | null = null;
  let loadingApi = false;
  let runnerStatus: HelperStatus | null = null;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  onMount(async () => {
    // Listen for inventory push from main process (covers race condition
    // where auto-detect happens before renderer IPC is ready)
    const removeInventoryListener = on("inventory-updated", async (data) => {
      if (destroyed || loadingApi) return;
      try {
        await onInventoryLoaded(data);
        if (!destroyed) {
          currentView.set("inventory");
        }
      } catch {
        // ignore — user can still load manually
      }
    });

    await refreshHelperStatus();
    // Also get runner status
    try {
      runnerStatus = await invoke("getHelperStatus");
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

    // Store cleanup ref
    _removeInventoryListener = removeInventoryListener;
  });

  let _removeInventoryListener: (() => void) | null = null;

  onDestroy(() => {
    destroyed = true;
    if (pollingTimer) clearInterval(pollingTimer);
    _removeInventoryListener?.();
  });

  async function refreshHelperStatus() {
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
      // Only show "error" state on first check; keep previous state on polling errors
      if (helperStatus === "checking") {
        helperStatus = "error";
      }
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
        data = await invoke("getInventory");
        errorMessage = getLoadErrorMessage(data);
      }

      if (!data || errorMessage) {
        data = await invoke("openInventoryFile");
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
      await invoke("runHelperNow");
      statusText.set("Helper finished — waiting for inventory...");
    } catch {
      statusText.set("Failed to run helper");
    }
  }
</script>

<section class="view active">
  <div class="mx-auto max-w-[740px] text-center">
    <div class="mb-4">
      <img src={new URL("../../assets/logo.png", import.meta.url).href} alt="App Logo" class="mx-auto h-20 w-20 object-contain" />
    </div>
    <h1 class="mb-2 font-display text-[2rem] font-bold tracking-wide">Welcome, Tenno</h1>
    <p class="mb-6 text-text-secondary">Choose how to load your Warframe inventory data.</p>

    <div class="grid gap-3 text-left">

      {#if helperStatus === "not_found" && runnerStatus?.exeFound}
        <div class="rounded-xl border border-border bg-bg-surface px-4 py-4" style="border-color: var(--accent-warning, #f59e0b); background: rgba(245, 158, 11, 0.06);">
          <div>
            <span class="mb-1 inline-block rounded bg-[#f59e0b] px-2 py-0.5 font-display text-[0.65rem] font-bold tracking-widest text-black">WAITING FOR DATA</span>
            <h3 class="font-display text-base font-semibold">Go in-game to generate inventory data</h3>
            <p class="mt-0.5 text-sm leading-snug text-text-secondary">
              The helper is running in the background. Log into Warframe and it will automatically fetch your inventory.
              This page will update automatically once data is available.
            </p>
          </div>
          <div class="mt-2">
            <button class="btn-primary btn-sm" on:click={triggerHelperRun}>
              Run helper now
            </button>
            <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>
              Browse for JSON
            </button>
          </div>
        </div>
      {/if}

      <div class="rounded-xl border border-border bg-bg-surface px-4 py-4 hover:border-border-strong">
        <div>
          <span class="mb-1 inline-block rounded bg-success/15 px-2 py-0.5 font-display text-[0.65rem] font-bold tracking-widest text-success">RECOMMENDED</span>
          <h3 class="font-display text-base font-semibold">warframe-api-helper</h3>
          <p class="mt-0.5 text-sm leading-snug text-text-secondary">Use the official API snapshot (`inventory.json`) as the primary source.</p>
        </div>

        <div class="mt-2">
          {#if helperStatus === "checking"}
            <span class="text-text-muted">Checking…</span>
          {:else if helperStatus === "found"}
            <span class="text-success">Found inventory.json</span>
          {:else if helperStatus === "not_found"}
            <span class="text-text-muted">No auto-detected inventory.json</span>
          {:else}
            <span class="text-danger">Inventory detection failed</span>
          {/if}
        </div>

        {#if helperPath}
          <div class="mt-2">
            <p class="mt-0.5 text-sm leading-snug text-text-secondary">Detected path: <code class="rounded bg-bg-raised px-1.5 py-0.5 text-xs text-accent">{helperPath}</code></p>
          </div>
        {/if}

        <div class="mt-2 grid gap-1 text-sm text-text-secondary">
          <!-- svelte-ignore a11y-invalid-attribute -->
          <span>1. <a href="#" on:click|preventDefault={() => send('open-external', 'https://github.com/Sainan/warframe-api-helper/releases')}>Download warframe-api-helper</a></span>
          <span>2. Run it while Warframe is open</span>
          <span>3. Load the generated <code class="rounded bg-bg-raised px-1.5 py-0.5 text-xs text-accent">inventory.json</code></span>
        </div>
        <div class="mt-2">
          <button class="btn-primary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(false)}>
            {loadingApi ? "Loading..." : helperPath ? "Load detected inventory.json" : "Select inventory.json"}
          </button>
          <button class="btn-secondary btn-sm" disabled={loadingApi} on:click={() => loadApiHelper(true)}>
            Browse for JSON
          </button>
        </div>
      </div>

      <!-- Manual JSON Source -->
      <div class="rounded-xl border border-border bg-bg-surface px-4 py-3.5 hover:border-border-strong">
        <div>
          <h3 class="font-display text-base font-semibold">Legacy Sources</h3>
          <p class="mt-0.5 text-sm leading-snug text-text-secondary">Only use this if your API-helper file is unavailable.</p>
        </div>
        <button class="btn-secondary btn-sm mt-2" disabled={loadingApi} on:click={() => loadApiHelper(true)}>Browse for File</button>
      </div>

    </div>
  </div>
</section>
