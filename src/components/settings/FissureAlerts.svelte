<script lang="ts">
  import { overlaySettings, applyOverlaySettingsResponse } from "../../stores/overlaySettings.js";
  import { invoke } from "../../lib/ipc.js";
  import type { FissureAlert } from "../../types/ipc.js";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";

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
  const PLANETS = [
    "any",
    "Ceres", "Earth", "Eris", "Europa", "Jupiter", "Kuva Fortress",
    "Lua", "Mars", "Mercury", "Neptune", "Phobos", "Pluto",
    "Saturn", "Sedna", "Uranus", "Venus", "Void", "Zariman",
    "Deimos",
  ] as const;

  // Form state for new alert
  let newTier: string = "any";
  let newMissionType: string = "any";
  let newSteelPath: "any" | "normal" | "steel" = "any";
  let newPlanet: string = "any";
  let saving = false;
  let error = "";

  $: alerts = ($overlaySettings.fissureAlerts ?? []) as FissureAlert[];

  async function persistAlerts(updated: FissureAlert[]): Promise<void> {
    saving = true;
    error = "";
    try {
      const saved = await invoke("setOverlaySettings", { fissureAlerts: updated });
      if (saved) applyOverlaySettingsResponse(saved);
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
      planet: newPlanet,
    };
    await persistAlerts([...alerts, newAlert]);
  }

  async function removeAlert(id: string): Promise<void> {
    await persistAlerts(alerts.filter((a) => a.id !== id));
  }

  const tierLabel = (tier: string) => (tier === "any" ? "Any tier" : tier);
  const missionLabel = (m: string) => (m === "any" ? "Any mission" : m);
  const planetLabel = (p: string) => (p === "any" ? "Any planet" : p);
  const spLabel = (sp: string) =>
    sp === "any" ? "Any" : sp === "steel" ? "Steel Path" : "Normal";
</script>

<div class="mt-0 pt-0 border-t-0">
  <h4 class="m-0 mb-1 text-sm font-bold text-text-primary">Fissure Alerts</h4>
  <p class="text-xs text-text-secondary m-0 mb-2.5">Get a desktop notification when a matching fissure appears.</p>

  {#if alerts.length === 0}
    <p class="text-xs text-text-secondary italic m-0 mb-2">No alert rules configured.</p>
  {:else}
    <ul class="list-none m-0 mb-2 p-0 flex flex-col gap-1">
      {#each alerts as alert (alert.id)}
        <li class="flex items-center gap-1.5 flex-wrap">
          <span class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-white/5 text-text-secondary">{tierLabel(alert.tier)}</span>
          <span class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-white/5 text-text-secondary">{missionLabel(alert.missionType)}</span>
          <span class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-white/5 text-text-secondary">{spLabel(alert.steelPath)}</span>
          <span class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-white/5 text-text-secondary">{planetLabel(alert.planet)}</span>
          <button
            class="ml-auto inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-md)] border border-border bg-transparent text-text-secondary cursor-pointer text-sm p-0 transition-[color,border-color,background] duration-150 hover:text-danger hover:border-danger/40 hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Remove alert"
            disabled={saving}
            on:click={() => removeAlert(alert.id)}
          >×</button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-1.5 flex-wrap">
    <ThemedSelect bind:value={newTier} disabled={saving}>
      {#each TIERS as t}
        <option value={t}>{t === "any" ? "Any tier" : t}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newMissionType} disabled={saving}>
      {#each MISSION_TYPES as m}
        <option value={m}>{m === "any" ? "Any mission" : m}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newSteelPath} disabled={saving}>
      {#each STEEL_PATH_OPTIONS as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newPlanet} disabled={saving}>
      {#each PLANETS as p}
        <option value={p}>{p === "any" ? "Any planet" : p}</option>
      {/each}
    </ThemedSelect>
    <ThemedButton size="compact" className="!text-text-primary" disabled={saving} onClick={addAlert}>Add</ThemedButton>
  </div>

  {#if error}
    <p class="text-xs text-danger mt-1 mb-0">{error}</p>
  {/if}
</div>
