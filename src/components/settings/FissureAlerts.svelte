<script lang="ts">
  import { overlaySettings, applyOverlaySettingsResponse } from "../../stores/overlaySettings.js";
  import { invoke } from "../../lib/ipc.js";
  import { tr, type MessageKey, type Translator } from "../../lib/i18n.js";
  import type { FissureAlert } from "../../types/ipc.js";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";

  const TIERS = ["any", "Lith", "Meso", "Neo", "Axi", "Requiem", "Omnia"] as const;
  const MISSION_TYPES = [
    "any",
    "Survival",
    "Defense",
    "Interception",
    "Void Cascade",
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
  const STEEL_PATH_OPTIONS: ReadonlyArray<{
    value: "any" | "normal" | "steel";
    labelKey: MessageKey;
  }> = [
    { value: "any", labelKey: "settings.fissureAnyMode" },
    { value: "normal", labelKey: "common.normal" },
    { value: "steel", labelKey: "common.steelPath" },
  ];
  const PLANETS = [
    "any",
    "Ceres",
    "Earth",
    "Eris",
    "Europa",
    "Jupiter",
    "Kuva Fortress",
    "Lua",
    "Mars",
    "Mercury",
    "Neptune",
    "Phobos",
    "Pluto",
    "Saturn",
    "Sedna",
    "Uranus",
    "Venus",
    "Void",
    "Zariman",
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
      error = e instanceof Error ? e.message : $tr("settings.fissureSaveFailed");
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

  const tierLabel = (t: Translator, tier: string) =>
    tier === "any" ? t("settings.fissureAnyTier") : tier;
  const missionLabel = (t: Translator, m: string) =>
    m === "any" ? t("settings.fissureAnyMission") : m;
  const planetLabel = (t: Translator, p: string) =>
    p === "any" ? t("settings.fissureAnyPlanet") : p;
  const spLabel = (t: Translator, sp: string) =>
    sp === "any"
      ? t("settings.fissureAnyMode")
      : sp === "steel"
        ? t("common.steelPath")
        : t("common.normal");
</script>

<div class="mt-0 pt-0 border-t-0">
  <h4 class="m-0 mb-1 text-sm font-bold text-text-primary">{$tr("settings.fissureAlertsTitle")}</h4>
  <p class="text-xs text-text-secondary m-0 mb-2.5">
    {$tr("settings.fissureAlertsDesc")}
  </p>

  {#if alerts.length === 0}
    <p class="text-xs text-text-secondary italic m-0 mb-2">{$tr("settings.fissureNoRules")}</p>
  {:else}
    <ul class="list-none m-0 mb-2 p-0 flex flex-col gap-1">
      {#each alerts as alert (alert.id)}
        <li class="flex items-center gap-1.5 flex-wrap">
          <span
            class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-surface-hover text-text-secondary"
            >{tierLabel($tr, alert.tier)}</span
          >
          <span
            class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-surface-hover text-text-secondary"
            >{missionLabel($tr, alert.missionType)}</span
          >
          <span
            class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-surface-hover text-text-secondary"
            >{spLabel($tr, alert.steelPath)}</span
          >
          <span
            class="inline-flex items-center rounded-full py-0.5 px-2 text-xs font-semibold border border-border bg-surface-hover text-text-secondary"
            >{planetLabel($tr, alert.planet)}</span
          >
          <button
            class="ml-auto inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-md)] border border-border bg-transparent text-text-secondary cursor-pointer text-sm p-0 transition-[color,border-color,background] duration-150 hover:text-danger hover:border-danger/40 hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed"
            title={$tr("settings.fissureRemoveAlert")}
            disabled={saving}
            on:click={() => removeAlert(alert.id)}>×</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-1.5 flex-wrap">
    <ThemedSelect bind:value={newTier} disabled={saving}>
      {#each TIERS as t}
        <option value={t}>{t === "any" ? $tr("settings.fissureAnyTier") : t}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newMissionType} disabled={saving}>
      {#each MISSION_TYPES as m}
        <option value={m}>{m === "any" ? $tr("settings.fissureAnyMission") : m}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newSteelPath} disabled={saving}>
      {#each STEEL_PATH_OPTIONS as opt}
        <option value={opt.value}>{$tr(opt.labelKey)}</option>
      {/each}
    </ThemedSelect>
    <ThemedSelect bind:value={newPlanet} disabled={saving}>
      {#each PLANETS as p}
        <option value={p}>{p === "any" ? $tr("settings.fissureAnyPlanet") : p}</option>
      {/each}
    </ThemedSelect>
    <ThemedButton size="compact" className="!text-text-primary" disabled={saving} onClick={addAlert}
      >{$tr("settings.fissureAdd")}</ThemedButton
    >
  </div>

  {#if error}
    <p class="text-xs text-danger mt-1 mb-0">{error}</p>
  {/if}
</div>
