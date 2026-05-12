(function () {
  const SAFE_COLOR_FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|oklch)\(\s*[-+0-9.%\s,/]+\)$/i;
  const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const COLOR_VAR_KEYS = [
    ["--bg-deep", "bgDeep"],
    ["--bg-base", "bgBase"],
    ["--bg-surface", "bgSurface"],
    ["--bg-raised", "bgRaised"],
    ["--bg-hover", "bgHover"],
    ["--accent", "accent"],
    ["--accent-dim", "accentDim"],
    ["--accent-bright", "accentBright"],
    ["--text-primary", "textPrimary"],
    ["--text-secondary", "textSecondary"],
    ["--text-muted", "textMuted"],
    ["--success", "success"],
    ["--warning", "warning"],
    ["--danger", "danger"],
    ["--info", "info"],
    ["--border", "border"],
    ["--border-strong", "borderStrong"],
  ];

  function safeThemeColor(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 96 || /[;{}]/.test(trimmed)) return null;
    return SAFE_HEX_COLOR_RE.test(trimmed) || SAFE_COLOR_FUNCTION_RE.test(trimmed) ? trimmed : null;
  }

  function hexToAccentGlow(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
    if (!match) return null;
    const r = parseInt(match[1], 16);
    const g = parseInt(match[2], 16);
    const b = parseInt(match[3], 16);
    if (![r, g, b].every(Number.isFinite)) return null;
    return `rgba(${r}, ${g}, ${b}, 0.15)`;
  }

  function setThemeColor(map, key, value) {
    const color = safeThemeColor(value);
    if (color) map[key] = color;
  }

  function setFontSize(map, key, value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      map[key] = `${value}rem`;
    }
  }

  function loadThemeFromStorageFallback(applyThemeVars) {
    if (typeof applyThemeVars !== "function") return;

    try {
      const raw = localStorage.getItem("wf_theme_settings");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const colors = parsed?.colors;
      const fontSizes = parsed?.fontSizes;
      if (!colors || typeof colors !== "object") return;

      const map = {
        "--font-display": '"Rajdhani", sans-serif',
        "--font-body": '"Barlow", sans-serif',
      };

      for (const [cssVar, colorKey] of COLOR_VAR_KEYS) {
        setThemeColor(map, cssVar, colors[colorKey]);
      }

      const glow = hexToAccentGlow(colors.accent);
      if (glow) map["--accent-glow"] = glow;

      if (fontSizes && typeof fontSizes === "object") {
        setFontSize(map, "--font-heading-size", fontSizes.headingSize);
        setFontSize(map, "--font-body-size", fontSizes.bodySize);
        setFontSize(map, "--font-small-size", fontSizes.smallSize);
      }

      applyThemeVars(map);
    } catch {
      // ignore malformed local storage
    }
  }

  window.overlayTheme = {
    loadThemeFromStorageFallback,
  };
})();
