/**
 * World state IPC handler with TTL cache.
 * Handles: get-world-state
 */

const { ipcMain } = require('electron');
const worldStateParser = require('../services/worldStateParser');

// ─── Cache ────────────────────────────────────────────────────────────────────

const WORLD_STATE_TTL_MS = 90_000;

let _worldStateCache     = null;
let _worldStateCacheTime = 0;

// ─── IPC Registration ─────────────────────────────────────────────────────────

function register() {
  ipcMain.handle('get-world-state', async () => {
    const now = Date.now();
    if (_worldStateCache && (now - _worldStateCacheTime) < WORLD_STATE_TTL_MS) {
      return _worldStateCache;
    }

    try {
      _worldStateCache     = await worldStateParser.fetchAndParse();
      _worldStateCacheTime = Date.now();
      console.log('[WorldState] Fetched and parsed DE world state');
      return _worldStateCache;
    } catch (err) {
      console.error('[WorldState] fetch failed:', err.message);
      // Fall back to stale data if available, otherwise return a safe empty shape
      if (!_worldStateCache) {
        _worldStateCache = worldStateParser.emptyWorldState();
      }
      return _worldStateCache;
    }
  });
}

module.exports = { register };
