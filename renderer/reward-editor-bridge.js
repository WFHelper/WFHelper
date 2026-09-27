(function () {
  if (window.parent === window || new URLSearchParams(location.search).get("mode") !== "editor")
    return;
  const listeners = new Map();
  const pending = new Map();
  let sequence = 0;
  let config = null;
  let editorOptions = { scope: "all", zoom: 1 };
  let resolveConfig;
  const configured = new Promise((resolve) => {
    resolveConfig = resolve;
  });
  const subscribe = (key, callback) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(callback);
    return () => listeners.get(key).delete(callback);
  };
  const emit = (key, value) => listeners.get(key)?.forEach((callback) => callback(value));
  const setEditorOptions = (value) => {
    if (!value || typeof value !== "object") return;
    const zoom = Number(value.zoom);
    editorOptions = {
      scope: value.scope === "card" ? "card" : "all",
      zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    };
    emit("options", editorOptions);
  };
  const request = (command) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Preview update timed out"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ type: "reward-preview-command", id, command }, "*");
    });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data) return;
    const message = event.data;
    if (message.type === "reward-preview-config") {
      config = message;
      resolveConfig(config);
      setEditorOptions(config.options);
      emit("messages", config.messages);
      emit("theme", config.theme);
      emit("layout", config.state);
    } else if (message.type === "reward-preview-options") {
      setEditorOptions(message.options);
    } else if (message.type === "reward-preview-flush") {
      Promise.resolve()
        .then(() => window.flushRewardEditor?.())
        .then(() => {
          window.parent.postMessage({ type: "reward-preview-flushed", id: message.id }, "*");
        })
        .catch(() => {
          window.parent.postMessage(
            { type: "reward-preview-flushed", id: message.id, error: true },
            "*",
          );
        });
    } else if (message.type === "reward-preview-state") {
      if (config) config.state = message.state;
      emit("layout", message.state);
    } else if (message.type === "reward-preview-result") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.state);
    }
  });
  window.overlayPreview = {
    subscribe,
    emit,
    configured,
    get config() {
      return config;
    },
  };
  window.overlayLayoutApi = {
    get defaultFieldStyle() {
      return config.defaultFieldStyle;
    },
    getLayout: async () => {
      await configured;
      return config.state;
    },
    onLayout: (cb) => subscribe("layout", cb),
    editorOptions: () => editorOptions,
    onEditorOptions: (cb) => subscribe("options", cb),
    editLayout: (_sessionId, command) => request(command),
    endLayout: async () => {
      window.parent.postMessage({ type: "reward-preview-cancel" }, "*");
      return config.state;
    },
  };
  window.overlay = {
    get defaultFieldStyle() {
      return config.defaultFieldStyle;
    },
    getThemeVars: async () => {
      await configured;
      return config.theme;
    },
    getMessages: async () => {
      await configured;
      return config.messages;
    },
    getDragHint: async () => ({ hotkey: null, dismissed: true }),
    getPrice: async () => 0,
    close: () => {},
    ready: () => {},
    moveBy: () => {},
    onMessages: (cb) => subscribe("messages", cb),
    onThemeVars: (cb) => subscribe("theme", cb),
    onItems: () => () => {},
    onTrigger: () => () => {},
    onPlannerTrigger: () => () => {},
    onRecommendations: () => () => {},
    onInteractionMode: () => () => {},
  };
  const previewApi = {
    getThemeVars: window.overlay.getThemeVars,
    getMessages: window.overlay.getMessages,
    onThemeVars: window.overlay.onThemeVars,
    onMessages: window.overlay.onMessages,
    getDragHint: async () => ({ hotkey: "Ctrl+O", dismissed: true }),
    close: () => {},
    ready: () => {},
    moveBy: () => {},
  };
  window.rivenOverlay = {
    ...previewApi,
    requestRescan: () => {},
    openAuction: () => {},
    setSimilarAuctions: async () => {},
  };
  for (const name of [
    "SessionStart",
    "InitialStats",
    "Scanning",
    "RollResult",
    "ChoiceMade",
    "Rescan",
    "SessionEnd",
    "WeaponUpdate",
    "WeaponMissing",
    "InteractionMode",
    "GradingInitial",
    "GradingRoll",
    "BestAttributes",
    "SimilarListings",
    "SimilarAuctions",
  ]) {
    window.rivenOverlay[`on${name}`] = () => () => {};
  }
  window.tradeNotificationApi = {
    ...previewApi,
    dismiss: () => {},
    onShow: () => () => {},
    onRepResult: () => () => {},
  };
  window.parent.postMessage({ type: "reward-preview-ready" }, "*");
})();
