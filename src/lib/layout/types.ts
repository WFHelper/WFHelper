import type { MessageKey } from "../i18n.js";
import type { ViewName } from "../../types/views.js";

/** Views whose sections can be arranged; setup and settings keep a fixed shape. */
export type LayoutView = Exclude<ViewName, "setup" | "settings">;

/** Column span on the two-column layout grid; "full" always takes the row. */
export type SectionSpan = 1 | 2 | "full";

export type LayoutBreakpoint = "narrow" | "wide";

/** A section a view registers once at module load. Ids are `<view>.<name>`. */
export interface SectionDescriptor {
  id: string;
  view: LayoutView;
  labelKey: MessageKey;
  defaultSpan: SectionSpan;
  minSpan?: SectionSpan;
  canCollapse?: boolean;
  /** Load-bearing sections (the inventory grid, the mastery list) opt out of hiding. */
  canHide?: boolean;
  /** Eligible for "Open in window"; the popout registry reads this. */
  canPopout?: boolean;
}

export interface SectionState {
  id: string;
  span: SectionSpan;
  hidden: boolean;
  collapsed: boolean;
}

export interface ViewLayout {
  version: 1;
  sections: SectionState[];
}

/** Persisted under LAYOUT_STORAGE_KEY; unknown ids drop, missing ids append. */
export interface LayoutStateV1 {
  version: 1;
  views: Partial<Record<LayoutView, Partial<Record<LayoutBreakpoint, ViewLayout>>>>;
}

export const LAYOUT_STORAGE_KEY = "wf_layout_v1";
export const LAYOUT_NARROW_MAX_PX = 1100;
