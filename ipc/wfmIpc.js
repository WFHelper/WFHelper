const log = require('../services/logger').withScope('wfmIpc');
/**
 * Warframe.market IPC handlers.
 * Handles: wfm:signin, wfm:signout, wfm:session, wfm:get-orders,
 *          wfm:create-order, wfm:update-order, wfm:delete-order,
 *          wfm:set-visible, wfm:search-items, wfm:get-me, wfm:set-status
 */

const { ipcMain } = require('electron');
const wfmSession = require('../services/wfmSession');
const wfmOrders  = require('../services/wfmOrders');
const wfmCatalog = require('../services/wfmCatalog');

// ─── Input validation ─────────────────────────────────────────────────────────

const WFM_ID_RE      = /^[a-f0-9]{24}$/i;
const VALID_STATUSES = new Set(['online', 'ingame', 'invisible']);

// ─── IPC Registration ─────────────────────────────────────────────────────────

function register() {
  ipcMain.handle('wfm:signin', async (_event, { email, password }) => {
    try {
      return await wfmSession.signIn(email, password);
    } catch (err) {
      return { loggedIn: false, error: err.message };
    }
  });

  ipcMain.handle('wfm:signout', async () => {
    return wfmSession.signOut();
  });

  ipcMain.handle('wfm:session', async () => {
    return wfmSession.getSession();
  });

  ipcMain.handle('wfm:get-orders', async () => {
    try {
      return await wfmOrders.getMyOrders();
    } catch (err) {
      log.error('[WFM IPC] get-orders error:', err.message, 'status:', err.status || '?', 'code:', err.code || '?');
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:create-order', async (_event, params) => {
    const { itemId } = params || {};
    if (!itemId || !WFM_ID_RE.test(itemId)) {
      log.warn('[Security] wfm:create-order blocked — invalid itemId:', String(itemId).slice(0, 40));
      return { error: 'Invalid itemId.' };
    }
    try {
      return await wfmOrders.createOrder(params);
    } catch (err) {
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:update-order', async (_event, { orderId, updates }) => {
    if (!orderId || !WFM_ID_RE.test(orderId)) {
      log.warn('[Security] wfm:update-order blocked — invalid orderId:', String(orderId).slice(0, 40));
      return { error: 'Invalid orderId.' };
    }
    try {
      return await wfmOrders.updateOrder(orderId, updates);
    } catch (err) {
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:delete-order', async (_event, { orderId }) => {
    if (!orderId || !WFM_ID_RE.test(orderId)) {
      log.warn('[Security] wfm:delete-order blocked — invalid orderId:', String(orderId).slice(0, 40));
      return { error: 'Invalid orderId.' };
    }
    try {
      return await wfmOrders.deleteOrder(orderId);
    } catch (err) {
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:set-visible', async (_event, { orderIds, visible }) => {
    try {
      return await wfmOrders.setOrdersVisible(orderIds, visible);
    } catch (err) {
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:search-items', async (_event, { query, limit }) => {
    try {
      return await wfmCatalog.searchItems(query, limit || 20);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:get-me', async () => {
    try {
      return await wfmSession.getMe();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('wfm:set-status', async (_event, { status }) => {
    if (!VALID_STATUSES.has(status)) {
      log.warn('[Security] wfm:set-status blocked — invalid status:', String(status).slice(0, 20));
      return { error: 'Invalid status. Must be one of: online, ingame, invisible.' };
    }
    try {
      return await wfmSession.setStatus(status);
    } catch (err) {
      if (err.code === 'WFM_UNAUTHORIZED') wfmSession.signOut();
      return { error: err.message };
    }
  });
}

module.exports = { register };
