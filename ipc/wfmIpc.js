const log = require("../services/logger").withScope("wfmIpc");
/**
 * Warframe.market IPC handlers.
 * Handles: wfm:signin, wfm:signout, wfm:session, wfm:get-orders,
 *          wfm:get-contracts,
 *          wfm:create-order, wfm:update-order, wfm:delete-order,
 *          wfm:set-visible, wfm:search-items, wfm:get-me, wfm:set-status
 */

const { ipcMain } = require("electron");
const wfmSession = require("../services/wfmSession");
const wfmOrders = require("../services/wfmOrders");
const wfmContracts = require("../services/wfmContracts");
const wfmCatalog = require("../services/wfmCatalog");
const { assertMainRendererSender, assertAuthorizedSender } = require("./ipcSecurity");

const WFM_ID_RE = /^[a-f0-9]{24}$/i;
const VALID_ORDER_TYPES = new Set(["sell", "buy"]);
const VALID_STATUSES = new Set(["online", "ingame", "invisible"]);

const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 512;
const SEARCH_QUERY_MAX_LENGTH = 120;
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 100;
const CONTRACTS_PAGE_DEFAULT = 1;
const CONTRACTS_PAGE_MIN = 1;
const CONTRACTS_PAGE_MAX = 500;
const CONTRACTS_LIMIT_DEFAULT = 40;
const CONTRACTS_LIMIT_MIN = 1;
const CONTRACTS_LIMIT_MAX = 100;
const MAX_BULK_ORDER_IDS = 200;
const MAX_PLATINUM = 10_000_000;
const MAX_QUANTITY = 99_999;
const MIN_MOD_RANK = 0;
const MAX_MOD_RANK = 20;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > maxLength) return "";
  return trimmed;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toClampedInteger(value, min, max) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function normalizeErrorMessage(err, fallback = "Unknown error") {
  if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return fallback;
}

function errorCode(err) {
  if (!err || typeof err !== "object") return undefined;
  return err.code;
}

function errorStatus(err) {
  if (!err || typeof err !== "object") return undefined;
  return err.status;
}

function parseCredentials(payload) {
  if (!isObject(payload)) return null;

  const email = toTrimmedString(payload.email, EMAIL_MAX_LENGTH);
  const password = toTrimmedString(payload.password, PASSWORD_MAX_LENGTH);
  if (!email || !password) return null;

  return { email, password };
}

function parseCreateOrderParams(payload) {
  if (!isObject(payload)) return null;

  const itemId = toTrimmedString(payload.itemId, 64);
  const orderType = toTrimmedString(payload.orderType, 10).toLowerCase();
  const platinum = toClampedInteger(payload.platinum, 1, MAX_PLATINUM);
  const quantity = toClampedInteger(payload.quantity, 1, MAX_QUANTITY);

  if (!itemId || !WFM_ID_RE.test(itemId)) return null;
  if (!VALID_ORDER_TYPES.has(orderType)) return null;
  if (platinum == null || quantity == null) return null;

  const parsed = {
    itemId,
    orderType,
    platinum,
    quantity,
    visible: payload.visible === undefined ? true : Boolean(payload.visible),
  };

  if (payload.modRank !== undefined) {
    const modRank = toClampedInteger(payload.modRank, MIN_MOD_RANK, MAX_MOD_RANK);
    if (modRank == null) return null;
    parsed.modRank = modRank;
  }

  return parsed;
}

function parseUpdateOrderPayload(payload) {
  if (!isObject(payload)) return null;

  const orderId = toTrimmedString(payload.orderId, 64);
  if (!orderId || !WFM_ID_RE.test(orderId)) return null;

  const updates = isObject(payload.updates) ? payload.updates : {};
  const parsedUpdates = {};

  if (updates.platinum !== undefined) {
    const platinum = toClampedInteger(updates.platinum, 1, MAX_PLATINUM);
    if (platinum == null) return null;
    parsedUpdates.platinum = platinum;
  }

  if (updates.quantity !== undefined) {
    const quantity = toClampedInteger(updates.quantity, 1, MAX_QUANTITY);
    if (quantity == null) return null;
    parsedUpdates.quantity = quantity;
  }

  if (updates.visible !== undefined) {
    parsedUpdates.visible = Boolean(updates.visible);
  }

  if (updates.modRank !== undefined) {
    const modRank = toClampedInteger(updates.modRank, MIN_MOD_RANK, MAX_MOD_RANK);
    if (modRank == null) return null;
    parsedUpdates.modRank = modRank;
  }

  return { orderId, updates: parsedUpdates };
}

function parseDeleteOrderPayload(payload) {
  if (!isObject(payload)) return null;
  const orderId = toTrimmedString(payload.orderId, 64);
  if (!orderId || !WFM_ID_RE.test(orderId)) return null;
  return { orderId };
}

function parseSetVisiblePayload(payload) {
  if (!isObject(payload)) return null;
  if (typeof payload.visible !== "boolean") return null;
  if (!Array.isArray(payload.orderIds)) return null;

  const orderIds = payload.orderIds
    .map((value) => toTrimmedString(value, 64))
    .filter((value) => value && WFM_ID_RE.test(value))
    .slice(0, MAX_BULK_ORDER_IDS);

  if (orderIds.length === 0) return null;
  return {
    orderIds,
    visible: payload.visible,
  };
}

function parseSearchPayload(payload) {
  if (!isObject(payload)) return null;

  const query = toTrimmedString(payload.query, SEARCH_QUERY_MAX_LENGTH);
  if (!query) return null;

  const rawLimit =
    payload.limit === undefined
      ? SEARCH_LIMIT_DEFAULT
      : toClampedInteger(payload.limit, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX);

  if (rawLimit == null) return null;

  return {
    query,
    limit: rawLimit,
  };
}

function parseStatusPayload(payload) {
  if (!isObject(payload)) return null;

  const status = toTrimmedString(payload.status, 24).toLowerCase();
  if (!VALID_STATUSES.has(status)) return null;

  return { status };
}

function parseContractsPayload(payload) {
  if (payload == null) {
    return {
      page: CONTRACTS_PAGE_DEFAULT,
      limit: CONTRACTS_LIMIT_DEFAULT,
    };
  }

  if (!isObject(payload)) return null;

  const page =
    payload.page === undefined
      ? CONTRACTS_PAGE_DEFAULT
      : toClampedInteger(payload.page, CONTRACTS_PAGE_MIN, CONTRACTS_PAGE_MAX);

  const limit =
    payload.limit === undefined
      ? CONTRACTS_LIMIT_DEFAULT
      : toClampedInteger(payload.limit, CONTRACTS_LIMIT_MIN, CONTRACTS_LIMIT_MAX);

  if (page == null || limit == null) return null;

  return { page, limit };
}

function register() {
  const handleMainRenderer = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertAuthorizedSender(assertMainRendererSender, event, channel);
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
      if (code === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (code === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (errorCode(err) === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (errorCode(err) === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (errorCode(err) === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (errorCode(err) === "WFM_UNAUTHORIZED") wfmSession.signOut();
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
      if (errorCode(err) === "WFM_UNAUTHORIZED") wfmSession.signOut();
      return { error: normalizeErrorMessage(err, "Failed to set status.") };
    }
  });
}

module.exports = {
  register,
  __test__: {
    parseCredentials,
    parseCreateOrderParams,
    parseUpdateOrderPayload,
    parseDeleteOrderPayload,
    parseSetVisiblePayload,
    parseSearchPayload,
    parseStatusPayload,
    parseContractsPayload,
    normalizeErrorMessage,
  },
};
