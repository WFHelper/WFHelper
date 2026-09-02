import { get, writable, type Readable } from "svelte/store";

import { isSafeMode } from "../lib/customCss/safeMode.js";
import { log } from "../lib/log.js";
import { readStorage, writeStorage } from "../lib/persistence.js";
import {
  DASHBOARD_WIDGETS,
  WIDGET_SETTING_DEFAULTS,
  WIDGET_SETTING_RANGES,
  widgetById,
} from "../lib/widgets/registry.js";
import {
  DASHBOARD_STORAGE_KEY,
  type DashboardLayoutV1,
  type DashboardWidgetState,
} from "../lib/widgets/types.js";
import type { SectionSpan } from "../lib/layout/types.js";
import type { WidgetDescriptor } from "../lib/widgets/types.js";

type WidgetSettingValue = boolean | number | string;
type WidgetSettings = Record<string, WidgetSettingValue>;

/** Strings a widget setting may hold; a longer stored value is a corrupt file. */
const MAX_SETTING_CHARS = 120;

function emptyLayout(): DashboardLayoutV1 {
  return { version: 1, widgets: [] };
}

function defaultSettings(descriptor: WidgetDescriptor): WidgetSettings {
  const settings: WidgetSettings = {};
  for (const name of Object.keys(descriptor.settings ?? {})) {
    const fallback = WIDGET_SETTING_DEFAULTS[name];
    if (fallback !== undefined) settings[name] = fallback;
  }
  return settings;
}

function clampNumber(name: string, value: number): number {
  const range = WIDGET_SETTING_RANGES[name];
  const rounded = Math.round(value);
  if (!range) return rounded;
  return Math.min(Math.max(rounded, range.min), range.max);
}

/** One setting from untrusted input. A value of the wrong type is dropped rather
    than coerced: a "5" where a number belongs means the file was hand-edited. */
function readSetting(
  name: string,
  kind: "boolean" | "number" | "string",
  raw: unknown,
): WidgetSettingValue | null {
  if (kind === "boolean") return typeof raw === "boolean" ? raw : null;
  if (kind === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    return clampNumber(name, raw);
  }
  if (typeof raw !== "string" || raw.length > MAX_SETTING_CHARS) return null;
  return raw;
}

function readSettings(descriptor: WidgetDescriptor, raw: unknown): WidgetSettings {
  const settings = defaultSettings(descriptor);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return settings;
  const record = raw as Record<string, unknown>;
  for (const [name, kind] of Object.entries(descriptor.settings ?? {})) {
    const value = readSetting(name, kind, record[name]);
    if (value !== null) settings[name] = value;
  }
  return settings;
}

function readSpan(descriptor: WidgetDescriptor, raw: unknown): SectionSpan {
  const allowed: readonly SectionSpan[] = descriptor.allowedSpans;
  return allowed.includes(raw as SectionSpan) ? (raw as SectionSpan) : descriptor.defaultSpan;
}

/** Shape validation for the persisted dashboard: unknown widget ids drop, missing
    ones return at their registry defaults, every setting is re-checked against the
    descriptor's schema. Order, span and hidden belong to the layout store
    (`wf_layout_v1`); the copies here describe the file and are never read back. */
export function normalizeDashboardLayout(raw: unknown): DashboardLayoutV1 {
  const byId = new Map<string, DashboardWidgetState>();
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const stored = record?.version === 1 && Array.isArray(record.widgets) ? record.widgets : [];

  for (const entry of stored) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const widget = entry as Record<string, unknown>;
    if (typeof widget.id !== "string") continue;
    const descriptor = widgetById(widget.id);
    if (!descriptor || byId.has(descriptor.id)) continue;
    byId.set(descriptor.id, {
      id: descriptor.id,
      span: readSpan(descriptor, widget.span),
      hidden: widget.hidden === true,
      settings: readSettings(descriptor, widget.settings),
    });
  }

  return {
    version: 1,
    widgets: DASHBOARD_WIDGETS.map(
      (descriptor) =>
        byId.get(descriptor.id) ?? {
          id: descriptor.id,
          span: descriptor.defaultSpan,
          hidden: false,
          settings: defaultSettings(descriptor),
        },
    ),
  };
}

function loadLayout(): DashboardLayoutV1 {
  // Safe mode renders registry defaults without touching storage, so a setting
  // that broke a widget can be undone and still kept if the user wants it.
  if (isSafeMode()) return normalizeDashboardLayout(emptyLayout());
  const raw = readStorage(DASHBOARD_STORAGE_KEY);
  if (raw == null || raw.trim() === "") return normalizeDashboardLayout(emptyLayout());
  try {
    return normalizeDashboardLayout(JSON.parse(raw));
  } catch {
    log.warn("[Dashboard] stored widget settings are not readable JSON; using defaults");
    return normalizeDashboardLayout(emptyLayout());
  }
}

const state = writable<DashboardLayoutV1>(loadLayout());

export const dashboardLayout: Readable<DashboardLayoutV1> = { subscribe: state.subscribe };

/** Settings for one widget, merged over the registry defaults. */
export function widgetSettings(layout: DashboardLayoutV1, widgetId: string): WidgetSettings {
  return layout.widgets.find((widget) => widget.id === widgetId)?.settings ?? {};
}

export function settingNumber(settings: WidgetSettings, name: string, fallback: number): number {
  const value = settings[name];
  return typeof value === "number" ? value : fallback;
}

export function settingBoolean(settings: WidgetSettings, name: string, fallback: boolean): boolean {
  const value = settings[name];
  return typeof value === "boolean" ? value : fallback;
}

/** Writes one setting after re-validating it against the widget's own schema, so
    a bad value from the editor cannot reach disk. */
export function setWidgetSetting(widgetId: string, name: string, value: WidgetSettingValue): void {
  const descriptor = widgetById(widgetId);
  const kind = descriptor?.settings?.[name];
  if (!descriptor || !kind) return;
  const checked = readSetting(name, kind, value);
  if (checked === null) return;

  const current = get(state);
  const next: DashboardLayoutV1 = {
    version: 1,
    widgets: current.widgets.map((widget) =>
      widget.id === widgetId
        ? { ...widget, settings: { ...widget.settings, [name]: checked } }
        : widget,
    ),
  };
  if (!isSafeMode()) writeStorage(DASHBOARD_STORAGE_KEY, JSON.stringify(next));
  state.set(next);
}
