import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { isObject } from "./ipcValidators";
import { toNonEmptyString } from "../config/shared/stringValidation";
import type { WfmStatus } from "../config/shared/wfm";
import { isWfmSlug } from "../config/shared/wfm";
import { SUBTYPE_REQUIRED_CODE, subtypeChoicesOf } from "../config/shared/wfmOrders";
import {
  errorCode,
  parseContractsPayload,
  parseCreateOrderParams,
  parseCredentials,
  parseDeleteOrderPayload,
  parseSearchPayload,
  parseSetVisiblePayload,
  parseStatusPayload,
  parseUpdateOrderPayload,
} from "./wfmValidators";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "../services/logger";
import * as wfmSession from "../services/wfmSession";
import * as wfmOrders from "../services/wfmOrders";
import * as wfmContracts from "../services/wfmContracts";
import * as wfmCatalog from "../services/wfmCatalog";
import * as wfmPresence from "../services/wfmPresence";
import { startListening, stopListening } from "../services/wfmWebSocketListener";
import ctx from "./context";
import {
  WFM_SIGNIN,
  WFM_SIGNOUT,
  WFM_SESSION,
  WFM_GET_ORDERS,
  WFM_GET_CONTRACTS,
  WFM_CREATE_ORDER,
  WFM_UPDATE_ORDER,
  WFM_DELETE_ORDER,
  WFM_SET_VISIBLE,
  WFM_SEARCH_ITEMS,
  WFM_LOOKUP_ITEM,
  WFM_GET_ME,
  WFM_SET_STATUS,
  WFM_PRESENCE_STATE,
  WFM_NOTIFICATION,
} from "../config/shared/ipcChannels";
import { registerWfmFixtures } from "./wfmFixtureIpc";

const log = withScope("wfmIpc");

async function withWfmError<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: string,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const message = normalizeErrorMessage(err, fallback);
    log.error(`[WFM IPC] ${label}:`, message);
    if (errorCode(err) === "WFM_UNAUTHORIZED") void wfmSession.signOut();
    return { error: message };
  }
}

/** Everything that has to come up behind a live token, from sign-in or restore. */
function _startSessionServices(): void {
  const token = wfmSession.getToken();
  if (!token) return;
  startListening(token, _handleWfmEvent, _handleWfmAuthGiveUp);
  void wfmPresence.refreshFromServer().then(() => wfmPresence.resync());
}

function _handleWfmEvent(route: string, payload: unknown): void {
  // WFM announces the account status on sign-in and whenever it changes, expiry
  // included - that push is what keeps our countdown honest across restarts.
  if (route.includes("status/set")) {
    wfmPresence.applyServerStatus(payload);
    return;
  }

  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;

  // Orders touched from the website or another client. The v2 route names are
  // undocumented, so match the family instead of a fixed list.
  if (/order|auction/i.test(route)) {
    log.info("[WFMListener] Order change pushed:", route);
    win.webContents.send(WFM_NOTIFICATION, { type: "orders-changed" });
    return;
  }

  // Whisper toasts are opt-in; the order sync above is not.
  if (!ctx.overlaySettings?.wfmNotificationsEnabled) return;

  // Whisper / direct message
  if (route.includes("message/new") || route.includes("message/create")) {
    const p = isObject(payload) ? payload : {};
    const from =
      typeof p.from === "string"
        ? p.from
        : typeof (p.user as Record<string, unknown> | undefined)?.ingame_name === "string"
          ? ((p.user as Record<string, unknown>).ingame_name as string)
          : "Unknown";
    const content =
      typeof p.message === "string"
        ? p.message
        : typeof p.raw_message === "string"
          ? p.raw_message
          : route;

    log.info("[WFMListener] Dispatching whisper notification from:", from);
    win.webContents.send(WFM_NOTIFICATION, { type: "whisper", from, content });
  }
}

/** WS listener gave up (token rejected repeatedly) - tell the renderer so the
 * UI can drop to logged-out instead of a fake logged-in state. */
function _handleWfmAuthGiveUp(): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  log.warn("[WFMIpc] WS listener gave up on auth - notifying renderer");
  win.webContents.send(WFM_NOTIFICATION, { type: "listener-auth-failed" });
}

