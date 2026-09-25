<script lang="ts">
  import { onMount } from "svelte";

  import { invoke } from "../lib/ipc.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import type { LinuxCaptureSetupResult } from "../../config/shared/linuxDisplay.js";

  const RESULT_KEYS: Record<Exclude<LinuxCaptureSetupResult["state"], "missing">, MessageKey> = {
    ready: "settings.linuxCaptureReady",
    waiting: "settings.linuxCaptureWaiting",
    refused: "settings.linuxCaptureRefused",
    stuck: "settings.linuxCaptureStuck",
    failed: "settings.linuxCaptureFailed",
    unsupported: "settings.linuxCaptureFailed",
  };

  let visible = $state(false);
  let running = $state(false);
  let result = $state<LinuxCaptureSetupResult | null>(null);

  onMount(() => {
    invoke("getLinuxDisplay")
      .then((info) => (visible = info.capturePortal))
      .catch(() => (visible = false));
  });

  async function setUp(): Promise<void> {
    running = true;
    result = null;
    try {
      result = await invoke("setUpLinuxCapture");
    } catch {
      result = { state: "failed" };
    } finally {
      running = false;
    }
  }
</script>

{#if visible}
  <div class="mt-2.5 grid gap-1.5" data-linux-capture-setup>
    <div class="flex flex-wrap gap-2">
      <button
        class="btn-secondary btn-sm"
        title={$tr("settings.linuxCaptureSetupHint")}
        disabled={running}
        onclick={setUp}>{$tr("settings.linuxCaptureSetup")}</button
      >
    </div>
    {#if running}
      <p class="m-0 text-[var(--font-small-size,0.82rem)] text-text-secondary">
        {$tr("settings.linuxCaptureRunning")}
      </p>
    {:else if result}
      <p
        class="m-0 text-[var(--font-small-size,0.82rem)] {result.state === 'ready'
          ? 'text-success'
          : 'text-warning'}"
        data-linux-capture-result={result.state}
      >
        {#if result.state !== "missing"}
          {$tr(RESULT_KEYS[result.state])}
        {:else if result.portalPackage}
          {$tr("settings.linuxCaptureMissing", { package: result.portalPackage })}
        {:else}
          {$tr("settings.linuxCaptureMissingUnknown")}
        {/if}
      </p>
    {/if}
  </div>
{/if}
