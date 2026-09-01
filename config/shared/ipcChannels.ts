/** All IPC channel names live here; `as const` keeps literal types. */

export const INVENTORY_GET = "get-inventory";
export const INVENTORY_OPEN_FILE = "open-inventory-file";
export const INVENTORY_OPEN_ALECA_FRAME_FILE = "open-alecaframe-inventory-file";
export const INVENTORY_GET_STATUS = "get-inventory-status";
export const INVENTORY_SET_SOURCE = "set-inventory-source";
export const INVENTORY_UPDATED = "inventory-updated";
export const INVENTORY_STATUS_UPDATED = "inventory-status-updated";

export const DB_GET_ITEM_DATABASE = "get-item-database";
export const ITEM_DB_UPDATED = "item-db-updated";
export const GAME_LOCALE_UPDATED = "game-locale-updated";
export const DB_GET_WORLD_STATE = "get-world-state";
export const WORLD_STATE_FETCH_ERROR = "world-state-fetch-error";
export const DB_GET_RELIC_DATABASE = "get-relic-database";
export const DB_GET_WFM_ITEMS = "get-wfm-items";
export const DB_GET_MASTERY = "get-mastery-progress";
export const DB_GET_CODEX_SCANS = "get-codex-scans";
export const DROP_SEARCH = "drop-search";

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
export const WFM_PRESENCE_STATE = "wfm:presence-state";
export const WFM_NOTIFICATION = "wfm:notification";

export const APP_UPDATE_CHECK = "app:update-check";
export const APP_UPDATE_STATE = "app:update-state";
export const APP_UPDATE_DOWNLOAD = "app:update-download";
export const APP_UPDATE_INSTALL = "app:update-install";
export const APP_UPDATE_STATUS = "app-update-status";
export const APP_RUNTIME_INFO = "app:runtime-info";
export const SYSTEM_CONFIRM = "system:confirm";
export const SCAN_DEBUG_OPEN_FOLDER = "scan-debug:open-folder";
export const LOGS_OPEN_FOLDER = "logs:open-folder";

export const LINUX_DISPLAY_GET = "linux-display:get";
export const LINUX_DISPLAY_SET = "linux-display:set";

export const WINDOW_MINIMIZE = "window-minimize";
export const WINDOW_MAXIMIZE = "window-maximize";
export const WINDOW_CLOSE = "window-close";

export const OPEN_EXTERNAL = "open-external";
export const LOG_WARN = "log:warn";

export const NOTIFICATION_HISTORY_GET = "notification-history-get";
export const NOTIFICATION_HISTORY_CLEAR = "notification-history-clear";
export const NOTIFICATION_HISTORY_REMOVE = "notification-history-remove";
export const NOTIFICATION_HISTORY_ADDED = "notification-history-added";
export const NOTIFICATION_SOUND_PLAY = "notification-sound-play";
export const NOTIFICATION_TEST = "notification-test";

export const NOTIFICATION_CHANNELS_GET = "notification-channels:get";
export const NOTIFICATION_CHANNELS_SET_WEBHOOK = "notification-channels:set-webhook";
export const NOTIFICATION_CHANNELS_CLEAR_WEBHOOK = "notification-channels:clear-webhook";
export const NOTIFICATION_CHANNELS_SET_SOURCE = "notification-channels:set-source";
export const NOTIFICATION_CHANNELS_TEST = "notification-channels:test";

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
export const RIVENS_GET_BEST_ATTRIBUTES = "get-riven-best-attributes";
export const RIVENS_CREATE_AUCTION = "create-riven-auction";
export const RIVENS_UPDATE_AUCTION = "update-riven-auction";
export const RIVENS_DELETE_AUCTION = "delete-riven-auction";

