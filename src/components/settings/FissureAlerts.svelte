<script lang="ts">
  import { overlaySettings, overlaySettingsLoaded, OVERLAY_DEFAULTS } from "../../stores/overlaySettings.js";
  import { ipc } from "../../lib/ipc.js";
  import type { FissureAlert } from "../../types/ipc.js";

  const TIERS = ["any", "Lith", "Meso", "Neo", "Axi", "Requiem", "Omnia"] as const;
  const MISSION_TYPES = [
    "any",
    "Survival",
    "Defense",
    "Interception",
    "Mobile Defense",
    "Capture",
    "Exterminate",
    "Spy",
    "Excavation",
    "Rescue",
    "Sabotage",
    "Disruption",
    "Defection",
    "Assassination",
  ] as const;
  const STEEL_PATH_OPTIONS = [
    { value: "any",    label: "Any" },
    { value: "normal", label: "Normal" },
    { value: "steel",  label: "Steel Path" },
  ] as const;

  // Form state for new alert
  let newTier: string = "any";
  let newMissionType: string = "any";
  let newSteelPath: "any" | "normal" | "steel" = "any";
  let saving = false;
  let error = "";

  $: alerts = ($overlaySettings.fissureAlerts ?? []) as FissureAlert[];

  async function persistAlerts(updated: FissureAlert[]): Promise<void> {
    saving = true;
    error = "";
    try {
      const saved = await ipc.setOverlaySettings({ fissureAlerts: updated });
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to save";
    } finally {
      saving = false;
    }
  }

  async function addAlert(): Promise<void> {
    const newAlert: FissureAlert = {
      id: Math.random().toString(36).slice(2, 10),
      tier: newTier,
      missionType: newMissionType,
      steelPath: newSteelPath,
    };
    await persistAlerts([...alerts, newAlert]);
  }

  async function removeAlert(id: string): Promise<void> {
    await persistAlerts(alerts.filter((a) => a.id !== id));
  }

  function tierLabel(tier: string): string {
    return tier === "any" ? "Any tier" : tier;
  }
  function missionLabel(m: string): string {
    return m === "any" ? "Any mission" : m;
  }
  function spLabel(sp: string): string {
    return sp === "any" ? "Any" : sp === "steel" ? "Steel Path" : "Normal";
  }
</script>

<div class="fissure-alerts">
  <h4 class="fa-heading">Fissure Alerts</h4>
  <p class="fa-desc">Get a desktop notification when a matching fissure appears.</p>

  {#if alerts.length === 0}
    <p class="fa-empty">No alert rules configured.</p>
  {:else}
    <ul class="fa-list">
      {#each alerts as alert (alert.id)}
        <li class="fa-row">
          <span class="fa-badge fa-tier">{tierLabel(alert.tier)}</span>
          <span class="fa-badge fa-mission">{missionLabel(alert.missionType)}</span>
          <span class="fa-badge fa-sp">{spLabel(alert.steelPath)}</span>
          <button
            class="fa-remove"
            title="Remove alert"
            disabled={saving}
            on:click={() => removeAlert(alert.id)}
          >×</button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="fa-add-row">
    <select bind:value={newTier} class="fa-select" disabled={saving}>
      {#each TIERS as t}
        <option value={t}>{t === "any" ? "Any tier" : t}</option>
      {/each}
    </select>
    <select bind:value={newMissionType} class="fa-select" disabled={saving}>
      {#each MISSION_TYPES as m}
        <option value={m}>{m === "any" ? "Any mission" : m}</option>
      {/each}
    </select>
    <select bind:value={newSteelPath} class="fa-select" disabled={saving}>
      {#each STEEL_PATH_OPTIONS as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
    <button class="btn-primary btn-sm" disabled={saving} on:click={addAlert}>Add</button>
  </div>

  {#if error}
    <p class="fa-error">{error}</p>
  {/if}
</div>

<style>
  .fissure-alerts {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px dashed rgba(255, 255, 255, 0.1);
  }
  .fa-heading {
    margin: 0 0 0.25rem;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text-primary);
  }
  .fa-desc {
    font-size: 0.74rem;
    color: var(--text-secondary);
    margin: 0 0 0.6rem;
  }
  .fa-empty {
    font-size: 0.74rem;
    color: var(--text-secondary);
    font-style: italic;
    margin: 0 0 0.5rem;
  }
  .fa-list {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .fa-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .fa-badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0.12rem 0.5rem;
    font-size: 0.68rem;
    font-weight: 600;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary);
  }
  .fa-remove {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.3rem;
    height: 1.3rem;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .fa-remove:hover {
    color: var(--danger, #f87171);
    border-color: rgba(248, 113, 113, 0.4);
    background: rgba(248, 113, 113, 0.1);
  }
  .fa-remove:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .fa-add-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .fa-select {
    font-size: 0.74rem;
    border-radius: 0.3rem;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-primary);
    padding: 0.2rem 0.4rem;
    cursor: pointer;
  }
  .fa-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .fa-error {
    font-size: 0.74rem;
    color: var(--danger, #f87171);
    margin: 0.3rem 0 0;
  }
</style>
