<script lang="ts">
  import { overlaySettings, applyOverlaySettingsResponse } from "../../stores/overlaySettings.js";
  import { invoke } from "../../lib/ipc.js";
  import type { FissureAlert } from "../../types/ipc.js";
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

  function tierLabel(tier: string): string {
    return tier === "any" ? "Any tier" : tier;
  }
  function missionLabel(m: string): string {
    return m === "any" ? "Any mission" : m;
  }
  function spLabel(sp: string): string {
    return sp === "any" ? "Any" : sp === "steel" ? "Steel Path" : "Normal";
  }
  function planetLabel(p: string): string {
    return p === "any" ? "Any planet" : p;
  }
</script>

<div class="mt-0 pt-0 border-t-0">
  <h4 class="m-0 mb-1 text-[0.82rem] font-bold text-text-primary">Fissure Alerts</h4>
  <p class="text-[0.74rem] text-text-secondary m-0 mb-[0.6rem]">Get a desktop notification when a matching fissure appears.</p>

  {#if alerts.length === 0}
    <p class="text-[0.74rem] text-text-secondary italic m-0 mb-2">No alert rules configured.</p>
  {:else}
    <ul class="list-none m-0 mb-2 p-0 flex flex-col gap-[0.3rem]">
      {#each alerts as alert (alert.id)}
        <li class="flex items-center gap-[0.35rem] flex-wrap">
          <span class="inline-flex items-center rounded-full py-[0.12rem] px-2 text-[0.68rem] font-semibold border border-border bg-[rgba(255,255,255,0.05)] text-text-secondary">{tierLabel(alert.tier)}</span>
          <span class="inline-flex items-center rounded-full py-[0.12rem] px-2 text-[0.68rem] font-semibold border border-border bg-[rgba(255,255,255,0.05)] text-text-secondary">{missionLabel(alert.missionType)}</span>
          <span class="inline-flex items-center rounded-full py-[0.12rem] px-2 text-[0.68rem] font-semibold border border-border bg-[rgba(255,255,255,0.05)] text-text-secondary">{spLabel(alert.steelPath)}</span>
          <span class="inline-flex items-center rounded-full py-[0.12rem] px-2 text-[0.68rem] font-semibold border border-border bg-[rgba(255,255,255,0.05)] text-text-secondary">{planetLabel(alert.planet)}</span>
          <button
            class="ml-auto inline-flex items-center justify-center w-[1.3rem] h-[1.3rem] rounded-[var(--radius-md)] border border-border bg-transparent text-text-secondary cursor-pointer text-[0.9rem] p-0 transition-[color,border-color,background] duration-150 hover:text-danger hover:border-[rgba(248,113,113,0.4)] hover:bg-[rgba(248,113,113,0.1)] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Remove alert"
            disabled={saving}
            on:click={() => removeAlert(alert.id)}
          >×</button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-[0.4rem] flex-wrap">
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
    <button
      class="h-[1.6rem] leading-none cursor-pointer rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] bg-bg-surface px-[0.55rem] py-0 text-[0.74rem] text-text-primary transition-[color,border-color,background] duration-150 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      disabled={saving}
      on:click={addAlert}
    >Add</button>
  </div>

  {#if error}
    <p class="text-[0.74rem] text-danger mt-[0.3rem] mb-0">{error}</p>
  {/if}
</div>