function register(): void {
  if (registerWfmFixtures()) return; // E2E-only stub replaced the whole surface

  handleAuthorized(WFM_SIGNIN, assertMainRendererSender, async (_event, payload) => {
    const creds = parseCredentials(payload);
    if (!creds) {
      log.warn("[Security] wfm:signin blocked due to invalid payload shape");
      return { loggedIn: false, error: "Invalid sign-in payload." };
    }

    try {
      const result = await wfmSession.signIn(creds.email, creds.password);
      _startSessionServices();
      return result;
    } catch (err) {
      return { loggedIn: false, error: normalizeErrorMessage(err, "Sign-in failed.") };
    }
  });

  handleAuthorized(WFM_SIGNOUT, assertMainRendererSender, async () => {
    stopListening();
    wfmPresence.reset();
    return wfmSession.signOut();
  });

  handleAuthorized(WFM_SESSION, assertMainRendererSender, async () => {
    return wfmSession.getSession();
  });

  handleAuthorized(WFM_GET_ORDERS, assertMainRendererSender, async () =>
    withWfmError("get-orders", () => wfmOrders.getMyOrders(), "Failed to fetch orders."),
  );

  handleAuthorized(WFM_GET_CONTRACTS, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseContractsPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:get-contracts blocked due to invalid payload");
      return { error: "Invalid contracts payload." };
    }
    return withWfmError(
      "get-contracts",
      () => wfmContracts.getMyContracts(parsed),
      "Failed to fetch contracts.",
    );
  });

  handleAuthorized(WFM_CREATE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const params = parseCreateOrderParams(payload);
    if (!params) {
      log.warn("[Security] wfm:create-order blocked due to invalid payload");
      return { error: "Invalid create-order payload." };
    }
    return withWfmError(
      "create-order",
      async () => {
        try {
          return await wfmOrders.createOrder(params);
        } catch (err) {
          const subtypes = subtypeChoicesOf(err);
          if (!subtypes) throw err;
          // The renderer has to offer the choice, so this one refusal travels
          // as data instead of a flat error string.
          return {
            error: normalizeErrorMessage(err, "Failed to create order."),
            code: SUBTYPE_REQUIRED_CODE,
            subtypes: [...subtypes],
          };
        }
      },
      "Failed to create order.",
    );
  });

  handleAuthorized(WFM_UPDATE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseUpdateOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:update-order blocked due to invalid payload");
      return { error: "Invalid update-order payload." };
    }
    return withWfmError(
      "update-order",
      () => wfmOrders.updateOrder(parsed.orderId, parsed.updates),
      "Failed to update order.",
    );
  });

  handleAuthorized(WFM_DELETE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseDeleteOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:delete-order blocked due to invalid payload");
      return { error: "Invalid delete-order payload." };
    }
    return withWfmError(
      "delete-order",
      () => wfmOrders.deleteOrder(parsed.orderId),
      "Failed to delete order.",
    );
  });

  handleAuthorized(WFM_SET_VISIBLE, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseSetVisiblePayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:set-visible blocked due to invalid payload");
      return { error: "Invalid set-visible payload." };
    }
    return withWfmError(
      "set-visible",
      () => wfmOrders.setOrdersVisible(parsed.orderIds, parsed.visible),
      "Failed to update order visibility.",
    );
  });

  handleAuthorized(WFM_SEARCH_ITEMS, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseSearchPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:search-items blocked due to invalid payload");
      return { error: "Invalid search payload." };
    }
    return withWfmError(
      "search-items",
      () => wfmCatalog.searchItems(parsed.query, parsed.limit),
      "Failed to search items.",
    );
  });

  handleAuthorized(WFM_LOOKUP_ITEM, assertMainRendererSender, async (_event, payload) => {
    const slugRaw = isObject(payload) ? payload.slug : null;
    const slug = toNonEmptyString(slugRaw, 120)?.toLowerCase() ?? "";

    if (!isWfmSlug(slug)) {
      log.warn("[Security] wfm:lookup-item-by-slug blocked due to invalid payload");
      return { error: "Invalid item slug." };
    }

    try {
      const item = (await wfmCatalog.lookupBySlug(slug)) as {
        id?: unknown;
        item_name?: unknown;
        url_name?: unknown;
        thumb?: unknown;
        icon?: unknown;
      } | null;

      if (!item || typeof item.id !== "string" || typeof item.url_name !== "string") {
        return { error: "Item not found." };
      }

      return {
        id: item.id,
        item_name: typeof item.item_name === "string" ? item.item_name : item.url_name,
        url_name: item.url_name,
        thumb: typeof item.thumb === "string" ? item.thumb : null,
        icon: typeof item.icon === "string" ? item.icon : null,
      };
    } catch (err) {
      return { error: normalizeErrorMessage(err, "Failed to look up item slug.") };
    }
  });

  handleAuthorized(WFM_GET_ME, assertMainRendererSender, async () =>
    withWfmError("get-me", () => wfmSession.getMe(), "Failed to get user profile."),
  );

  handleAuthorized(WFM_SET_STATUS, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseStatusPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:set-status blocked due to invalid payload");
      return { error: "Invalid status. Must be one of: online, ingame, invisible." };
    }

    return withWfmError(
      "set-status",
      async () => {
        await wfmPresence.setManualStatus(parsed.status as WfmStatus);
        return { status: parsed.status as WfmStatus };
      },
      "Failed to set status.",
    );
  });

  handleAuthorized(WFM_PRESENCE_STATE, assertMainRendererSender, async () =>
    wfmPresence.getState(),
  );
}

/** Broadcast presence the main process changed on its own (hold expiry, game launch). */
function _handlePresenceChange(state: wfmPresence.WfmPresenceState): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(WFM_NOTIFICATION, { type: "presence", ...state });
}

wfmPresence.configure({ onChange: _handlePresenceChange });

/** Restarts the WFM socket when session restore finds a saved token. */
function startListenerIfLoggedIn(): void {
  if (!wfmSession.getToken()) return;
  log.info("[WFMIpc] Resuming WS listener after session restore");
  _startSessionServices();
}

export { register, startListenerIfLoggedIn };
export const __test__ = {
  parseCredentials,
  parseCreateOrderParams,
  parseUpdateOrderPayload,
  parseSearchPayload,
  parseStatusPayload,
  parseContractsPayload,
};
