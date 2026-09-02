import type { MessageKey } from "../i18n.js";
import type { SectionSpan } from "../layout/types.js";

/** Dashboard widget ids are `widget.<name>`; sizes reuse the layout grid spans. */
export interface WidgetDescriptor {
  id: string;
  labelKey: MessageKey;
  defaultSpan: SectionSpan;
  allowedSpans: readonly SectionSpan[];
  /** Optional per-widget settings schema, validated at the boundary. */
  settings?: Readonly<Record<string, "boolean" | "number" | "string">>;
  canPopout?: boolean;
}

export interface DashboardWidgetState {
  id: string;
  span: SectionSpan;
  hidden: boolean;
  settings?: Record<string, boolean | number | string>;
}

export interface DashboardLayoutV1 {
  version: 1;
  widgets: DashboardWidgetState[];
}

export const DASHBOARD_STORAGE_KEY = "wf_dashboard_v1";
