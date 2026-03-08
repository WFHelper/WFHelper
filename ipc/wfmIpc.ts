import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";
import {
  errorCode,
  errorStatus,
  normalizeErrorMessage,
  parseContractsPayload,
  parseCreateOrderParams,
  parseCredentials,
  parseDeleteOrderPayload,
  parseSearchPayload,
  parseSetVisiblePayload,
  parseStatusPayload,
  parseUpdateOrderPayload,
} from "./wfmValidators";


const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("wfmIpc");

const { ipcMain } = require("electron") as typeof import("electron");
const WFM_SLUG_RE = /^[a-z0-9_]+$/;
const wfmSession = requireRuntime<{
  signIn: (email: string, password: string) => Promise<unknown>;
  signOut: () => Promise<unknown>;
  getSession: () => Promise<unknown>;
  getMe: () => Promise<unknown>;
  setStatus: (status: string) => Promise<unknown>;
}>("services/wfmSession");
const wfmOrders = requireRuntime<{
  getMyOrders: () => Promise<unknown>;
  createOrder: (params: unknown) => Promise<unknown>;
  updateOrder: (orderId: string, updates: unknown) => Promise<unknown>;
  deleteOrder: (orderId: string) => Promise<unknown>;
  setOrdersVisible: (orderIds: string[], visible: boolean) => Promise<unknown>;
}>("services/wfmOrders");
const wfmContracts = requireRuntime<{
  getMyContracts: (query: { page: number; limit: number }) => Promise<unknown>;
}>("services/wfmContracts");
const wfmCatalog = requireRuntime<{
  searchItems: (query: string, limit: number) => Promise<unknown>;
  lookupBySlug: (slug: string) => Promise<unknown>;
}>("services/wfmCatalog");

function register(): void {
  const handleMainRenderer = (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ) => {
    ipcMain.handle(channel, async (event: unknown, ...args: unknown[]) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, channel);
      return handler(event, ...args);
    });
  };

  handleMainRenderer("wfm:signin", async (_event, payload) => {
    const creds = parseCredentials(payload);
    if (!creds) {
      log.warn("[Security] wfm:signin blocked due to invalid payload shape");
      return { loggedIn: false, error: "Invalid sign-in payload." };
    }

    try {
      return await wfmSession.signIn(creds.email, creds.password);
    } catch (err) {
      return { loggedIn: false, error: normalizeErrorMessage(err, "Sign-in failed.") };
    }
  });

  handleMainRenderer("wfm:signout", async () => {
    return wfmSession.signOut();
  });

  handleMainRenderer("wfm:session", async () => {
    return wfmSession.getSession();
  });

  handleMainRenderer("wfm:get-orders", async () => {
    try {
      return await wfmOrders.getMyOrders();
    } catch (err) {
      const message = normalizeErrorMessage(err, "Failed to fetch orders.");
      const code = errorCode(err);
      log.error(
        "[WFM IPC] get-orders error:",
        message,
        "status:",
        errorStatus(err) || "?",
        "code:",
        code || "?",
      );
      if (code === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: message };
    }
  });

  handleMainRenderer("wfm:get-contracts", async (_event, payload) => {
    const parsed = parseContractsPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:get-contracts blocked due to invalid payload");
      return { error: "Invalid contracts payload." };
    }

    try {
      return await wfmContracts.getMyContracts(parsed);
    } catch (err) {
      const message = normalizeErrorMessage(err, "Failed to fetch contracts.");
      const code = errorCode(err);
      log.error(
        "[WFM IPC] get-contracts error:",
        message,
        "status:",
        errorStatus(err) || "?",
        "code:",
        code || "?",
      );
      if (code === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: message };
    }
  });

  handleMainRenderer("wfm:create-order", async (_event, payload) => {
    const params = parseCreateOrderParams(payload);
    if (!params) {
      log.warn("[Security] wfm:create-order blocked due to invalid payload");
      return { error: "Invalid create-order payload." };
    }

    try {
      return await wfmOrders.createOrder(params);
    } catch (err) {
      if (errorCode(err) === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: normalizeErrorMessage(err, "Failed to create order.") };
    }
  });

  handleMainRenderer("wfm:update-order", async (_event, payload) => {
    const parsed = parseUpdateOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:update-order blocked due to invalid payload");
      return { error: "Invalid update-order payload." };
    }

    try {
      return await wfmOrders.updateOrder(parsed.orderId, parsed.updates);
    } catch (err) {
      if (errorCode(err) === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: normalizeErrorMessage(err, "Failed to update order.") };
    }
  });

  handleMainRenderer("wfm:delete-order", async (_event, payload) => {
    const parsed = parseDeleteOrderPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:delete-order blocked due to invalid payload");
      return { error: "Invalid delete-order payload." };
    }

    try {
      return await wfmOrders.deleteOrder(parsed.orderId);
    } catch (err) {
      if (errorCode(err) === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: normalizeErrorMessage(err, "Failed to delete order.") };
    }
  });

  handleMainRenderer("wfm:set-visible", async (_event, payload) => {
    const parsed = parseSetVisiblePayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:set-visible blocked due to invalid payload");
      return { error: "Invalid set-visible payload." };
    }

    try {
      return await wfmOrders.setOrdersVisible(parsed.orderIds, parsed.visible);
    } catch (err) {
      if (errorCode(err) === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: normalizeErrorMessage(err, "Failed to update order visibility.") };
    }
  });

  handleMainRenderer("wfm:search-items", async (_event, payload) => {
    const parsed = parseSearchPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:search-items blocked due to invalid payload");
      return { error: "Invalid search payload." };
    }

    try {
      return await wfmCatalog.searchItems(parsed.query, parsed.limit);
    } catch (err) {
      return { error: normalizeErrorMessage(err, "Failed to search items.") };
    }
  });

  handleMainRenderer("wfm:lookup-item-by-slug", async (_event, payload) => {
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

  handleMainRenderer("wfm:get-me", async () => {
    try {
      return await wfmSession.getMe();
    } catch (err) {
      return { error: normalizeErrorMessage(err, "Failed to get user profile.") };
    }
  });

  handleMainRenderer("wfm:set-status", async (_event, payload) => {
    const parsed = parseStatusPayload(payload);
    if (!parsed) {
      log.warn("[Security] wfm:set-status blocked due to invalid payload");
      return { error: "Invalid status. Must be one of: online, ingame, invisible." };
    }

    try {
      return await wfmSession.setStatus(parsed.status);
    } catch (err) {
      if (errorCode(err) === "WFM_UNAUTHORIZED") {
        void wfmSession.signOut();
      }
      return { error: normalizeErrorMessage(err, "Failed to set status.") };
    }
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
  normalizeErrorMessage,
};

export { register };
export const __test__ = testExports;
