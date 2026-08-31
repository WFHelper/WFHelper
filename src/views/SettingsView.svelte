<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    overlaySettings,
    overlaySettingsLoaded,
    OVERLAY_DEFAULTS,
    applyOverlaySettingsResponse,
    detectedWarframeUiScale,
  } from "../stores/overlaySettings.js";
  import AppearanceCard from "../components/settings/AppearanceCard.svelte";
  import SettingsSection from "../components/settings/SettingsSection.svelte";
  import SettingsRow from "../components/settings/SettingsRow.svelte";
  import AboutCard from "../components/settings/AboutCard.svelte";
  import SupportersCard from "../components/settings/SupportersCard.svelte";
  import ProtonLaunchOption from "../components/ProtonLaunchOption.svelte";
  import LinuxDisplayBackend from "../components/LinuxDisplayBackend.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import { invoke, send, getPlatform } from "../lib/ipc.js";
  import { onInventoryLoaded } from "../lib/actions.js";
  import {
    describeInventorySource,
    INVENTORY_SOURCE_OPTIONS,
  } from "../lib/inventorySourceLabel.js";
  import {
    tr,
    locale,
    setLocale,
    LOCALE_OPTIONS,
    type LocaleCode,
    type MessageKey,
  } from "../lib/i18n.js";
  import {
    gameLanguage,
    setGameLanguage,
    GAME_LANGUAGE_OPTIONS,
    type GameLanguageChoice,
  } from "../lib/gameLanguage.js";
  import ThemedSelect from "../components/ThemedSelect.svelte";
  import {
    autoFocusSearch,
    hideFoundryClaims,
    hideFounderMasteryItems,
  } from "../stores/preferences.js";
  import { TOGGLEABLE_TABS, tabVisibility } from "../stores/sidebarTabs.js";
  import type { ToggleableView } from "../types/views.js";
  import { startTour } from "../stores/tour.js";
  import { currentView } from "../stores/app.js";
  import type { InventorySource, OverlaySettings, OverlayWindowKey } from "../types/ipc.js";
  import { ROUTABLE_NOTIFICATION_SOURCES } from "../../config/shared/notifications.js";
  import type {
    NotificationChannelState,
    NotificationSource,
    SourceChannelToggles,
    WebhookChannel,
    WebhookTestError,
    WebhookUrlError,
  } from "../../config/shared/notifications.js";

  type OverlaySettingsFormInput = Partial<OverlaySettings> & {
    showTradeNotification?: boolean;
  };

  let settingsTab: "general" | "appearance" | "overlay" = "general";
  // The store owns the language: the select only mirrors it, so an external
  // setLocale is not written back over.
  let languageChoice: LocaleCode;
  $: languageChoice = $locale;
  $: if (languageChoice !== $locale) setLocale(languageChoice);

  let gameLanguageChoice: GameLanguageChoice;
  $: gameLanguageChoice = $gameLanguage;
  $: if (gameLanguageChoice !== $gameLanguage) setGameLanguage(gameLanguageChoice);
  let statusMsg = "";
  let statusError = false;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const isLinux = getPlatform() === "linux";
  const isWindows = getPlatform() === "win32";

  async function openFolder(
    channel: "openScanDebugFolder" | "openLogFolder",
    failedKey: MessageKey,
  ): Promise<void> {
    try {
      const result = await invoke(channel);
      if (!result?.ok) flashStatus($tr(failedKey), true);
    } catch {
      flashStatus($tr(failedKey), true);
    }
  }

  const openScanDebugFolder = (): Promise<void> =>
    openFolder("openScanDebugFolder", "settings.scanDebugFolderFailed");
  const openLogFolder = (): Promise<void> =>
    openFolder("openLogFolder", "settings.logFolderFailed");

  function flashStatus(msg: string, isError: boolean): void {
    statusMsg = msg;
    statusError = isError;
    if (statusTimer) clearTimeout(statusTimer);
    if (!isError) statusTimer = setTimeout(() => (statusMsg = ""), 2000);
  }

  let inventorySource: InventorySource = "helper";
  let inventoryPath: string | null = null;
  let switchingSource = false;

  $: sourceDescription = describeInventorySource(inventorySource, inventoryPath);
  $: sourceLabel = $tr(sourceDescription.labelKey);
  $: sourceTitle = sourceDescription.path || sourceLabel;
  $: inventorySourceOptions = INVENTORY_SOURCE_OPTIONS.map((option) => ({
    value: option.value,
    label: $tr(option.labelKey),
  }));
  $: autoSyncApplies = inventorySource === "helper";

  async function refreshInventorySource(): Promise<void> {
    try {
      const status = await invoke("getInventoryStatus");
      inventorySource = status.source;
      inventoryPath = status.path;
    } catch {
      // keep the last known source rather than claiming a wrong one
    }
  }

  // The pickers own the switch to a user file: a cancelled dialog returns null
  // and main keeps the current source.
  async function selectInventorySource(next: InventorySource): Promise<void> {
    if (switchingSource || next === inventorySource) return;
    switchingSource = true;
    try {
      if (next === "helper") {
        await invoke("setInventorySource", "helper");
      } else {
        const data =
          next === "aleca"
            ? await invoke("openAlecaFrameInventoryFile")
            : await invoke("openInventoryFile", "manual");
        if (data) await onInventoryLoaded(data);
      }
      await refreshInventorySource();
    } catch {
      flashStatus($tr("settings.inventorySourceChangeFailed"), true);
      await refreshInventorySource();
    } finally {
      switchingSource = false;
    }
  }

  const OVERLAY_SCALE_ROWS: Array<{ key: OverlayWindowKey; labelKey: MessageKey }> = [
    { key: "reward", labelKey: "settings.overlayScaleReward" },
    { key: "planner", labelKey: "settings.overlayScalePlanner" },
    { key: "rivenLeft", labelKey: "settings.overlayScaleRivenLeft" },
    { key: "rivenRight", labelKey: "settings.overlayScaleRivenRight" },
    { key: "arbiSummary", labelKey: "settings.overlayScaleArbiSummary" },
  ];
  let windowScales: Partial<Record<OverlayWindowKey, number>> = {};

  // Same channel the setup wizard uses: persists overlayWindowScales + live-applies.
  async function saveWindowScale(key: OverlayWindowKey, value: number): Promise<void> {
    windowScales = { ...windowScales, [key]: value };
    try {
      const result = await invoke("saveOverlayScale", key, value);
      if (!result?.ok) flashStatus($tr("settings.saveFailed"), true);
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
    }
  }

  // Every editable overlay field, in the order the panel shows them.
  const OVERLAY_FORM_KEYS = [
    "autoTriggerEnabled",
    "notificationSoundEnabled",
    "notificationSoundUsesSystem",
    "wfmNotificationsEnabled",
    "messageNotificationsEnabled",
    "messageNotificationsWhileFocused",
    "autoCloseWfmOrders",
    "tradeRepHotkeyEnabled",
    "tradeRepHotkey",
    "tradeNotificationSeconds",
    "tradeDesktopNotificationsEnabled",
    "windowsNotificationSeconds",
    "tradeNotificationOverlayEnabled",
    "relicRewardsOverlayEnabled",
    "relicRecommendationOverlayEnabled",
    "rivenOverlayEnabled",
    "arbiSummaryOverlayEnabled",
    "arbiTrackingEnabled",
    "autoInventorySyncEnabled",
    "ocrDebugImagesEnabled",
    "blockThirdPartyInjection",
    "warframeUiScale",
    "warframeUiScaleAuto",
    "hotkeyEnabled",
    "hotkey",
    "interactionHotkeyEnabled",
    "interactionHotkey",
  ] as const;

  type OverlayForm = Pick<typeof OVERLAY_DEFAULTS, (typeof OVERLAY_FORM_KEYS)[number]>;

  // A missing key takes its declared default; three of these default to true,
  // so coercing absence to false silently disables the user's hotkeys. A hotkey
  // cleared to "" is absence too.
  function normalizeOverlayForm(s: OverlaySettingsFormInput): OverlayForm {
    const out: Record<string, unknown> = {};
    for (const key of OVERLAY_FORM_KEYS) {
      const value = (s as Record<string, unknown>)[key];
      out[key] = value == null || value === "" ? OVERLAY_DEFAULTS[key] : value;
    }
    // showTradeNotification is the pre-0.2 key, still read so old settings files migrate.
    if (s.tradeNotificationOverlayEnabled == null && s.showTradeNotification != null) {
      out.tradeNotificationOverlayEnabled = s.showTradeNotification;
    }
    return out as OverlayForm;
  }

  let form = normalizeOverlayForm(OVERLAY_DEFAULTS);
  // Display-only: the per-window rows fall back to it, but no control edits it,
  // so it is deliberately absent from the saved payload.
  let overlayScale = OVERLAY_DEFAULTS.overlayScale;

  function applyToForm(s: OverlaySettingsFormInput): void {
    form = normalizeOverlayForm(s);
    overlayScale = s.overlayScale ?? OVERLAY_DEFAULTS.overlayScale;
    windowScales = { ...(s.overlayWindowScales || {}) };
  }

  // The detected value only drives the row while auto mode is on.
  $: uiScaleDetected = form.warframeUiScaleAuto ? $detectedWarframeUiScale : null;

  // Live updates arrive via the warframe-ui-scale-updated push whenever the
  // game saves EE.cfg; this pull seeds the store and covers missed pushes.
  async function refreshDetectedUiScale(): Promise<void> {
    try {
      detectedWarframeUiScale.set(await invoke("getDetectedWarframeUiScale"));
    } catch {
      detectedWarframeUiScale.set(null);
    }
  }

  const WEBHOOK_ROWS: { channel: WebhookChannel; labelKey: MessageKey }[] = [
    { channel: "discord", labelKey: "settings.webhookDiscord" },
    { channel: "generic", labelKey: "settings.webhookGeneric" },
  ];

  const SOURCE_LABEL_KEYS: Record<(typeof ROUTABLE_NOTIFICATION_SOURCES)[number], MessageKey> = {
    worldState: "settings.channelSourceWorld",
    arbiSchedule: "settings.channelSourceArbi",
    whisper: "settings.channelSourceWhisper",
    tradeToast: "settings.channelSourceTrade",
    marketAlerts: "settings.channelSourceMarketAlerts",
  };

  // Shared list, so a source that gains a producer shows up here on its own.
  const SOURCE_ROWS = ROUTABLE_NOTIFICATION_SOURCES.map((source) => ({
    source: source as NotificationSource,
    labelKey: SOURCE_LABEL_KEYS[source],
  }));

  const WEBHOOK_ERROR_KEYS: Record<WebhookUrlError, MessageKey> = {
    empty: "settings.webhookErrorEmpty",
    "invalid-url": "settings.webhookErrorInvalid",
    "not-https": "settings.webhookErrorNotHttps",
    "blocked-host": "settings.webhookErrorBlockedHost",
    "dns-failed": "settings.webhookErrorDns",
  };

  const WEBHOOK_TEST_ERROR_KEYS: Record<WebhookTestError, MessageKey> = {
    "not-configured": "settings.webhookErrorEmpty",
    "blocked-url": "settings.webhookErrorBlockedHost",
    failed: "settings.webhookTestFailed",
  };

  let channelState: NotificationChannelState | null = null;
  let webhookDrafts: Record<WebhookChannel, string> = { discord: "", generic: "" };
  let webhookBusy: Record<WebhookChannel, boolean> = { discord: false, generic: false };

  // Only main knows the saved URLs, so the drafts stay empty and the row shows
  // the masked form instead of ever holding a secret in renderer state.
  async function refreshChannels(): Promise<void> {
    try {
      channelState = await invoke("getNotificationChannels");
    } catch {
      channelState = null;
    }
  }

  function channelToggles(source: NotificationSource): SourceChannelToggles {
    return channelState?.sources[source] ?? { native: true, webhook: false };
  }

  async function saveWebhook(channel: WebhookChannel): Promise<void> {
    webhookBusy = { ...webhookBusy, [channel]: true };
    try {
      const result = await invoke("setNotificationWebhook", channel, webhookDrafts[channel]);
      if (result.ok) {
        channelState = result.state;
        webhookDrafts = { ...webhookDrafts, [channel]: "" };
        flashStatus($tr("settings.webhookSaved"), false);
      } else {
        flashStatus($tr(WEBHOOK_ERROR_KEYS[result.error]), true);
      }
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
    } finally {
      webhookBusy = { ...webhookBusy, [channel]: false };
    }
  }

  async function clearWebhook(channel: WebhookChannel): Promise<void> {
    webhookBusy = { ...webhookBusy, [channel]: true };
    try {
      channelState = await invoke("clearNotificationWebhook", channel);
      webhookDrafts = { ...webhookDrafts, [channel]: "" };
      flashStatus($tr("settings.webhookCleared"), false);
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
    } finally {
      webhookBusy = { ...webhookBusy, [channel]: false };
    }
  }

  async function testWebhook(channel: WebhookChannel): Promise<void> {
    webhookBusy = { ...webhookBusy, [channel]: true };
    try {
      const result = await invoke("testNotificationWebhook", channel);
      if (result.ok) flashStatus($tr("settings.webhookTestSent"), false);
      else flashStatus($tr(WEBHOOK_TEST_ERROR_KEYS[result.error]), true);
    } catch {
      flashStatus($tr("settings.webhookTestFailed"), true);
    } finally {
      webhookBusy = { ...webhookBusy, [channel]: false };
    }
  }

  async function saveSourceChannel(
    source: NotificationSource,
    key: keyof SourceChannelToggles,
    value: boolean,
  ): Promise<void> {
    const next: SourceChannelToggles = { ...channelToggles(source), [key]: value };
    try {
      channelState = await invoke("setNotificationSourceChannels", source, next);
      flashStatus($tr("settings.saved"), false);
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
      await refreshChannels();
    }
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
    await refreshDetectedUiScale();
    // The view stays mounted once visited; refresh on focus so alt-tabbing
    // back from an in-game scale change shows the new value.
    window.addEventListener("focus", refreshDetectedUiScale);
    await refreshInventorySource();
    await refreshChannels();
  });

  onDestroy(() => window.removeEventListener("focus", refreshDetectedUiScale));

  let saveRevision = 0;
  let saveQueue: Promise<void> = Promise.resolve();

  // Re-normalized on the way out because an emptied number input binds to null,
  // which the main-process clamp reads as 0 and raises to the range floor
  // instead of falling back to the declared default.
  function currentOverlayPayload() {
    return normalizeOverlayForm(form);
  }

  function queueSave(
    payload: ReturnType<typeof currentOverlayPayload>,
    successMessage: string,
    failureMessage: string,
  ): Promise<void> {
    const revision = ++saveRevision;
    saveQueue = saveQueue.then(async () => {
      try {
        const saved = await invoke("setOverlaySettings", payload);
        if (revision !== saveRevision) return;
        if (saved) {
          applyOverlaySettingsResponse(saved);
          applyToForm($overlaySettings);
        }
        flashStatus(successMessage, false);
      } catch {
        if (revision === saveRevision) flashStatus(failureMessage, true);
      }
    });
    return saveQueue;
  }

  function save(): Promise<void> {
    return queueSave(currentOverlayPayload(), $tr("settings.saved"), $tr("settings.saveFailed"));
  }

  // Every control saves on change; there is no separate save step.
  function autoSave(): void {
    void save();
  }

  // Return undefined for Escape, bare Tab, and lone modifiers so cancellation,
  // navigation, and incomplete combos retain their normal behavior.
  function captureAccelerator(e: KeyboardEvent): string | undefined {
    const key = e.key;
    if (key === "Escape") return undefined;
    if (["Control", "Shift", "Alt", "Meta", "OS"].includes(key)) return undefined;
    if (key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return undefined;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Control");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Super");
    let main = key;
    if (main === " ") main = "Space";
    else if (main.startsWith("Arrow")) main = main.slice(5);
    else if (main.length === 1) main = main.toUpperCase();
    parts.push(main);
    e.preventDefault();
    return parts.join("+");
  }

  type HotkeyField = "hotkey" | "interactionHotkey" | "tradeRepHotkey";

  function recordHotkey(field: HotkeyField, e: KeyboardEvent): void {
    const accel = captureAccelerator(e);
    if (accel === undefined) return;
    form[field] = accel;
    autoSave();
  }

  function resetDefaults() {
    applyToForm(OVERLAY_DEFAULTS);
    void queueSave(
      currentOverlayPayload(),
      $tr("settings.defaultsRestored"),
      $tr("settings.defaultsRestoreFormFailed"),
    );
  }

  function testTrigger() {
    send("simulate-relic-trigger");
  }

  // Local mirror of the per-tab visibility stores so each checkbox can bind to a
  // plain bool; the change handler pushes back to the persisted store.
  const tabChecked = Object.fromEntries(
    TOGGLEABLE_TABS.map((t) => [t.view, get(tabVisibility[t.view])]),
  ) as Record<ToggleableView, boolean>;

  function setTabVisible(view: ToggleableView): void {
    tabVisibility[view].set(tabChecked[view]);
  }
