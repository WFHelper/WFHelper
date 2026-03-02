<script lang="ts">
  import { onMount } from "svelte";
  import { onInventoryLoaded } from "../lib/actions.js";
  import { statusText } from "../stores/app.js";
  import { ipc } from "../lib/ipc.js";

  // 'checking' | 'found' | 'not_found' | 'error'
  let alecaStatus: "checking" | "found" | "not_found" | "error" = "checking";
  let loadingAleca = false;

  onMount(async () => {
    try {
      const result = await ipc.checkAlecaFrame();
      if (result && result.found) {
        alecaStatus = 'found';
      } else {
        alecaStatus = 'not_found';
      }
    } catch (e) {
      alecaStatus = 'error';
      console.error('[Welcome] checkAlecaFrame failed:', e);
    }
  });

  async function loadAlecaFrame() {
    loadingAleca = true;
    statusText.set('Loading from AlecaFrame…');
    try {
      const result = await ipc.loadAlecaFrame();
      if (result && result.success && result.data) {
        await onInventoryLoaded(result.data);
      } else {
        statusText.set(result?.error || 'AlecaFrame load failed');
        alecaStatus = 'error';
      }
    } catch (e) {
      statusText.set(`AlecaFrame error: ${(e as Error).message}`);
      alecaStatus = 'error';
    } finally {
      loadingAleca = false;
    }
  }

  async function loadAlecaJson() {
    const data = await ipc.openAlecaFrameJson();
    if (data && !data.error) await onInventoryLoaded(data);
  }

  async function loadApiHelper() {
    const data = await ipc.openInventoryFile();
    if (data && !data.error) await onInventoryLoaded(data);
  }

  async function loadManual() {
    const data = await ipc.openInventoryFile();
    if (data && !data.error) await onInventoryLoaded(data);
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

      <!-- AlecaFrame Source -->
      <div class="source-card">
        <div class="source-header">
          <span class="source-badge">RECOMMENDED</span>
          <h3>AlecaFrame</h3>
          <p class="source-desc">Auto-detect from your existing AlecaFrame installation.</p>
        </div>

        <div class="source-status">
          {#if alecaStatus === 'checking'}
            <span class="status-checking">Checking…</span>
          {:else if alecaStatus === 'found'}
            <span class="status-ok">Found AlecaFrame data</span>
          {:else if alecaStatus === 'not_found'}
            <span class="status-warn">AlecaFrame not detected</span>
          {:else}
            <span class="status-error">Detection failed</span>
          {/if}
        </div>

        {#if alecaStatus === 'found'}
          <div class="source-actions">
            <button class="btn-primary btn-sm" disabled={loadingAleca} on:click={loadAlecaFrame}>
              {loadingAleca ? 'Loading…' : 'Load from AlecaFrame'}
            </button>
          </div>
        {/if}

        <div class="source-fallback">
          <p class="source-desc">
            If auto-decrypt fails, use the
            <!-- svelte-ignore a11y-invalid-attribute -->
            <a href="#" on:click|preventDefault={() => ipc.openExternal('https://sainan.github.io/alecaframe-inventory-parser/')}>web parser</a>
            to decrypt your <code>lastData.dat</code>, then:
          </p>
          <button class="btn-secondary btn-sm" on:click={loadAlecaJson}>Load Decrypted JSON</button>
        </div>
      </div>

      <!-- warframe-api-helper Source -->
      <div class="source-card">
        <div class="source-header">
          <h3>warframe-api-helper</h3>
          <p class="source-desc">Download your inventory directly from Warframe's API.</p>
        </div>
        <div class="source-steps-mini">
          <!-- svelte-ignore a11y-invalid-attribute -->
          <span>1. <a href="#" on:click|preventDefault={() => ipc.openExternal('https://github.com/Sainan/warframe-api-helper/releases')}>Download the helper</a></span>
          <span>2. Run it while Warframe is open</span>
          <span>3. Load the JSON file below</span>
        </div>
        <button class="btn-secondary btn-sm" on:click={loadApiHelper}>Load inventory.json</button>
      </div>

      <!-- Manual JSON Source -->
      <div class="source-card source-card-compact">
        <div class="source-header">
          <h3>Load Any JSON</h3>
          <p class="source-desc">Have an inventory JSON from another source? Load it directly.</p>
        </div>
        <button class="btn-secondary btn-sm" on:click={loadManual}>Browse for File</button>
      </div>

    </div>
  </div>
</section>
