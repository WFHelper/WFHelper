<script lang="ts">
  import {
    OVERLAY_LAYOUT_KINDS,
    getOverlayDescriptor,
    type OverlayLayoutKind,
  } from "../../config/shared/overlayLayout.js";
  import { onDestroy, onMount, tick } from "svelte";
  import {
    overlaySettings,
    overlaySettingsLoaded,
    OVERLAY_DEFAULTS,
    applyOverlaySettingsResponse,
    detectedWarframeUiScale,
  } from "../stores/overlaySettings.js";
  import AppearanceCard from "../components/settings/AppearanceCard.svelte";
  import CustomCssSection from "../components/settings/CustomCssSection.svelte";
  import SidebarTabsSection from "../components/settings/SidebarTabsSection.svelte";
  import WorkspaceSection from "../components/settings/WorkspaceSection.svelte";
  import SettingsSection from "../components/settings/SettingsSection.svelte";
  import SettingsRow from "../components/settings/SettingsRow.svelte";
  import OverlayOpacityControl from "../components/settings/OverlayOpacityControl.svelte";
  import AboutCard from "../components/settings/AboutCard.svelte";
  import SupportersCard from "../components/settings/SupportersCard.svelte";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";
  import ProtonLaunchOption from "../components/ProtonLaunchOption.svelte";
  import LinuxDisplayBackend from "../components/LinuxDisplayBackend.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import NotificationSoundSettings from "../components/NotificationSoundSettings.svelte";
  import RewardOverlayEditor from "../components/RewardOverlayEditor.svelte";
  import OverlayPlacementDialog from "../components/setup/OverlayPlacementDialog.svelte";
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
    APPEARANCE_TABS,
    appearanceTab,
    autoFocusSearch,
    hideFoundryClaims,
    hideFounderMasteryItems,
    settingsCategory,
    settingsSectionTarget,
    SETTINGS_CATEGORIES,
    showFoundryReadyBadges,
    showMasteredBadges,
    showOwnedParentBadges,
    showVaultedBadges,
    type AppearanceTab,
    type SettingsCategory,
    type SettingsSectionTarget,
  } from "../stores/preferences.js";
  import { startTour } from "../stores/tour.js";
  import { currentView } from "../stores/app.js";
  import type { InventorySource, OverlaySettings, OverlayWindowKey } from "../types/ipc.js";
  import {
    DEFAULT_SOURCE_CHANNELS,
    ROUTABLE_NOTIFICATION_SOURCES,
  } from "../../config/shared/notifications.js";
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

  const CATEGORY_LABEL_KEYS: Record<SettingsCategory, MessageKey> = {
    general: "settings.tabGeneral",
    notifications: "settings.notificationsTitle",
    inventory: "settings.categoryInventory",
    overlay: "common.overlays",
    appearance: "common.appearance",
    about: "settings.aboutTitle",
  };

  const APPEARANCE_TAB_LABEL_KEYS: Record<AppearanceTab, MessageKey> = {
    theme: "settings.appearanceTabTheme",
    colors: "appearance.colors",
    overlays: "common.overlays",
    sidebar: "settings.appearanceTabSidebar",
    css: "customCss.title",
  };

  $: categoryTabs = SETTINGS_CATEGORIES.map((category) => ({
    key: category,
    label: $tr(CATEGORY_LABEL_KEYS[category]),
  }));

  function selectCategory(key: string): void {
    const next = SETTINGS_CATEGORIES.find((category) => category === key);
    if (next) settingsCategory.set(next);
  }

  $: if ($settingsCategory === "general" && $settingsSectionTarget) {
    void revealSection($settingsSectionTarget);
  }

  let initialLoads: Promise<void> | undefined;

  async function revealSection(target: SettingsSectionTarget): Promise<void> {
    settingsSectionTarget.set(null);
    const scroll = (): void =>
      document.querySelector(`[data-settings-section="${target}"]`)?.scrollIntoView({
        block: "start",
      });
    await tick();
    scroll();
    await initialLoads;
    await tick();
    scroll();
  }

  let placementOpen = false;
  let customizationRevision = 0;
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

  async function selectInventorySource(next: InventorySource): Promise<void> {
    if (switchingSource || next === inventorySource) return;
    switchingSource = true;
    try {
      if (next === "helper" || next === "none") {
        await invoke("setInventorySource", next);
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
  let rewardEditorOpen = false;
  let editorKind: OverlayLayoutKind = "reward";

  async function reloadOverlaySettings(): Promise<void> {
    try {
      const saved = await invoke("getOverlaySettings");
      if (saved) {
        applyOverlaySettingsResponse(saved);
        applyToForm($overlaySettings);
      }
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
    }
  }

  function closeRewardEditor(): void {
    rewardEditorOpen = false;
    void reloadOverlaySettings();
  }

  function closePlacement(): void {
    placementOpen = false;
    void reloadOverlaySettings();
  }

  async function saveWindowScale(key: OverlayWindowKey, value: number): Promise<void> {
    windowScales = { ...windowScales, [key]: value };
    try {
      const result = await invoke("saveOverlayScale", key, value);
      if (!result?.ok) flashStatus($tr("settings.saveFailed"), true);
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
    }
  }

  const OVERLAY_FORM_KEYS = [
    "autoTriggerEnabled",
    "notificationSoundEnabled",
    "notificationSoundUsesSystem",
    "notificationSoundVolume",
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
    "missionTrackingEnabled",
    "autoInventorySyncEnabled",
    "ocrDebugImagesEnabled",
    "blockThirdPartyInjection",
    "keepRunningOnClose",
    "warframeLifecycleEnabled",
    "warframeUiScale",
    "warframeUiScaleAuto",
    "hotkeyEnabled",
    "hotkey",
    "interactionHotkeyEnabled",
    "interactionHotkey",
    "rivenRescanHotkeyEnabled",
    "rivenRescanHotkey",
    "linuxOverlaysInteractive",
  ] as const;

  type OverlayForm = Pick<typeof OVERLAY_DEFAULTS, (typeof OVERLAY_FORM_KEYS)[number]>;
  type OverlayToggleKey = {
    [K in keyof OverlayForm]: OverlayForm[K] extends boolean ? K : never;
  }[keyof OverlayForm];

  const OVERLAY_TOGGLE_ROWS: Array<{
    key: OverlayToggleKey;
    labelKey: MessageKey;
    dataSetting: string;
  }> = [
    {
      key: "relicRewardsOverlayEnabled",
      labelKey: "settings.relicRewardsOverlay",
      dataSetting: "relicRewardsOverlay",
    },
    {
      key: "relicRecommendationOverlayEnabled",
      labelKey: "settings.relicRecommendationOverlay",
      dataSetting: "relicRecommendationOverlay",
    },
    {
      key: "tradeNotificationOverlayEnabled",
      labelKey: "settings.tradeDetectedOverlay",
      dataSetting: "tradeNotificationOverlay",
    },
    { key: "rivenOverlayEnabled", labelKey: "settings.rivenOverlay", dataSetting: "rivenOverlay" },
    {
      key: "arbiSummaryOverlayEnabled",
      labelKey: "settings.arbiSummaryOverlay",
      dataSetting: "arbiSummaryOverlay",
    },
  ];

  // exactOptionalPropertyTypes rejects dataSetting={undefined}, so rows spread it.
  const HOTKEY_ROWS: Array<{
    enabledKey: OverlayToggleKey;
    field: HotkeyField;
    enabledLabelKey: MessageKey;
    labelKey: MessageKey;
    placeholderKey: MessageKey;
    hintKey?: MessageKey;
    enabledAttrs: { dataSetting?: string };
    attrs: { dataSetting?: string };
  }> = [
    {
      enabledKey: "hotkeyEnabled",
      field: "hotkey",
      enabledLabelKey: "settings.hotkeyFallback",
      labelKey: "settings.hotkey",
      placeholderKey: "settings.hotkeyPlaceholder",
      enabledAttrs: {},
      attrs: {},
    },
    {
      enabledKey: "interactionHotkeyEnabled",
      field: "interactionHotkey",
      enabledLabelKey: "settings.interactionHotkeyEnabled",
      labelKey: "settings.interactionHotkey",
      placeholderKey: "settings.interactionHotkeyPlaceholder",
      enabledAttrs: {},
      attrs: {},
    },
    {
      enabledKey: "rivenRescanHotkeyEnabled",
      field: "rivenRescanHotkey",
      enabledLabelKey: "settings.rivenRescanHotkeyEnabled",
      labelKey: "settings.rivenRescanHotkey",
      placeholderKey: "settings.interactionHotkeyPlaceholder",
      hintKey: "settings.rivenRescanHotkeyHint",
      enabledAttrs: { dataSetting: "riven-rescan-hotkey-enabled" },
      attrs: { dataSetting: "riven-rescan-hotkey" },
    },
  ];

  // A missing key takes its declared default; coercing absence to false silently disables hotkeys. A hotkey cleared to "" is absence too.
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
  let overlayScale = OVERLAY_DEFAULTS.overlayScale;

  function applyToForm(s: OverlaySettingsFormInput): void {
    form = normalizeOverlayForm(s);
    overlayScale = s.overlayScale ?? OVERLAY_DEFAULTS.overlayScale;
    windowScales = { ...(s.overlayWindowScales || {}) };
  }

  $: uiScaleDetected = form.warframeUiScaleAuto ? $detectedWarframeUiScale : null;

  // Live updates arrive via the warframe-ui-scale-updated push whenever the game saves EE.cfg.
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
    inventorySelections: "settings.channelSourceInventorySelections",
  };

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

  // Only main knows the saved URLs, so the drafts stay empty and the row shows the masked form.
  async function refreshChannels(): Promise<void> {
    try {
      channelState = await invoke("getNotificationChannels");
    } catch {
      channelState = null;
    }
  }

  function channelToggles(source: NotificationSource): SourceChannelToggles {
    return channelState?.sources[source] ?? DEFAULT_SOURCE_CHANNELS[source];
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

  async function saveGameGate(enabled: boolean, announce = true): Promise<void> {
    try {
      channelState = await invoke("setNotificationGameGate", enabled);
      if (announce) flashStatus($tr("settings.saved"), false);
    } catch {
      flashStatus($tr("settings.saveFailed"), true);
      await refreshChannels();
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

  async function loadInitialState(): Promise<void> {
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
    window.addEventListener("focus", refreshDetectedUiScale);
    await refreshInventorySource();
    await refreshChannels();
  }

  onMount(() => {
    initialLoads = loadInitialState();
  });

  onDestroy(() => window.removeEventListener("focus", refreshDetectedUiScale));

  let saveRevision = 0;
  let saveQueue: Promise<void> = Promise.resolve();

  // An emptied number input binds to null, which the main-process clamp reads as 0.
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

  function autoSave(): void {
    void save();
  }

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

  type HotkeyField = "hotkey" | "interactionHotkey" | "rivenRescanHotkey" | "tradeRepHotkey";

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
    ).then(() => saveGameGate(false, false));
  }

  function testTrigger() {
    send("simulate-relic-trigger");
  }

  function switchLinuxOverlayInteraction(): void {
    form.linuxOverlaysInteractive = !form.linuxOverlaysInteractive;
    autoSave();
  }
</script>

<section class="view active w-full">
  <div class="mx-auto w-full max-w-[1320px]">
    <div class="view-header mb-2">
      <h2>{$tr("common.settings")}</h2>
      <p
        class="m-0 text-xs {statusMsg
          ? statusError
            ? 'text-danger'
            : 'text-text-secondary'
          : 'text-text-muted'}"
        role="status"
        data-settings-status
      >
        {statusMsg || $tr("settings.changesAutoApply")}
      </p>
    </div>

    <nav
      class="mb-4 flex items-end border-b border-border-subtle"
      aria-label={$tr("settings.categoriesLabel")}
      data-tour="settings-tabs"
    >
      <HeaderTabs options={categoryTabs} activeKey={$settingsCategory} onSelect={selectCategory} />
    </nav>

    <div class="min-w-0 pb-3" data-settings-panel={$settingsCategory}>
      {#if $settingsCategory === "general"}
        <div class="settings-masonry">
          <SettingsSection title={$tr("settings.languageTitle")}>
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
            title={$tr("settings.behaviorTitle")}
            info={isWindows
              ? `${$tr("settings.behaviorInfo")} ${$tr("settings.warframeLifecycleInfo")}`
              : $tr("settings.behaviorInfo")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.keepRunningOnClose")} dataSetting="keep-running">
                <input
                  type="checkbox"
                  bind:checked={form.keepRunningOnClose}
                  on:change={autoSave}
                />
              </SettingsRow>
              {#if isWindows}
                <SettingsRow
                  label={$tr("settings.warframeLifecycle")}
                  hint={$tr("settings.warframeLifecycleHint")}
                  dataSetting="warframe-lifecycle"
                >
                  <input
                    type="checkbox"
                    bind:checked={form.warframeLifecycleEnabled}
                    on:change={autoSave}
                  />
                </SettingsRow>
              {/if}
              <SettingsRow label={$tr("settings.autoFocusSearch")}>
                <input
                  type="checkbox"
                  bind:checked={$autoFocusSearch}
                  data-setting-auto-focus-search
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("common.inventory")}
            description={$tr("settings.inventoryDesc")}
            info={$tr("settings.inventoryInfo")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow
                as="div"
                label={$tr("common.source")}
                dataSetting="inventory-source"
                wrapControl
                hint={inventorySource === "none"
                  ? undefined
                  : `${sourceLabel}${sourceDescription.detail ? ` - ${sourceDescription.detail}` : ""}`}
                hintTitle={sourceTitle}
              >
                <SegmentedControl
                  value={inventorySource}
                  options={inventorySourceOptions}
                  onChange={(next) => void selectInventorySource(next)}
                  disabled={switchingSource}
                  wrap
                />
              </SettingsRow>
              {#if inventorySource === "none"}
                <p class="text-xs leading-relaxed text-text-secondary" data-no-inventory-hint>
                  {$tr("setup.source.none.desc")}
                </p>
              {/if}
              <SettingsRow
                label={$tr("settings.autoInventorySync")}
                hint={autoSyncApplies ? undefined : $tr("settings.helperSourceOnly")}
              >
                <input
                  type="checkbox"
                  bind:checked={form.autoInventorySyncEnabled}
                  on:change={autoSave}
                  disabled={!autoSyncApplies}
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection title={$tr("settings.creditHelp")}>
            <div class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2" data-settings-actions>
              <button class="btn-secondary btn-sm" data-tour-restart on:click={() => startTour()}
                >{$tr("settings.showFeatureTour")}</button
              >
              <button class="btn-secondary btn-sm" on:click={() => currentView.set("setup")}
                >{$tr("settings.redoSetup")}</button
              >
            </div>
          </SettingsSection>
        </div>

        <h3
          class="mt-1 mb-2.5 font-display text-[0.84rem] font-bold tracking-[0.08em] text-text-secondary uppercase"
        >
          {$tr("settings.categoryAdvanced")}
        </h3>
        <div class="settings-masonry">
          {#if isWindows}
            <SettingsSection
              title={$tr("settings.compatibilityTitle")}
              description={$tr("settings.compatibilityDesc")}
              info={$tr("settings.compatibilityInfo")}
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
                  />
                </SettingsRow>
              </div>
            </SettingsSection>
          {/if}

          {#if isLinux}
            <SettingsSection>
              <ProtonLaunchOption />
            </SettingsSection>

            <SettingsSection>
              <LinuxDisplayBackend />
            </SettingsSection>
          {/if}

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
                />
              </SettingsRow>
            </div>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button class="btn-secondary btn-sm" on:click={openScanDebugFolder}
                >{$tr("settings.openScanDebug")}</button
              >
              <button class="btn-secondary btn-sm" on:click={openLogFolder}
                >{$tr("settings.openLogFolder")}</button
              >
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
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("enemy.missions")}
            description={$tr("settings.missionsDesc")}
            sectionId="missions"
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.trackMissions")} dataSetting="missionTracking">
                <input
                  type="checkbox"
                  bind:checked={form.missionTrackingEnabled}
                  on:change={autoSave}
                />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("common.reset")}
            description={$tr("settings.resetDesc")}
            info={$tr("settings.resetInfo")}
          >
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button class="btn-secondary btn-sm" data-settings-reset on:click={resetDefaults}
                >{$tr("settings.resetDefaults")}</button
              >
            </div>
          </SettingsSection>
        </div>
      {:else if $settingsCategory === "notifications"}
        <div class="settings-masonry">
          <SettingsSection title={$tr("settings.desktopNotificationsTitle")}>
            <div class="mt-2.5 grid gap-1">
              <SettingsRow
                label={$tr("settings.notifyOnlyWhileGameRunning")}
                hint={$tr("settings.notifyOnlyWhileGameRunningHint")}
              >
                <input
                  type="checkbox"
                  data-setting="notify-only-while-game-running"
                  checked={channelState?.nativeOnlyWhileGameRunning ?? false}
                  on:change={(event) => saveGameGate(event.currentTarget.checked)}
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.wfmDmNotifications")}>
                <input
                  type="checkbox"
                  bind:checked={form.wfmNotificationsEnabled}
                  on:change={autoSave}
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.inGameMessageNotifications")}>
                <input
                  type="checkbox"
                  bind:checked={form.messageNotificationsEnabled}
                  on:change={autoSave}
                />
              </SettingsRow>

              <SettingsRow
                label={$tr("settings.notifyWhileFocused")}
                hint={$tr("settings.notifyWhileFocusedHint")}
                dimmed={!form.messageNotificationsEnabled}
              >
                <input
                  type="checkbox"
                  bind:checked={form.messageNotificationsWhileFocused}
                  disabled={!form.messageNotificationsEnabled}
                  on:change={autoSave}
                />
              </SettingsRow>

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
            </div>
          </SettingsSection>

          <SettingsSection title={$tr("settings.soundTitle")}>
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.windowsNotifSound")}>
                <input
                  type="checkbox"
                  bind:checked={form.notificationSoundEnabled}
                  on:change={autoSave}
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
                  />
                </SettingsRow>
              {/if}

              <NotificationSoundSettings
                enabled={form.notificationSoundEnabled}
                system={isWindows && form.notificationSoundUsesSystem}
                volume={form.notificationSoundVolume}
                onVolumeChange={(value) => {
                  form.notificationSoundVolume = value;
                  autoSave();
                }}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.channelSourceTrade")}
            description={$tr("settings.tradesDesc")}
          >
            <div class="mt-2.5 grid gap-1">
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
                />
              </SettingsRow>

              <SettingsRow label={$tr("settings.unlistOnTrade")}>
                <input
                  type="checkbox"
                  bind:checked={form.autoCloseWfmOrders}
                  on:change={autoSave}
                />
              </SettingsRow>

              <SettingsRow
                label={$tr("settings.tradeRepKeybindEnable")}
                hint={$tr("settings.tradeRepKeybindHint")}
              >
                <input
                  type="checkbox"
                  bind:checked={form.tradeRepHotkeyEnabled}
                  on:change={autoSave}
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
            info={$tr("settings.notificationChannelsInfo")}
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
                {@const toggles =
                  channelState?.sources[row.source] ?? DEFAULT_SOURCE_CHANNELS[row.source]}
                <SettingsRow
                  label={$tr(row.labelKey)}
                  dataSetting={`notify-source-${row.source}`}
                  as="div"
                >
                  <span class="flex items-center gap-3">
                    <label class="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={toggles.native}
                        on:change={(event) =>
                          saveSourceChannel(row.source, "native", event.currentTarget.checked)}
                      />
                      {$tr("settings.channelNative")}
                    </label>
                    <label class="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
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

          <SettingsSection>
            <FissureAlerts />
          </SettingsSection>
        </div>
      {:else if $settingsCategory === "inventory"}
        <div class="settings-masonry">
          <SettingsSection
            title={$tr("settings.itemListsTitle")}
            description={$tr("settings.masteryDesc")}
            info={$tr("settings.itemListsInfo")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.hideFoundryPending")}>
                <input type="checkbox" bind:checked={$hideFoundryClaims} />
              </SettingsRow>
              <SettingsRow label={$tr("settings.hideFounderItems")}>
                <input type="checkbox" bind:checked={$hideFounderMasteryItems} />
              </SettingsRow>
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.badgesTitle")}
            description={$tr("settings.badgesDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow
                label={$tr("settings.showMasteredBadges")}
                dataSetting="show-mastered-badges"
              >
                <input type="checkbox" bind:checked={$showMasteredBadges} />
              </SettingsRow>
              <SettingsRow
                label={$tr("settings.showOwnedParentBadges")}
                dataSetting="show-owned-parent-badges"
              >
                <input type="checkbox" bind:checked={$showOwnedParentBadges} />
              </SettingsRow>
              <SettingsRow
                label={$tr("settings.showFoundryReadyBadges")}
                dataSetting="show-foundry-ready-badges"
              >
                <input type="checkbox" bind:checked={$showFoundryReadyBadges} />
              </SettingsRow>
              <SettingsRow
                label={$tr("settings.showVaultedBadges")}
                dataSetting="show-vaulted-badges"
              >
                <input type="checkbox" bind:checked={$showVaultedBadges} />
              </SettingsRow>
            </div>
          </SettingsSection>
        </div>
      {:else if $settingsCategory === "overlay"}
        <div class="settings-masonry">
          <SettingsSection title={$tr("settings.overlayAvailabilityTitle")}>
            <div class="mt-2.5 grid gap-1">
              {#each OVERLAY_TOGGLE_ROWS as row (row.key)}
                <SettingsRow label={$tr(row.labelKey)} dataSetting={row.dataSetting}>
                  <input type="checkbox" bind:checked={form[row.key]} on:change={autoSave} />
                </SettingsRow>
              {/each}
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.detectionTitle")}
            description={$tr("settings.overlayDesc")}
            info={$tr("settings.overlayRequirements")}
          >
            <div class="mt-2.5 grid gap-1">
              <SettingsRow label={$tr("settings.autoTrigger")}>
                <input
                  type="checkbox"
                  bind:checked={form.autoTriggerEnabled}
                  on:change={autoSave}
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
            </div>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button class="btn-secondary btn-sm" on:click={testTrigger}
                >{$tr("settings.testTrigger")}</button
              >
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("settings.hotkeysTitle")}
            description={$tr("settings.hotkeysDesc")}
          >
            <div class="mt-2.5 grid gap-1">
              {#each HOTKEY_ROWS as row (row.field)}
                <SettingsRow
                  label={$tr(row.enabledLabelKey)}
                  hint={row.hintKey ? $tr(row.hintKey) : undefined}
                  {...row.enabledAttrs}
                >
                  <input type="checkbox" bind:checked={form[row.enabledKey]} on:change={autoSave} />
                </SettingsRow>

                <SettingsRow label={$tr(row.labelKey)} inputRow {...row.attrs}>
                  <input
                    type="text"
                    bind:value={form[row.field]}
                    disabled={!form[row.enabledKey]}
                    placeholder={$tr(row.placeholderKey)}
                    on:keydown={(e) => recordHotkey(row.field, e)}
                    on:change={autoSave}
                    class="settings-input"
                  />
                </SettingsRow>
              {/each}
            </div>
            {#if isLinux}
              <div class="mt-2.5 flex flex-wrap gap-2">
                <button
                  class="btn-secondary btn-sm"
                  data-linux-overlay-interaction
                  on:click={switchLinuxOverlayInteraction}
                  >{form.linuxOverlaysInteractive
                    ? $tr("settings.linuxOverlaysClickThrough")
                    : $tr("settings.linuxOverlaysInteractive")}</button
                >
              </div>
            {/if}
          </SettingsSection>

          <SettingsSection title={$tr("settings.overlaySizeTitle")}>
            <div class="mt-2.5 grid gap-1">
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
            </div>
          </SettingsSection>

          <SettingsSection
            title={$tr("overlayPlacement.title")}
            description={$tr("settings.overlayPlacement.desc")}
          >
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button
                class="btn-secondary btn-sm"
                aria-haspopup="dialog"
                aria-expanded={placementOpen}
                data-open-overlay-placement
                on:click={() => (placementOpen = true)}
                >{$tr("settings.overlayPlacement.open")}</button
              >
            </div>
          </SettingsSection>
        </div>
      {:else if $settingsCategory === "appearance"}
        <div class="filter-tabs mb-3" data-appearance-tabs>
          {#each APPEARANCE_TABS as tab (tab)}
            <button
              type="button"
              class="filter-tab"
              class:active={$appearanceTab === tab}
              aria-pressed={$appearanceTab === tab}
              data-appearance-tab={tab}
              on:click={() => appearanceTab.set(tab)}>{$tr(APPEARANCE_TAB_LABEL_KEYS[tab])}</button
            >
          {/each}
        </div>

        <div data-appearance-panel={$appearanceTab}>
          {#if $appearanceTab === "theme"}
            <div class="settings-masonry">
              <AppearanceCard section="theme" />
            </div>
          {:else if $appearanceTab === "colors"}
            <div class="settings-grid">
              <AppearanceCard section="colors" />
            </div>
          {:else if $appearanceTab === "overlays"}
            <div class="settings-grid">
              <SettingsSection title={$tr("overlayEditor.title")}>
                <div class="mt-2.5 grid gap-1">
                  {#each OVERLAY_LAYOUT_KINDS as kind (kind)}
                    <SettingsRow label={$tr(getOverlayDescriptor(kind).titleKey)} as="div">
                      <button
                        class="btn-secondary btn-sm"
                        data-overlay-editor-open={kind}
                        on:click={() => {
                          editorKind = kind;
                          rewardEditorOpen = true;
                        }}>{$tr("common.customize")}</button
                      >
                    </SettingsRow>
                  {/each}
                </div>
              </SettingsSection>
              <SettingsSection
                title={$tr("appearance.overlayOpacity")}
                description={$tr("appearance.overlayOpacityHint")}
              >
                <OverlayOpacityControl />
              </SettingsSection>
            </div>
          {:else if $appearanceTab === "sidebar"}
            <div class="settings-grid">
              {#key customizationRevision}
                <SidebarTabsSection />
              {/key}
              <WorkspaceSection
                onCustomizationApplied={() => {
                  applyToForm($overlaySettings);
                  customizationRevision += 1;
                }}
              />
            </div>
          {:else}
            <div class="settings-grid">
              <CustomCssSection />
            </div>
          {/if}
        </div>
      {:else}
        <div class="settings-grid">
          <AboutCard />
          <SupportersCard />
        </div>
      {/if}
    </div>
  </div>
</section>

{#if rewardEditorOpen}
  <RewardOverlayEditor kind={editorKind} onClose={closeRewardEditor} />
{/if}
{#if placementOpen}
  <OverlayPlacementDialog onClose={closePlacement} />
{/if}

<style>
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

  .settings-masonry {
    columns: 3 320px;
    column-gap: 0.85rem;
  }

  .settings-masonry > :global(article) {
    break-inside: avoid;
    margin-bottom: 0.85rem;
  }

  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 0.85rem;
    align-items: start;
  }
</style>
