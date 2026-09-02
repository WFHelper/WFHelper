// Views that may open as their own always-on-top-capable window.
const POPOUT_VIEWS = ["world", "arbitrations"] as const;
export type PopoutView = (typeof POPOUT_VIEWS)[number];

function isPopoutView(value: unknown): value is PopoutView {
  return typeof value === "string" && (POPOUT_VIEWS as readonly string[]).includes(value);
}

// A popout can host a whole view or one registered layout section. Section
// ids follow the layout registry's `<view>.<name>` shape; the renderer resolves
// them, main only validates the string shape.
export type PopoutTarget =
  | { kind: "view"; view: PopoutView }
  | { kind: "section"; sectionId: string };

const SECTION_ID_RE = /^[a-z]+\.[A-Za-z0-9]+$/;

function isPopoutSectionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SECTION_ID_RE.test(value);
}

export function parsePopoutTarget(value: unknown): PopoutTarget | null {
  if (isPopoutView(value)) return { kind: "view", view: value };
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown; view?: unknown; sectionId?: unknown };
  if (raw.kind === "view" && isPopoutView(raw.view)) return { kind: "view", view: raw.view };
  if (raw.kind === "section" && isPopoutSectionId(raw.sectionId)) {
    return { kind: "section", sectionId: raw.sectionId };
  }
  return null;
}

/** Stable key for window bookkeeping and remembered bounds. */
export function popoutTargetKey(target: PopoutTarget): string {
  return target.kind === "view" ? `view:${target.view}` : `section:${target.sectionId}`;
}

/** Inverse of popoutTargetKey. A bare view name is the key builds before section
    popouts wrote, so the state file and old URLs keep working. */
export function parsePopoutTargetKey(key: unknown): PopoutTarget | null {
  if (typeof key !== "string") return null;
  if (key.startsWith("view:")) return parsePopoutTarget(key.slice(5));
  if (key.startsWith("section:")) {
    return parsePopoutTarget({ kind: "section", sectionId: key.slice(8) });
  }
  return parsePopoutTarget(key);
}

export interface PopoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoutOpenOptions {
  pinned?: boolean;
  bounds?: PopoutBounds;
}

export interface PopoutWindowInfo {
  target: PopoutTarget;
  pinned: boolean;
  bounds: PopoutBounds;
}

export function parsePopoutBounds(value: unknown): PopoutBounds | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const numbers: number[] = [];
  for (const field of ["x", "y", "width", "height"] as const) {
    const entry = raw[field];
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    numbers.push(Math.round(entry));
  }
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
