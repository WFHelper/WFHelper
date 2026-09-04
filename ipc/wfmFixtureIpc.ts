// E2E-only in-memory WFM fixture, disabled in packaged builds.
import fs from "node:fs";
import { app } from "electron";

import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { parseSetVisiblePayload, parseUpdateOrderPayload } from "./wfmValidators";
import { withScope } from "../services/logger";
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
} from "../config/shared/ipcChannels";

const log = withScope("wfmFixtureIpc");

interface FixtureOrder {
  id: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  itemId: string | null;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
}

interface FixtureOrders {
  sell: FixtureOrder[];
  buy: FixtureOrder[];
}

const FIXTURE_SESSION = { loggedIn: true, userName: "E2E Tester", platform: "pc" };

function loadFixtureOrders(file: string): FixtureOrders {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FixtureOrders>;
  return {
    sell: Array.isArray(parsed.sell) ? parsed.sell : [],
    buy: Array.isArray(parsed.buy) ? parsed.buy : [],
  };
}

export function registerWfmFixtures(): boolean {
  const file = process.env.WFHELPER_WFM_FIXTURES;
  if (!file) return false;
  if (app.isPackaged) {
    log.warn("[WFMFixtures] WFHELPER_WFM_FIXTURES ignored in packaged build");
    return false;
  }

  const orders = loadFixtureOrders(file);
  log.warn(
    `[WFMFixtures] serving WFM IPC from fixtures (${orders.sell.length} sell / ${orders.buy.length} buy):`,
    file,
  );

  const allOrders = () => [...orders.sell, ...orders.buy];

  // Rewriting the fixture mid-run stands in for a change made outside the app
  // (unlisted on the website). Unchanged file keeps in-app edits in memory.
  let fixtureMtimeMs = 0;
  const syncFixtureFromDisk = (): void => {
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (mtimeMs === fixtureMtimeMs) return;
      const reloaded = loadFixtureOrders(file);
      if (fixtureMtimeMs !== 0) {
        orders.sell = reloaded.sell;
        orders.buy = reloaded.buy;
      }
      fixtureMtimeMs = mtimeMs;
    } catch (err) {
      log.warn("[WFMFixtures] fixture reload failed:", String(err));
    }
  };
  syncFixtureFromDisk();

  handleAuthorized(WFM_SIGNIN, assertMainRendererSender, async () => FIXTURE_SESSION);
  handleAuthorized(WFM_SIGNOUT, assertMainRendererSender, async () => ({
    loggedIn: false,
    userName: null,
    platform: "pc",
  }));
  handleAuthorized(WFM_SESSION, assertMainRendererSender, async () => FIXTURE_SESSION);
  handleAuthorized(WFM_GET_ORDERS, assertMainRendererSender, async () => {
    syncFixtureFromDisk();
    return {
      sell: orders.sell.map((entry) => ({ ...entry })),
      buy: orders.buy.map((entry) => ({ ...entry })),
    };
  });
  handleAuthorized(WFM_GET_CONTRACTS, assertMainRendererSender, async () => ({
    contracts: [],
    page: 1,
    totalPages: 1,
    hasMore: false,
  }));
  handleAuthorized(WFM_CREATE_ORDER, assertMainRendererSender, async () => ({
    error: "Order creation is not available in fixture mode.",
  }));
  handleAuthorized(WFM_UPDATE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseUpdateOrderPayload(payload);
    if (!parsed) return { error: "Invalid update-order payload." };
    const order = allOrders().find((entry) => entry.id === parsed.orderId);
    if (!order) return { error: "Order not found." };
    if (typeof parsed.updates.platinum === "number") order.platinum = parsed.updates.platinum;
    if (typeof parsed.updates.quantity === "number") order.quantity = parsed.updates.quantity;
    if (typeof parsed.updates.visible === "boolean") order.visible = parsed.updates.visible;
    if (typeof parsed.updates.modRank === "number") order.modRank = parsed.updates.modRank;
    return { ok: true };
  });
  handleAuthorized(WFM_DELETE_ORDER, assertMainRendererSender, async (_event, payload) => {
    const orderId = (payload as { orderId?: unknown } | null)?.orderId;
    orders.sell = orders.sell.filter((entry) => entry.id !== orderId);
    orders.buy = orders.buy.filter((entry) => entry.id !== orderId);
    return { ok: true };
  });
  handleAuthorized(WFM_SET_VISIBLE, assertMainRendererSender, async (_event, payload) => {
    const parsed = parseSetVisiblePayload(payload);
    if (!parsed) return { error: "Invalid set-visible payload." };
    for (const order of allOrders()) {
      if (parsed.orderIds.includes(order.id)) order.visible = parsed.visible;
    }
    return { ok: true };
  });
  handleAuthorized(WFM_SEARCH_ITEMS, assertMainRendererSender, async () => []);
  handleAuthorized(WFM_LOOKUP_ITEM, assertMainRendererSender, async () => ({
    error: "Item lookup is not available in fixture mode.",
  }));
  handleAuthorized(WFM_GET_ME, assertMainRendererSender, async () => ({ status: "online" }));
  handleAuthorized(WFM_SET_STATUS, assertMainRendererSender, async () => ({ ok: true }));
  handleAuthorized(WFM_PRESENCE_STATE, assertMainRendererSender, async () => ({
    status: "online",
    expiresAt: null,
    autoActive: false,
    awayActive: false,
  }));

  return true;
}
