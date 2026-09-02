import type { LayoutView, SectionDescriptor } from "./types.js";

// Module-level so a view's sections exist before its component mounts; the
// layout store, popout menu and dashboard all read the same list.
const sectionsByView = new Map<LayoutView, SectionDescriptor[]>();

export function registerSections(view: LayoutView, sections: readonly SectionDescriptor[]): void {
  const seen = new Set<string>();
  const clean: SectionDescriptor[] = [];
  for (const section of sections) {
    if (section.view !== view || seen.has(section.id)) continue;
    seen.add(section.id);
    clean.push(section);
  }
  sectionsByView.set(view, clean);
}

export function sectionsFor(view: LayoutView): readonly SectionDescriptor[] {
  return sectionsByView.get(view) ?? [];
}

export function sectionById(id: string): SectionDescriptor | null {
  const view = id.split(".")[0] as LayoutView;
  return sectionsFor(view).find((section) => section.id === id) ?? null;
}
