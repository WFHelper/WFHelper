import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import type { WfmStatus } from "../config/shared/wfm";
import {
  errorCode,
  normalizeErrorMessage,
  parseCloseOrderPayload,
  parseContractsPayload,
  parseCreateOrderParams,
  parseCredentials,
  parseDeleteOrderPayload,
  parseSearchPayload,
  parseSetVisiblePayload,
  parseStatusPayload,
  parseUpdateOrderPayload,
} from "./wfmValidators";
import { withScope } from "../services/logger";
import * as wfmSession from "../services/wfmSession";
import * as wfmOrders from "../services/wfmOrders";
import * as wfmContracts from "../services/wfmContracts";
import * as wfmCatalog from "../services/wfmCatalog";
import { startListening, stopListening } from "../services/wfmWebSocketListener";
import ctx from "./context";
import {
  WFM_SIGNIN, WFM_SIGNOUT, WFM_SESSION, WFM_GET_ORDERS, WFM_GET_CONTRACTS,
  WFM_CREATE_ORDER, WFM_UPDATE_ORDER, WFM_DELETE_ORDER, WFM_CLOSE_ORDER,
  WFM_SET_VISIBLE, WFM_SEARCH_ITEMS, WFM_LOOKUP_ITEM, WFM_GET_ME, WFM_SET_STATUS,
  WFM_NOTIFICATION,
} from "../config/shared/ipcChannels";

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


function _handleWfmEvent(route: string, payload: unknown): void {
  if (!ctx.overlaySettings?.wfmNotificationsEnabled) return;
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;

  // Whisper / direct message
  if (route.includes("message/new") || route.includes("message/create")) {
    const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
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

    log.log("[WFMListener] Dispatching whisper notification from:", from);
    win.webContents.send(WFM_NOTIFICATION, { type: "whisper", from, content });
  }
}
const WFM_SLUG_RE = /^[a-z0-9_]+$/;

function register(): void {
  handleAuthorized(WFM_SIGNIN, assertMainRendererSender, async (_event, payload) => {
    const creds = parseCredentials(payload);
    if (!creds) {
      log.warn("[Security] wfm:signin blocked due to invalid payload shape");
      return { loggedIn: false, error: "Invalid sign-in payload." };
    }

    try {
      const result = await wfmSession.signIn(creds.email, creds.password);
      // Start persistent WS listener after successful sign-in
      const token = wfmSession.getToken();
      if (token) {
        startListening(token, _handleWfmEvent);
      }
      return result;
    } catch (err) {
      return { loggedIn: false, error: normalizeErrorMessage(err, "Sign-in failed.") };
    }
  });

  handleAuthorized(WFM_SIGNOUT, assertMainRendererSender, async () => {
    stopListening();
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
    return withWfmError("get-contracts", () => wfmContracts.getMyContracts(parsed), "Failed to fetch contracts.");
  });

  handleAuthorized(WFM_CREATE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const params = parseCreateOrderParams(payload);
    if (!params) {
      log.warn("[Security] wfm:create-order blocked due to invalid payload");
      return { error: "Invalid create-order payload." };
    }
    return withWfmError("create-order", () => wfmOrders.createOrder(params), "Failed to create order.");
  });

  handleAuthorized(WFM_UPDATE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseUpdateOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:update-order blocked due to invalid payload");
      return { error: "Invalid update-order payload." };
    }
    return withWfmError("update-order", () => wfmOrders.updateOrder(parsed.orderId, parsed.updates), "Failed to update order.");
  });

  handleAuthorized(WFM_DELETE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseDeleteOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:delete-order blocked due to invalid payload");
      return { error: "Invalid delete-order payload." };
    }
    return withWfmError("delete-order", () => wfmOrders.deleteOrder(parsed.orderId), "Failed to delete order.");
  });

  handleAuthorized(WFM_CLOSE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseCloseOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:close-order blocked due to invalid payload");
      return { error: "Invalid close-order payload." };
    }
    return withWfmError("close-order", () => wfmOrders.closeOrder(parsed.orderId, parsed.quantity), "Failed to close order.");
  });

  handleAuthorized(WFM_SET_VISIBLE, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseSetVisiblePayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:set-visible blocked due to invalid payload");
      return { error: "Invalid set-visible payload." };
    }
    return withWfmError("set-visible", () => wfmOrders.setOrdersVisible(parsed.orderIds, parsed.visible), "Failed to update order visibility.");
  });

  handleAuthorized(WFM_SEARCH_ITEMS, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseSearchPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:search-items blocked due to invalid payload");
      return { error: "Invalid search payload." };
    }
    return withWfmError("search-items", () => wfmCatalog.searchItems(parsed.query, parsed.limit), "Failed to search items.");
  });

  handleAuthorized(WFM_LOOKUP_ITEM, assertMainRendererSender, async (_event, payload) => {
    const slugRaw =
      payload && typeof payload === "object" && "slug" in payload
        ? (payload as { slug?: unknown }).slug
        : null;
    const slug = typeof slugRaw === "string" ? slugRaw.trim().toLowerCase() : "";

    if (!slug || !WFM_SLUG_RE.test(slug)) {
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

    return withWfmError("set-status", () => wfmSession.setStatus(parsed.status as WfmStatus), "Failed to set status.");
  });
}

const testExports = {
  parseCredentials,
  parseCreateOrderParams,
  parseUpdateOrderPayload,
  parseDeleteOrderPayload,
  parseSetVisiblePayload,
  parseSearchPayload,
  parseStatusPayload,
  parseContractsPayload,
  parseCloseOrderPayload,
  normalizeErrorMessage,
};

/**
 * Called after session restore on startup — starts the WS listener if a
 * token is already present (i.e., the user was logged in before).
 */
function startListenerIfLoggedIn(): void {
  const token = wfmSession.getToken();
  if (token) {
    log.log("[WFMIpc] Resuming WS listener after session restore");
    startListening(token, _handleWfmEvent);
  }
}

export { register, startListenerIfLoggedIn };
export const __test__ = testExports;