export const OVERLAY_GET_SETTINGS = "overlay:get-settings";
export const OVERLAY_SET_SETTINGS = "overlay:set-settings";
export const OVERLAY_GET_DETECTED_UI_SCALE = "overlay:get-detected-ui-scale";
export const OVERLAY_GET_THEME_VARS = "overlay:get-theme-vars";
export const OVERLAY_GET_MESSAGES = "overlay:get-messages";
export const OVERLAY_GET_DRAG_HINT = "overlay:get-drag-hint";
export const OVERLAY_PLACEMENT_LAYOUT = "overlay:placement-layout";
export const OVERLAY_SAVE_PLACEMENT = "overlay:save-placement";
export const OVERLAY_SAVE_SCALE = "overlay:save-scale";
export const OVERLAY_GET_PRICE = "overlay:get-price";
export const OVERLAY_PUSH_RELIC_FILTERS = "overlay:push-relic-filters";
export const OVERLAY_THEME_UPDATED = "overlay-theme-updated";
export const OVERLAY_THEME_VARS = "overlay-theme-vars";
export const OVERLAY_LOCALE_UPDATED = "overlay-locale-updated";
export const OVERLAY_MESSAGES = "overlay-messages";
export const OVERLAY_INTERACTION_MODE = "overlay-interaction-mode";
export const OVERLAY_CONTENT_VISIBLE = "overlay-content-visible";
export const OVERLAY_DRAG_MOVE = "overlay-drag-move";
export const OVERLAY_READY = "overlay-ready";

export const OVERLAY_CLOSE = "overlay-close";
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
export const RIVEN_RESCAN_REQUEST = "riven-rescan-request";
export const RIVEN_RESCAN = "riven-rescan";
export const RIVEN_WEAPON_MISSING = "riven-weapon-missing";

export const TRADE_NOTIFICATION_SHOW = "trade-notification-show";
export const TRADE_NOTIFICATION_DISMISS = "trade-notification-dismiss";
export const TRADE_NOTIFICATION_REP_RESULT = "trade-notification-rep-result";

export const ARBI_GET_RUNS = "arbi:get-runs";
export const ARBI_REFRESH_RUNS = "arbi:refresh-runs";
export const ARBI_SET_VITUS = "arbi:set-vitus";
export const ARBI_SET_TAGS = "arbi:set-tags";
export const ARBI_DELETE_RUN = "arbi:delete-run";
export const ARBI_DELETE_LOG = "arbi:delete-log";
export const ARBI_EXPORT_LOG = "arbi:export-log";
export const ARBI_IMPORT_LOG = "arbi:import-log";
export const ARBI_SAVE_IMAGE = "arbi:save-image";
export const ARBI_SHOW_LOG_IN_FOLDER = "arbi:show-log-in-folder";
export const ARBI_RUN_SAVED = "arbi-run-saved";
export const WARFRAME_UI_SCALE_UPDATED = "warframe-ui-scale-updated";
export const ARBI_OPEN_RUN = "arbi-open-run";

export const ARBI_SUMMARY_DATA = "arbi-summary-data";
export const ARBI_SUMMARY_READY = "arbi-summary-ready";
export const ARBI_SUMMARY_CLOSE = "arbi-summary-close";
export const ARBI_SUMMARY_OPEN_DETAILS = "arbi-summary-open-details";

export const ARBI_SCHED_GET = "arbi-sched:get";
export const ARBI_SCHED_SET_OCCURRENCE = "arbi-sched:set-occurrence";
export const ARBI_SCHED_SET_FAVORITE = "arbi-sched:set-favorite";
export const ARBI_SCHED_SET_LEAD = "arbi-sched:set-lead";

export const WORKBENCH_GET_STATE = "workbench:get-state";
export const WORKBENCH_PREVIEW_PLAN = "workbench:preview-plan";
export const WORKBENCH_EXECUTE_PLAN = "workbench:execute-plan";
export const WORKBENCH_CANCEL_RUN = "workbench:cancel-run";
export const WORKBENCH_ACK_OVERRIDE = "workbench:ack-override";
export const WORKBENCH_RECONCILE = "workbench:reconcile";
export const WORKBENCH_RESOLVE_REVIEW = "workbench:resolve-review";
export const WORKBENCH_STATE_EVENT = "workbench-state";

export const LEDGER_QUERY = "ledger:query";
export const LEDGER_IMPORT_PREVIEW = "ledger:import-preview";
export const LEDGER_IMPORT_APPLY = "ledger:import-apply";
export const LEDGER_UPDATE_EVENT = "ledger:update-event";
export const LEDGER_EXPORT = "ledger:export";