</script>

<section class="view active settings-shell w-full">
  <div class="mx-auto w-full max-w-[1120px]">
    <div class="view-header">
      <h2>{$tr("common.settings")}</h2>
    </div>

    <div class="tab-bar">
      <button
        class="tab-item"
        class:active={settingsTab === "general"}
        data-tour-tab="general"
        on:click={() => (settingsTab = "general")}
      >
        <span>{$tr("settings.tabGeneral")}</span>
      </button>
      <button
        class="tab-item"
        class:active={settingsTab === "appearance"}
        data-tour-tab="appearance"
        on:click={() => (settingsTab = "appearance")}
      >
        <span>{$tr("common.appearance")}</span>
      </button>
      <button
        class="tab-item"
        class:active={settingsTab === "overlay"}
        data-tour-tab="overlay"
        on:click={() => (settingsTab = "overlay")}
      >
        <span>{$tr("common.overlays")}</span>
      </button>
    </div>

    {#if settingsTab === "general"}
      <div class="settings-general-layout py-3">
        <div class="settings-tab-grid settings-masonry">
          <SettingsSection
            title={$tr("settings.languageTitle")}
            description={$tr("settings.languageDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.languageRow")} dataSetting="language">
                <ThemedSelect bind:value={languageChoice}>
                  {#each LOCALE_OPTIONS as option}
                    <option value={option.code}>{option.label}</option>
                  {/each}
                </ThemedSelect>
              </SettingsRow>
              <SettingsRow label={$tr("settings.gameLanguageRow")} dataSetting="game-language">
                <ThemedSelect bind:value={gameLanguageChoice}>
                  <option value="auto">{$tr("settings.gameLanguageAuto")}</option>
                  {#each GAME_LANGUAGE_OPTIONS as option}
                    <option value={option.code}>{option.label}</option>
                  {/each}
                </ThemedSelect>
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.notificationsTitle")}
            description={$tr("settings.notificationsDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.windowsNotifSound")}>
                <input
                  type="checkbox"
                  bind:checked={form.notificationSoundEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              {#if isWindows}
                <SettingsRow
                  label={$tr("settings.notificationSoundUsesSystem")}
                  hint={$tr("settings.notificationSoundUsesSystemHint")}
                  dimmed={!form.notificationSoundEnabled}
                >
                  <input
                    type="checkbox"
                    data-setting="notification-sound-system"
                    disabled={!form.notificationSoundEnabled}
                    bind:checked={form.notificationSoundUsesSystem}
                    on:change={autoSave}
                    class="accent-accent"
                  />
                </SettingsRow>
              {/if}

              <SettingsRow
                label={$tr("settings.windowsNotificationSeconds")}
                dataSetting="windows-notification-seconds"
                inputRow
              >
                <input
                  type="number"
                  min="2"
                  max="60"
                  step="1"
                  bind:value={form.windowsNotificationSeconds}
                  on:change={autoSave}
                  class="settings-input"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.wfmDmNotifications")}>
                <input
                  type="checkbox"
                  bind:checked={form.wfmNotificationsEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.inGameMessageNotifications")}>
                <input
                  type="checkbox"
                  bind:checked={form.messageNotificationsEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow
                label={$tr("settings.notifyWhileFocused")}
                dimmed={!form.messageNotificationsEnabled}
              >
                <input
                  type="checkbox"
                  bind:checked={form.messageNotificationsWhileFocused}
                  disabled={!form.messageNotificationsEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.unlistOnTrade")}>
                <input
                  type="checkbox"
                  bind:checked={form.autoCloseWfmOrders}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow
                label={$tr("settings.tradeNotificationSeconds")}
                dataSetting="trade-notification-seconds"
                inputRow
              >
                <input
                  type="number"
                  min="2"
                  max="60"
                  step="1"
                  bind:value={form.tradeNotificationSeconds}
                  on:change={autoSave}
                  class="settings-input"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.tradeDesktopNotifications")}>
                <input
                  type="checkbox"
                  bind:checked={form.tradeDesktopNotificationsEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.tradeRepKeybindEnable")}>
                <input
                  type="checkbox"
                  bind:checked={form.tradeRepHotkeyEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.tradeRepKeybind")} inputRow>
                <input
                  type="text"
                  bind:value={form.tradeRepHotkey}
                  disabled={!form.tradeRepHotkeyEnabled}
                  placeholder={$tr("settings.pressKeyCombination")}
                  on:keydown={(e) => recordHotkey("tradeRepHotkey", e)}
                  on:change={autoSave}
                  class="settings-input"
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.notificationChannelsTitle")}
            description={$tr("settings.notificationChannelsDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              {#each WEBHOOK_ROWS as row (row.channel)}
                {@const status = channelState?.webhooks[row.channel]}
                <SettingsRow
                  label={$tr(row.labelKey)}
                  hint={status?.configured ? status.masked : undefined}
                  dataSetting={`webhook-${row.channel}`}
                  as="div"
                  inputRow
                  wrapControl
                >
                  <span class="flex flex-wrap items-center justify-end gap-2">
                    <input
                      type="url"
                      class="settings-input"
                      placeholder={$tr("settings.webhookUrlPlaceholder")}
                      disabled={webhookBusy[row.channel]}
                      bind:value={webhookDrafts[row.channel]}
                    />
                    <button
                      class="btn-secondary btn-sm"
                      disabled={webhookBusy[row.channel] || !webhookDrafts[row.channel]}
                      on:click={() => saveWebhook(row.channel)}>{$tr("common.save")}</button
                    >
                    <button
                      class="btn-secondary btn-sm"
                      disabled={webhookBusy[row.channel] || !status?.configured}
                      on:click={() => testWebhook(row.channel)}
                      >{$tr("settings.webhookTest")}</button
                    >
                    <button
                      class="btn-secondary btn-sm"
                      disabled={webhookBusy[row.channel] || !status?.configured}
                      on:click={() => clearWebhook(row.channel)}
                      >{$tr("settings.webhookClear")}</button
                    >
                  </span>
                </SettingsRow>
              {/each}

              <p class="m-0 mt-2 text-xs text-text-muted">{$tr("settings.channelRoutingDesc")}</p>

              {#each SOURCE_ROWS as row (row.source)}
                {@const toggles = channelToggles(row.source)}
                <SettingsRow
                  label={$tr(row.labelKey)}
                  dataSetting={`notify-source-${row.source}`}
                  as="div"
                >
                  <span class="flex items-center gap-3">
                    <label class="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-accent"
                        checked={toggles.native}
                        on:change={(event) =>
                          saveSourceChannel(row.source, "native", event.currentTarget.checked)}
                      />
                      {$tr("settings.channelNative")}
                    </label>
                    <label class="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        class="accent-accent"
                        checked={toggles.webhook}
                        on:change={(event) =>
                          saveSourceChannel(row.source, "webhook", event.currentTarget.checked)}
                      />
                      {$tr("settings.channelWebhook")}
                    </label>
                  </span>
                </SettingsRow>
              {/each}
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("common.arbitrations")}
            description={$tr("settings.arbitrationsDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.trackArbiRuns")}>
                <input
                  type="checkbox"
                  bind:checked={form.arbiTrackingEnabled}
                  on:change={autoSave}
                  class="accent-accent"
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("common.inventory")}
            description={$tr("settings.inventoryDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow
                as="div"
                label={$tr("common.source")}
                hint={`${sourceLabel}${sourceDescription.detail ? ` - ${sourceDescription.detail}` : ""}`}
                hintTitle={sourceTitle}
              >
                <SegmentedControl
                  value={inventorySource}
                  options={inventorySourceOptions}
                  onChange={(next) => void selectInventorySource(next)}
                  disabled={switchingSource}
                />
              </SettingsRow>
              <SettingsRow
                label={$tr("settings.autoInventorySync")}
                hint={autoSyncApplies ? undefined : $tr("settings.helperSourceOnly")}
              >
                <input
                  type="checkbox"
                  bind:checked={form.autoInventorySyncEnabled}
                  on:change={autoSave}
                  disabled={!autoSyncApplies}
                  class="accent-accent disabled:opacity-50"
                />
              </SettingsRow>
              <SettingsRow label={$tr("settings.hideFoundryPending")}>
                <input type="checkbox" bind:checked={$hideFoundryClaims} class="accent-accent" />
              </SettingsRow>
              <SettingsRow label={$tr("settings.autoFocusSearch")}>
                <input
                  type="checkbox"
                  bind:checked={$autoFocusSearch}
                  data-setting-auto-focus-search
                  class="accent-accent"
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection title={$tr("common.mastery")} description={$tr("settings.masteryDesc")}>
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.hideFounderItems")}>
                <input
                  type="checkbox"
                  bind:checked={$hideFounderMasteryItems}
                  class="accent-accent"
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          {#if isWindows}
            <SettingsSection
              title={$tr("settings.compatibilityTitle")}
              description={$tr("settings.compatibilityDesc")}
            >
              <div class="mt-2.5 grid gap-1">
                <SettingsRow
                  label={$tr("settings.blockInjection")}
                  hint={$tr("settings.blockInjectionHint")}
                >
                  <input
                    type="checkbox"
                    bind:checked={form.blockThirdPartyInjection}
                    on:change={autoSave}
                    class="accent-accent"
                  />
                </SettingsRow>
              </div>
            </SettingsSection>
          {/if}

          <SettingsSection
            title={$tr("settings.sidebarTabsTitle")}
            description={$tr("settings.sidebarTabsDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              {#each TOGGLEABLE_TABS as tab (tab.view)}
                <SettingsRow label={$tr(tab.labelKey)}>
                  <input
                    type="checkbox"
                    bind:checked={tabChecked[tab.view]}
                    on:change={() => setTabVisible(tab.view)}
                    class="accent-accent"
                  />
                </SettingsRow>
              {/each}
            </div>
          </SettingsSection>

          {#if isLinux}
            <SettingsSection>
              <ProtonLaunchOption />
            </SettingsSection>

            <SettingsSection>
              <LinuxDisplayBackend />
            </SettingsSection>
          {/if}

          <AboutCard />
        </div>

        <SupportersCard />
      </div>

      <div class="settings-wide-actions pb-3">
        <!-- Five buttons wrap on a narrow window, and the note glued to the last
             one read as a sixth; ml-auto parks it at the end of its own line. -->
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2" data-settings-actions>
          <button class="btn-secondary btn-sm" on:click={resetDefaults}
            >{$tr("settings.resetDefaults")}</button
          >
          <button class="btn-secondary btn-sm" data-tour-restart on:click={() => startTour()}
            >{$tr("settings.showFeatureTour")}</button
          >
          <button class="btn-secondary btn-sm" on:click={openScanDebugFolder}
            >{$tr("settings.openScanDebug")}</button
          >
          <button class="btn-secondary btn-sm" on:click={openLogFolder}
            >{$tr("settings.openLogFolder")}</button
          >
          <button class="btn-secondary btn-sm" on:click={() => currentView.set("setup")}
            >{$tr("settings.redoSetup")}</button
          >
          <span class="ml-auto text-xs text-text-muted">{$tr("settings.changesAutoApply")}</span>
        </div>

        {#if statusMsg}
          <p class="m-0 min-h-4 text-sm text-text-secondary" class:text-danger={statusError}>
            {statusMsg}
          </p>
        {/if}
      </div>
    {:else if settingsTab === "appearance"}
      <div class="settings-tab-grid settings-masonry py-3">
        <AppearanceCard />
      </div>
    {:else if settingsTab === "overlay"}
      <div class="settings-tab-grid settings-masonry py-3">
        <SettingsSection
          title={$tr("settings.overlayAvailabilityTitle")}
          description={$tr("settings.overlayAvailabilityDesc")}
        >
          <div class="mt-2.5 grid gap-1">
            <SettingsRow
              label={$tr("settings.relicRewardsOverlay")}
              dataSetting="relicRewardsOverlay"
            >
              <input
                type="checkbox"
                bind:checked={form.relicRewardsOverlayEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow
              label={$tr("settings.relicRecommendationOverlay")}
              dataSetting="relicRecommendationOverlay"
            >
              <input
                type="checkbox"
                bind:checked={form.relicRecommendationOverlayEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow
              label={$tr("settings.tradeDetectedOverlay")}
              dataSetting="tradeNotificationOverlay"
            >
              <input
                type="checkbox"
                bind:checked={form.tradeNotificationOverlayEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow label={$tr("settings.rivenOverlay")} dataSetting="rivenOverlay">
              <input
                type="checkbox"
                bind:checked={form.rivenOverlayEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow
              label={$tr("settings.arbiSummaryOverlay")}
              dataSetting="arbiSummaryOverlay"
            >
              <input
                type="checkbox"
                bind:checked={form.arbiSummaryOverlayEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>
          </div>
        </SettingsSection>

        <SettingsSection
          title={$tr("settings.scanDiagnosticsTitle")}
          description={$tr("settings.scanDiagnosticsDesc")}
        >
          <div class="mt-2.5 grid gap-1">
            <SettingsRow label={$tr("settings.ocrDebugImages")}>
              <input
                type="checkbox"
                bind:checked={form.ocrDebugImagesEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>
          </div>
        </SettingsSection>

        <SettingsSection title={$tr("settings.overlayTitle")}>
          <p class="mt-1 text-xs leading-tight text-text-muted">
            {$tr("settings.overlayRequirements")}
          </p>

          <div class="mt-2.5 grid gap-1">
            <SettingsRow label={$tr("settings.autoTrigger")}>
              <input
                type="checkbox"
                bind:checked={form.autoTriggerEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow
              label={$tr("settings.warframeUiScaleAutoToggle")}
              dataSetting="warframe-ui-scale-auto"
            >
              <input
                type="checkbox"
                bind:checked={form.warframeUiScaleAuto}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow
              label={$tr("settings.warframeUiScale")}
              hint={uiScaleDetected != null ? $tr("settings.warframeUiScaleAuto") : undefined}
              inputRow
              dataSetting="warframe-ui-scale"
            >
              <div class="settings-range-control">
                <input
                  type="range"
                  min="0.5"
                  max="1"
                  step="0.01"
                  value={uiScaleDetected ?? form.warframeUiScale}
                  disabled={uiScaleDetected != null}
                  on:change={(e) => {
                    form.warframeUiScale = Number(e.currentTarget.value);
                    autoSave();
                  }}
                  class="settings-range"
                />
                <span class="settings-range-value"
                  >{Math.round((uiScaleDetected ?? form.warframeUiScale) * 100)}%</span
                >
              </div>
            </SettingsRow>

            {#each OVERLAY_SCALE_ROWS as row (row.key)}
              <SettingsRow label={$tr(row.labelKey)} inputRow>
                <div class="settings-range-control">
                  <input
                    type="range"
                    min="0.75"
                    max="1.5"
                    step="0.05"
                    value={windowScales[row.key] ?? overlayScale}
                    on:change={(e) => saveWindowScale(row.key, Number(e.currentTarget.value))}
                    class="settings-range"
                  />
                  <span class="settings-range-value"
                    >{Math.round((windowScales[row.key] ?? overlayScale) * 100)}%</span
                  >
                </div>
              </SettingsRow>
            {/each}

            <SettingsRow label={$tr("settings.hotkeyFallback")}>
              <input
                type="checkbox"
                bind:checked={form.hotkeyEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow label={$tr("settings.hotkey")} inputRow>
              <input
                type="text"
                bind:value={form.hotkey}
                disabled={!form.hotkeyEnabled}
                placeholder={$tr("settings.hotkeyPlaceholder")}
                on:keydown={(e) => recordHotkey("hotkey", e)}
                on:change={autoSave}
                class="settings-input"
              />
            </SettingsRow>

            <SettingsRow label={$tr("settings.interactionHotkeyEnabled")}>
              <input
                type="checkbox"
                bind:checked={form.interactionHotkeyEnabled}
                on:change={autoSave}
                class="accent-accent"
              />
            </SettingsRow>

            <SettingsRow label={$tr("settings.interactionHotkey")} inputRow>
              <input
                type="text"
                bind:value={form.interactionHotkey}
                disabled={!form.interactionHotkeyEnabled}
                placeholder={$tr("settings.interactionHotkeyPlaceholder")}
                on:keydown={(e) => recordHotkey("interactionHotkey", e)}
                on:change={autoSave}
                class="settings-input"
              />
            </SettingsRow>
          </div>
        </SettingsSection>
      </div>

      <div class="settings-wide-actions pb-3">
        <div class="flex flex-wrap items-center gap-2.5">
          <button class="btn-secondary btn-sm" on:click={resetDefaults}
            >{$tr("settings.resetDefaults")}</button
          >
          <button class="btn-secondary btn-sm" on:click={testTrigger}
            >{$tr("settings.testTrigger")}</button
          >
          <span class="text-xs text-text-muted">{$tr("settings.changesAutoApply")}</span>
        </div>

        {#if statusMsg}
          <p class="m-0 min-h-4 text-sm text-text-secondary" class:text-danger={statusError}>
            {statusMsg}
          </p>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  /* Size container so the supporters panel can query the real content width
     (the viewport lies once the sidebar expands). */
  .settings-shell {
    container-type: inline-size;
  }

  .settings-tab-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 0.85rem;
    align-items: start;
  }

  /* Positioning context for the supporters panel, which floats in the dead
     space right of the 1120px view cap on wide windows. */
  .settings-general-layout {
    position: relative;
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

  /* Multicol packs cards tight; grid rows would leave dead space under short cards. */
  .settings-masonry {
    display: block;
    columns: 3 320px;
    column-gap: 0.85rem;
  }

  .settings-masonry > :global(article) {
    break-inside: avoid;
    margin-bottom: 0.85rem;
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
