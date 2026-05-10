/**
 * Single source of truth for all IPC channel names.
 *
 * Import `Ch` in preload files and IPC handler modules to avoid hard-coded
 * string literals.  The object is frozen at runtime and typed `as const` so
 * TypeScript can narrow each channel to its exact string-literal type.
 */

export const INVENTORY_GET = "get-inventory";
export const INVENTORY_OPEN_FILE = "open-inventory-file";
export const INVENTORY_OPEN_ALECA_FRAME_FILE = "open-alecaframe-inventory-file";
export const INVENTORY_GET_STATUS = "get-inventory-status";
export const INVENTORY_UPDATED = "inventory-updated";

export const DB_GET_ITEM_DATABASE = "get-item-database";
export const DB_GET_WORLD_STATE = "get-world-state";
export const WORLD_STATE_FETCH_ERROR = "world-state-fetch-error";
export const DB_GET_RELIC_DATABASE = "get-relic-database";
export const DB_GET_WFM_ITEMS = "get-wfm-items";
export const DB_GET_MASTERY = "get-mastery-progress";
export const DB_SET_DEBUG_MODE = "set-debug-mode";

export const WFM_SIGNIN = "wfm:signin";
export const WFM_SIGNOUT = "wfm:signout";
export const WFM_SESSION = "wfm:session";
export const WFM_GET_ORDERS = "wfm:get-orders";
export const WFM_GET_CONTRACTS = "wfm:get-contracts";
export const WFM_CREATE_ORDER = "wfm:create-order";
export const WFM_UPDATE_ORDER = "wfm:update-order";
export const WFM_DELETE_ORDER = "wfm:delete-order";
export const WFM_SET_VISIBLE = "wfm:set-visible";
export const WFM_SEARCH_ITEMS = "wfm:search-items";
export const WFM_LOOKUP_ITEM = "wfm:lookup-item-by-slug";
export const WFM_GET_ME = "wfm:get-me";
export const WFM_SET_STATUS = "wfm:set-status";
export const WFM_NOTIFICATION = "wfm:notification";

export const APP_UPDATE_CHECK = "app:update-check";
export const APP_UPDATE_STATE = "app:update-state";
export const APP_UPDATE_INSTALL = "app:update-install";
export const APP_UPDATE_STATUS = "app-update-status";

export const WINDOW_MINIMIZE = "window-minimize";
export const WINDOW_MAXIMIZE = "window-maximize";
export const WINDOW_CLOSE = "window-close";

export const OPEN_EXTERNAL = "open-external";
export const LOG_WARN = "log:warn";

export const STATS_GET_HISTORY = "stats:get-history";
export const STATS_GET_CURRENT = "stats:get-current";
export const STATS_IMPORT = "stats:import";
export const STATS_GET_TRADES = "stats:get-trades";
export const STATS_IMPORT_TRADES = "stats:import-trades";
export const TRADE_RECORDED = "trade-recorded";

export const HELPER_GET_STATUS = "helper:get-status";
export const HELPER_RUN_NOW = "helper:run-now";
export const HELPER_DOWNLOAD = "helper:download";
export const HELPER_DOWNLOAD_PROGRESS = "helper-download-progress";

export const RANKED_HOTSET_LOAD = "ranked-hotset:load";
export const RANKED_HOTSET_SAVE = "ranked-hotset:save";
export const SNAPSHOT_CACHE_LOAD = "snapshot-cache:load";
export const SNAPSHOT_CACHE_SAVE = "snapshot-cache:save";

export const RIVENS_GET = "get-rivens";
export const RIVENS_GET_WEAPON_NAMES = "get-riven-weapon-names";
export const RIVENS_GET_STAT_OPTIONS = "get-riven-stat-options";
export const RIVENS_SEARCH_AUCTIONS = "search-riven-auctions";
export const RIVENS_GET_WEAPON_TYPE = "get-weapon-riven-type";
export const RIVENS_GET_BEST_ATTRIBUTES = "get-riven-best-attributes";
export const RIVENS_CREATE_AUCTION = "create-riven-auction";
export const RIVENS_UPDATE_AUCTION = "update-riven-auction";

export const OVERLAY_GET_SETTINGS = "overlay:get-settings";
export const OVERLAY_SET_SETTINGS = "overlay:set-settings";
export const OVERLAY_GET_THEME_VARS = "overlay:get-theme-vars";
export const OVERLAY_GET_PRICE = "overlay:get-price";
export const OVERLAY_PUSH_RELIC_FILTERS = "overlay:push-relic-filters";
export const OVERLAY_THEME_UPDATED = "overlay-theme-updated";
export const OVERLAY_THEME_VARS = "overlay-theme-vars";
export const OVERLAY_INTERACTION_MODE = "overlay-interaction-mode";
export const OVERLAY_DRAG_MOVE = "overlay-drag-move";
export const OVERLAY_READY = "overlay-ready";

export const OVERLAY_CLOSE = "overlay-close";
export const OVERLAY_GET_RELIC_ITEMS = "overlay-get-relic-items";
export const TOGGLE_OVERLAY = "toggle-overlay";
export const SIMULATE_RELIC_TRIGGER = "simulate-relic-trigger";
export const RELIC_REWARD_TRIGGER = "relic-reward-trigger";
export const RELIC_PLANNER_TRIGGER = "relic-planner-trigger";
export const RELIC_REWARD_ITEMS = "relic-reward-items";
export const RELIC_RECOMMENDATIONS = "relic-recommendations";

export const RIVEN_OVERLAY_CLOSE = "riven-overlay-close";
export const RIVEN_OPEN_AUCTION = "riven-open-auction";
export const RIVEN_SESSION_START = "riven-session-start";
export const RIVEN_INITIAL_STATS = "riven-initial-stats";
export const RIVEN_ROLL_SCANNING = "riven-roll-scanning";
export const RIVEN_ROLL_RESULT = "riven-roll-result";
export const RIVEN_CHOICE_MADE = "riven-choice-made";
export const RIVEN_SESSION_END = "riven-session-end";
export const RIVEN_WEAPON_UPDATE = "riven-weapon-update";
export const RIVEN_GRADING_INITIAL = "riven-grading-initial";
export const RIVEN_GRADING_ROLL = "riven-grading-roll";
export const RIVEN_BEST_ATTRIBUTES = "riven-best-attributes";
export const RIVEN_SIMILAR_LISTINGS = "riven-similar-listings";

export const TRADE_NOTIFICATION_SHOW = "trade-notification-show";
export const TRADE_NOTIFICATION_DISMISS = "trade-notification-dismiss";
