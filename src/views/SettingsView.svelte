<script lang="ts">
  import { onMount } from "svelte";
  import {
    overlaySettings,
    overlaySettingsLoaded,
    OVERLAY_DEFAULTS,
    applyOverlaySettingsResponse,
  } from "../stores/overlaySettings.js";
  import AppearanceCard from "../components/settings/AppearanceCard.svelte";
  import { invoke, send } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import { hideFounderMasteryItems } from "../stores/preferences.js";
  import type { OverlaySettings } from "../types/ipc.js";

  type OverlaySettingsFormInput = Partial<OverlaySettings> & {
    showTradeNotification?: boolean;
  };

  let settingsTab: "general" | "appearance" | "overlay" = "general";
  let statusMsg = "";
  let statusError = false;

  let autoTrigger = OVERLAY_DEFAULTS.autoTriggerEnabled;
  let notificationSoundEnabled = OVERLAY_DEFAULTS.notificationSoundEnabled;
  let wfmNotificationsEnabled = OVERLAY_DEFAULTS.wfmNotificationsEnabled;
  let messageNotificationsEnabled = OVERLAY_DEFAULTS.messageNotificationsEnabled;
  let messageNotificationsBackgroundOnly = OVERLAY_DEFAULTS.messageNotificationsBackgroundOnly;
  let autoCloseWfmOrders = OVERLAY_DEFAULTS.autoCloseWfmOrders;
  let tradeNotificationOverlayEnabled = OVERLAY_DEFAULTS.tradeNotificationOverlayEnabled;
  let relicRewardsOverlayEnabled = OVERLAY_DEFAULTS.relicRewardsOverlayEnabled;
  let relicRecommendationOverlayEnabled = OVERLAY_DEFAULTS.relicRecommendationOverlayEnabled;
  let rivenOverlayEnabled = OVERLAY_DEFAULTS.rivenOverlayEnabled;
  let overlayScale = OVERLAY_DEFAULTS.overlayScale;
  let hotkeyEnabled = OVERLAY_DEFAULTS.hotkeyEnabled;
  let hotkey = OVERLAY_DEFAULTS.hotkey;
  let interactionHotkeyEnabled = OVERLAY_DEFAULTS.interactionHotkeyEnabled;
  let interactionHotkey = OVERLAY_DEFAULTS.interactionHotkey;

  function applyToForm(s: OverlaySettingsFormInput): void {
    autoTrigger = !!s.autoTriggerEnabled;
    notificationSoundEnabled =
      s.notificationSoundEnabled ?? OVERLAY_DEFAULTS.notificationSoundEnabled;
    wfmNotificationsEnabled = !!s.wfmNotificationsEnabled;
    messageNotificationsEnabled =
      s.messageNotificationsEnabled ?? OVERLAY_DEFAULTS.messageNotificationsEnabled;
    messageNotificationsBackgroundOnly = !!s.messageNotificationsBackgroundOnly;
    autoCloseWfmOrders = s.autoCloseWfmOrders ?? OVERLAY_DEFAULTS.autoCloseWfmOrders;
    tradeNotificationOverlayEnabled =
      s.tradeNotificationOverlayEnabled ??
      s.showTradeNotification ??
      OVERLAY_DEFAULTS.tradeNotificationOverlayEnabled;
    relicRewardsOverlayEnabled =
      s.relicRewardsOverlayEnabled ?? OVERLAY_DEFAULTS.relicRewardsOverlayEnabled;
    relicRecommendationOverlayEnabled =
      s.relicRecommendationOverlayEnabled ?? OVERLAY_DEFAULTS.relicRecommendationOverlayEnabled;
    rivenOverlayEnabled = s.rivenOverlayEnabled ?? OVERLAY_DEFAULTS.rivenOverlayEnabled;
    overlayScale = s.overlayScale ?? OVERLAY_DEFAULTS.overlayScale;
    hotkeyEnabled = !!s.hotkeyEnabled;
    hotkey = s.hotkey || OVERLAY_DEFAULTS.hotkey;
    interactionHotkeyEnabled = !!s.interactionHotkeyEnabled;
    interactionHotkey = s.interactionHotkey || OVERLAY_DEFAULTS.interactionHotkey;
  }

  onMount(async () => {
    if (!$overlaySettingsLoaded) {
      try {
        const loaded = await invoke("getOverlaySettings");
        if (loaded) applyOverlaySettingsResponse(loaded);
      } catch {
        statusMsg = $tr("settings.loadFailed");
        statusError = true;
      }
    }
    applyToForm($overlaySettings);
  });

  async function save() {
    const payload = {
      autoTriggerEnabled: autoTrigger,
      notificationSoundEnabled,
      wfmNotificationsEnabled,
      messageNotificationsEnabled,
      messageNotificationsBackgroundOnly,
      autoCloseWfmOrders,
      tradeNotificationOverlayEnabled,
      relicRewardsOverlayEnabled,
      relicRecommendationOverlayEnabled,
      rivenOverlayEnabled,
      overlayScale: Number(overlayScale),
      hotkeyEnabled,
      hotkey,
      interactionHotkeyEnabled,
      interactionHotkey,
    };

    try {
      const saved = await invoke("setOverlaySettings", payload);
      if (saved) {
        applyOverlaySettingsResponse(saved);
        applyToForm($overlaySettings);
      }
      statusMsg = $tr("settings.saved");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.saveFailed");
      statusError = true;
    }
  }

  async function resetDefaults() {
    applyToForm(OVERLAY_DEFAULTS);
    try {
      const saved = await invoke("setOverlaySettings", { ...OVERLAY_DEFAULTS });
      if (saved) applyOverlaySettingsResponse(saved);
      statusMsg = $tr("settings.defaultsRestored");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.defaultsRestoreFormFailed");
      statusError = true;
    }
  }

  function testTrigger() {
    send("simulate-relic-trigger");
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("settings.title")}</h2>
  </div>

  <div class="tab-bar">
    <button
      class="tab-item"
      class:active={settingsTab === "general"}
      on:click={() => (settingsTab = "general")}
    >
      <span>General</span>
    </button>
    <button
      class="tab-item"
      class:active={settingsTab === "appearance"}
      on:click={() => (settingsTab = "appearance")}
    >
      <span>Appearance</span>
    </button>
    <button
      class="tab-item"
      class:active={settingsTab === "overlay"}
      on:click={() => (settingsTab = "overlay")}
    >
      <span>Overlays</span>
    </button>
  </div>

  {#if settingsTab === "general"}
    <div class="settings-tab-grid py-3">
      <article class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <div>
          <h3 class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary">Notifications</h3>
          <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">
            Desktop and market notification behavior.
          </p>
        </div>

        <div class="mt-2.5 grid gap-2">
          <label class="settings-control-row">
            <span>Windows notification sound</span>
            <input type="checkbox" bind:checked={notificationSoundEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row">
            <span>WFM DM notifications</span>
            <input type="checkbox" bind:checked={wfmNotificationsEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row">
            <span>In-game message notifications</span>
            <input type="checkbox" bind:checked={messageNotificationsEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row" class:opacity-50={!messageNotificationsEnabled}>
            <span>Only when Warframe is in the background</span>
            <input
              type="checkbox"
              bind:checked={messageNotificationsBackgroundOnly}
              disabled={!messageNotificationsEnabled}
              class="accent-accent"
            />
          </label>

          <label class="settings-control-row">
            <span>Unlist WFMarket orders when sold/bought</span>
            <input type="checkbox" bind:checked={autoCloseWfmOrders} class="accent-accent" />
          </label>
        </div>
      </article>

      <article class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <div>
          <h3 class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary">Mastery</h3>
          <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">
            Control which items appear in the mastery helper.
          </p>
        </div>

        <div class="mt-2.5 grid gap-2">
          <label class="settings-control-row">
            <span>Hide Founder items</span>
            <input type="checkbox" bind:checked={$hideFounderMasteryItems} class="accent-accent" />
          </label>
        </div>
      </article>

      <article class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <div>
          <h3 class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary">Actions</h3>
          <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">Save app behavior changes or restore default settings.</p>
        </div>

        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <button class="btn-primary btn-sm" on:click={save}>{$tr("settings.save")}</button>
          <button class="btn-secondary btn-sm" on:click={resetDefaults}>{$tr("settings.resetDefaults")}</button>
        </div>

        {#if statusMsg}
          <p class="mt-2 min-h-4 text-sm text-text-secondary" class:text-danger={statusError}>{statusMsg}</p>
        {/if}
      </article>
    </div>
  {:else if settingsTab === "appearance"}
    <div class="settings-tab-grid py-3">
      <AppearanceCard />
    </div>
  {:else if settingsTab === "overlay"}
    <div class="settings-tab-grid py-3">
      <article class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <div>
          <h3 class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary">Overlay availability</h3>
          <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">
            Enable or disable each in-game overlay window.
          </p>
        </div>

        <div class="mt-2.5 grid gap-2">
          <label class="settings-control-row">
            <span>Relic rewards overlay</span>
            <input type="checkbox" bind:checked={relicRewardsOverlayEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row">
            <span>Relic recommendation overlay</span>
            <input
              type="checkbox"
              bind:checked={relicRecommendationOverlayEnabled}
              class="accent-accent"
            />
          </label>

          <label class="settings-control-row">
            <span>Trade detected overlay</span>
            <input
              type="checkbox"
              bind:checked={tradeNotificationOverlayEnabled}
              class="accent-accent"
            />
          </label>

          <label class="settings-control-row">
            <span>Riven overlay</span>
            <input type="checkbox" bind:checked={rivenOverlayEnabled} class="accent-accent" />
          </label>
        </div>
      </article>

      <article class="w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <div>
          <h3 class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary">{$tr("settings.overlayTitle")}</h3>
          <p class="mt-1 text-xs leading-tight text-text-muted">{$tr("settings.overlayRequirements")}</p>
        </div>

        <div class="mt-2.5 grid gap-2">
          <label class="settings-control-row">
            <span>{$tr("settings.autoTrigger")}</span>
            <input type="checkbox" bind:checked={autoTrigger} class="accent-accent" />
          </label>

          <label class="settings-control-row settings-control-row-input">
            <span>Overlay size</span>
            <div class="settings-range-control">
              <input
                type="range"
                min="0.75"
                max="1.5"
                step="0.05"
                bind:value={overlayScale}
                class="settings-range"
              />
              <span class="settings-range-value">{Math.round(Number(overlayScale) * 100)}%</span>
            </div>
          </label>

          <label class="settings-control-row">
            <span>{$tr("settings.hotkeyFallback")}</span>
            <input type="checkbox" bind:checked={hotkeyEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row settings-control-row-input">
            <span>{$tr("settings.hotkey")}</span>
            <input
              type="text"
              bind:value={hotkey}
              disabled={!hotkeyEnabled}
              placeholder={$tr("settings.hotkeyPlaceholder")}
              class="settings-input"
            />
          </label>

          <label class="settings-control-row">
            <span>{$tr("settings.interactionHotkeyEnabled")}</span>
            <input type="checkbox" bind:checked={interactionHotkeyEnabled} class="accent-accent" />
          </label>

          <label class="settings-control-row settings-control-row-input">
            <span>{$tr("settings.interactionHotkey")}</span>
            <input
              type="text"
              bind:value={interactionHotkey}
              disabled={!interactionHotkeyEnabled}
              placeholder={$tr("settings.interactionHotkeyPlaceholder")}
              class="settings-input"
            />
          </label>
        </div>
      </article>

      <div class="settings-wide-actions">
        <div class="flex flex-wrap gap-1.5">
          <button class="btn-primary btn-sm" on:click={save}>{$tr("settings.save")}</button>
          <button class="btn-secondary btn-sm" on:click={resetDefaults}>{$tr("settings.resetDefaults")}</button>
          <button class="btn-secondary btn-sm" on:click={testTrigger}>{$tr("settings.testTrigger")}</button>
        </div>

        {#if statusMsg}
          <p class="min-h-4 text-sm text-text-secondary" class:text-danger={statusError}>{statusMsg}</p>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .settings-tab-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 0.85rem;
    max-width: 1040px;
    margin-inline: auto;
    align-items: start;
  }

  .settings-control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-raised);
    padding: 0.55rem 0.7rem;
    cursor: pointer;
  }

  .settings-control-row span {
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .settings-control-row-input {
    cursor: default;
  }

  .settings-input {
    min-width: 9rem;
    max-width: 12rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-primary);
    padding: 0.38rem 0.6rem;
    font-size: 0.875rem;
    outline: none;
  }

  .settings-input:focus {
    border-color: var(--accent-dim);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .settings-input:disabled {
    opacity: 0.55;
  }

  .settings-range-control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.6rem;
    min-width: 12rem;
  }

  .settings-range {
    width: 8rem;
    accent-color: var(--accent);
  }

  .settings-range-control .settings-range-value {
    min-width: 3.7rem;
    text-align: right;
    color: var(--text-primary);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }

  .settings-wide-actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
</style>


