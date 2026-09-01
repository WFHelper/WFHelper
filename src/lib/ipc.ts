import type { IpcEventMap, IpcInvokeMap, IpcSendMap } from "../types/ipc.js";
import type { Translator } from "./i18n.js";

type InvokeKey = keyof IpcInvokeMap;
type TradeInvokeKey =
  | "wfmCreateOrder"
  | "wfmUpdateOrder"
  | "wfmDeleteOrder"
  | "wfmSetVisible"
  | "wfmSetStatus"
  | "createRivenAuction"
  | "updateRivenAuction"
  | "deleteRivenAuction"
  | "workbenchExecutePlan";
type ReadOnlyInvokeKey = Exclude<InvokeKey, TradeInvokeKey>;
type EventChannel = keyof IpcEventMap;
type SendChannel = keyof IpcSendMap;

function assertApi(): void {
  if (!window.api) {
    throw new Error(
      "window.api is undefined - preload bridge failed to initialize. " +
        "Check the DevTools console for '[Preload] FATAL' errors.",
    );
  }
}

function assertTradeApi(): void {
  if (!window.tradeApi) {
    throw new Error(
      "window.tradeApi is undefined - trade preload bridge failed to initialize. " +
        "Check the DevTools console for '[Preload] FATAL' errors.",
    );
  }
}

/** Host OS as reported by the main process (static, exposed on the preload bridge). */
export function getPlatform(): string {
  return window.api?.platform ?? "";
}

export function invoke<K extends ReadOnlyInvokeKey>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["return"]> {
  assertApi();
  const fn = window.api[channel] as (
    ...a: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["return"]>;
  return fn(...args);
}

/** Native main-process confirm; no call site may use window.confirm directly.
 *  Reason in the SYSTEM_CONFIRM handler (ipc/systemIpc.ts). */
export function confirmWithDialog(message: string, t: Translator): Promise<boolean> {
  return invoke("confirmDialog", {
    message,
    okLabel: t("common.confirm"),
    cancelLabel: t("common.cancel"),
  });
}

export function tradeInvoke<K extends TradeInvokeKey>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["return"]> {
  assertTradeApi();
  const fn = window.tradeApi[channel] as (
    ...a: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["return"]>;
  return fn(...args);
}

const eventApiMap: Record<
  EventChannel,
  (cb: (payload: IpcEventMap[EventChannel]) => void) => () => void
> = {
  "inventory-updated": (cb) =>
    window.api.onInventoryUpdated(cb as (data: IpcEventMap["inventory-updated"]) => void),
  "inventory-status-updated": (cb) =>
    window.api.onInventoryStatusUpdated(
      cb as (status: IpcEventMap["inventory-status-updated"]) => void,
    ),
  "item-db-updated": (cb) =>
    window.api.onItemDbUpdated(cb as (data: IpcEventMap["item-db-updated"]) => void),
  "app-update-status": (cb) =>
    window.api.onAppUpdateStatus(cb as (state: IpcEventMap["app-update-status"]) => void),
  "wfm:notification": (cb) =>
    window.api.onWfmNotification(cb as (n: IpcEventMap["wfm:notification"]) => void),
  "helper-download-progress": (cb) =>
    window.api.onHelperDownloadProgress(cb as (p: IpcEventMap["helper-download-progress"]) => void),
  "trade-recorded": (cb) =>
    window.api.onTradeRecorded(cb as (e: IpcEventMap["trade-recorded"]) => void),
  "world-state-fetch-error": (cb) =>
    window.api.onWorldStateFetchError(cb as (m: IpcEventMap["world-state-fetch-error"]) => void),
  "arbi-run-saved": (cb) =>
    window.api.onArbiRunSaved(cb as (run: IpcEventMap["arbi-run-saved"]) => void),
  "arbi-open-run": (cb) =>
    window.api.onArbiOpenRun(cb as (runId: IpcEventMap["arbi-open-run"]) => void),
  "warframe-ui-scale-updated": (cb) =>
    window.api.onWarframeUiScaleUpdated(
      cb as (scale: IpcEventMap["warframe-ui-scale-updated"]) => void,
    ),
  "notification-history-added": (cb) =>
    window.api.onNotificationHistoryAdded(
      cb as (entry: IpcEventMap["notification-history-added"]) => void,
    ),
  "market-alerts:changed": (cb) =>
    window.api.onMarketAlertsChanged(cb as (data: IpcEventMap["market-alerts:changed"]) => void),
  "notification-sound-play": (cb) =>
    window.api.onNotificationSoundPlay(
      cb as (payload: IpcEventMap["notification-sound-play"]) => void,
    ),
  "workbench-state": (cb) =>
    window.api.onWorkbenchState(cb as (state: IpcEventMap["workbench-state"]) => void),
};

export function on<K extends EventChannel>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void,
): () => void {
  return (eventApiMap[channel] as (cb: (payload: IpcEventMap[EventChannel]) => void) => () => void)(
    callback as (payload: IpcEventMap[EventChannel]) => void,
  );
}

const sendApiMap: Record<SendChannel, (...args: never[]) => void> = {
  "window-minimize": () => window.api.minimizeWindow(),
  "window-maximize": () => window.api.maximizeWindow(),
  "window-close": () => window.api.closeWindow(),
  "toggle-overlay": () => window.api.toggleOverlay(),
  "simulate-relic-trigger": () => window.api.simulateRelicTrigger(),
  "overlay-theme-updated": (themeVars: Record<string, string>) =>
    window.api.updateOverlayTheme(themeVars),
  "overlay-locale-updated": (locale: string) => window.api.updateOverlayLocale(locale),
  "game-locale-updated": (locale: string) => window.api.updateGameLocale(locale),
  "overlay:push-relic-filters": (filters: { squadSize: number; tierFilter: string | null }) =>
    window.api.pushRelicFilters(filters),
  "open-external": (url: string) => window.api.openExternal(url),
};

export function send<K extends SendChannel>(channel: K, ...args: IpcSendMap[K]): void {
  (sendApiMap[channel] as (...a: IpcSendMap[K]) => void)(...args);
}
