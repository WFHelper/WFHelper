import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import * as arbiSchedule from "../services/arbiSchedule";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import {
  ARBI_SCHED_GET,
  ARBI_SCHED_SET_FAVORITE,
  ARBI_SCHED_SET_LEAD,
  ARBI_SCHED_SET_OCCURRENCE,
} from "../config/shared/ipcChannels";

export function register(): void {
  arbiSchedule.initArbiSchedule({
    notify: sendDesktopNotificationRaw,
    notificationsEnabled: () => ctx.overlaySettings.worldNotificationsEnabled !== false,
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
