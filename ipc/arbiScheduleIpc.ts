import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import * as arbiSchedule from "../services/arbiSchedule";
import { dispatch, getChannelState } from "../services/notificationChannels";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import {
  ARBI_SCHED_GET,
  ARBI_SCHED_SET_FAVORITE,
  ARBI_SCHED_SET_LEAD,
  ARBI_SCHED_SET_OCCURRENCE,
} from "../config/shared/ipcChannels";

function nativeAlertsEnabled(): boolean {
  return ctx.overlaySettings.worldNotificationsEnabled !== false;
}

/** Firing an alert consumes its bell, so the schedule may only fire while some
 *  channel can carry it; dispatch() then picks the channels. */
function alertsDeliverable(): boolean {
  const state = getChannelState();
  const routes = state.sources.arbiSchedule;
  if (nativeAlertsEnabled() && routes.native) return true;
  if (!routes.webhook) return false;
  return Object.values(state.webhooks).some((webhook) => webhook.configured);
}

export function register(): void {
  arbiSchedule.initArbiSchedule({
    // Kept on the "app" history kind the raw sender defaults to, so routing an
    // alert through the channel layer does not restyle the existing entries.
    notify: (title, body) =>
      dispatch({ source: "arbiSchedule", title, body }, () => {
        if (!nativeAlertsEnabled()) return;
        sendDesktopNotificationRaw(title, body);
      }),
    notificationsEnabled: alertsDeliverable,
  });

  handleAuthorized(ARBI_SCHED_GET, assertMainRendererSender, () =>
    arbiSchedule.getSchedulePayload(),
  );

  handleAuthorized(
    ARBI_SCHED_SET_OCCURRENCE,
    assertMainRendererSender,
    (_event, key: unknown, enabled: unknown) =>
      typeof key === "string" ? arbiSchedule.setOccurrenceAlert(key, !!enabled) : null,
  );

  handleAuthorized(
    ARBI_SCHED_SET_FAVORITE,
    assertMainRendererSender,
    (_event, nodeId: unknown, enabled: unknown) =>
      typeof nodeId === "string" ? arbiSchedule.setFavoriteNode(nodeId, !!enabled) : null,
  );

  handleAuthorized(ARBI_SCHED_SET_LEAD, assertMainRendererSender, (_event, minutes: unknown) =>
    typeof minutes === "number" ? arbiSchedule.setLeadMinutes(minutes) : null,
  );
}

export function shutdown(): void {
  arbiSchedule.shutdownArbiSchedule();
}
