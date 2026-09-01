// Views that may open as their own always-on-top-capable window.
const POPOUT_VIEWS = ["world", "arbitrations"] as const;
export type PopoutView = (typeof POPOUT_VIEWS)[number];

export function isPopoutView(value: unknown): value is PopoutView {
  return typeof value === "string" && (POPOUT_VIEWS as readonly string[]).includes(value);
}
