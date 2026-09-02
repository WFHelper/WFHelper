import { get, writable, type Readable } from "svelte/store";

import {
  parsePopoutBounds,
  parsePopoutTarget,
  popoutTargetKey,
  type PopoutBounds,
  type PopoutTarget,
  type PopoutWindowInfo,
} from "../../config/shared/popoutTypes.js";
import { isSafeMode } from "../lib/customCss/safeMode.js";
import { invoke, on } from "../lib/ipc.js";
import { normalizeLayoutState } from "../lib/layout/plan.js";
import type { LayoutStateV1 } from "../lib/layout/types.js";
import { log } from "../lib/log.js";
import { readStorage, writeStorage } from "../lib/persistence.js";
import { mergeSidebarOrder, TOGGLEABLE_VIEWS, type SidebarViewName } from "../lib/viewRegistry.js";
import { applyFilterLayoutState, getFilterLayoutState } from "./filterLayout.js";
import { applyLayoutState, layoutState } from "./layout.js";
import {
  clampSidebarWidth,
  hiddenTabs,
  sidebarOrder,
  sidebarWidth,
  tabVisibility,
} from "./sidebarTabs.js";
import type { ToggleableView } from "../types/views.js";

const STORAGE_KEY = "wf_workspaces_v1";
const MAX_WORKSPACES = 20;
const MAX_NAME_LENGTH = 60;

interface WorkspaceSidebar {
  order: SidebarViewName[];
  hidden: ToggleableView[];
  width: number;
}

interface WorkspacePopout {
  target: PopoutTarget;
  pinned: boolean;
  bounds?: PopoutBounds;
}

interface WorkspaceFilterLayout {
  order: string[];
  hidden: string[];
}

interface Workspace {
  id: string;
  name: string;
  sidebar: WorkspaceSidebar;
  layout: LayoutStateV1;
  filterLayout?: Record<string, WorkspaceFilterLayout>;
  popouts: WorkspacePopout[];
}

interface WorkspacesFile {
  version: 1;
  workspaces: Workspace[];
  restoreOnLaunch: string | null;
}

function emptyFile(): WorkspacesFile {
  return { version: 1, workspaces: [], restoreOnLaunch: null };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeSidebar(raw: unknown): WorkspaceSidebar {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const order = mergeSidebarOrder(readStringArray(entry.order));
  const allowed = new Set<string>(TOGGLEABLE_VIEWS);
  const hidden: ToggleableView[] = [];
  for (const id of readStringArray(entry.hidden)) {
    const view = id as ToggleableView;
    if (allowed.has(id) && !hidden.includes(view)) hidden.push(view);
  }
  const width =
    typeof entry.width === "number" ? clampSidebarWidth(entry.width) : get(sidebarWidth);
  return { order, hidden, width };
}

function normalizeFilterLayout(raw: unknown): Record<string, WorkspaceFilterLayout> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, WorkspaceFilterLayout> = {};
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    out[scope] = { order: readStringArray(entry.order), hidden: readStringArray(entry.hidden) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizePopouts(raw: unknown): WorkspacePopout[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WorkspacePopout[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    // A target this build no longer knows is dropped, never restored blind.
    const target = parsePopoutTarget(entry.target);
    if (!target) continue;
    const key = popoutTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const popout: WorkspacePopout = { target, pinned: entry.pinned === true };
    const bounds = parsePopoutBounds(entry.bounds);
    if (bounds) popout.bounds = bounds;
    out.push(popout);
  }
  return out;
}

function normalizeWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id === "") return null;
  const name = typeof entry.name === "string" ? entry.name.trim().slice(0, MAX_NAME_LENGTH) : "";
  const workspace: Workspace = {
    id: entry.id,
    name: name || entry.id,
    sidebar: normalizeSidebar(entry.sidebar),
    layout: normalizeLayoutState(entry.layout),
    popouts: normalizePopouts(entry.popouts),
  };
  const filterLayout = normalizeFilterLayout(entry.filterLayout);
  if (filterLayout) workspace.filterLayout = filterLayout;
  return workspace;
}

function normalizeFile(raw: unknown): WorkspacesFile {
  if (!raw || typeof raw !== "object") return emptyFile();
  const entry = raw as Record<string, unknown>;
  if (entry.version !== 1) return emptyFile();
  const list = Array.isArray(entry.workspaces) ? entry.workspaces : [];
  const workspaces: Workspace[] = [];
  const ids = new Set<string>();
  for (const value of list) {
    if (workspaces.length >= MAX_WORKSPACES) break;
    const workspace = normalizeWorkspace(value);
    if (!workspace || ids.has(workspace.id)) continue;
    ids.add(workspace.id);
    workspaces.push(workspace);
  }
  const restore = typeof entry.restoreOnLaunch === "string" ? entry.restoreOnLaunch : null;
  return {
    version: 1,
    workspaces,
    restoreOnLaunch: restore && ids.has(restore) ? restore : null,
  };
}

function load(): WorkspacesFile {
  const raw = readStorage(STORAGE_KEY);
  if (raw == null || raw.trim() === "") return emptyFile();
  try {
    return normalizeFile(JSON.parse(raw));
  } catch {
    log.warn("[Workspaces] stored workspaces are not readable JSON; starting empty");
    return emptyFile();
  }
}

const file = writable<WorkspacesFile>(load());

export const workspaces: Readable<WorkspacesFile> = { subscribe: file.subscribe };

function commit(next: WorkspacesFile): void {
  const normalized = normalizeFile(next);
  writeStorage(STORAGE_KEY, JSON.stringify(normalized));
  file.set(normalized);
}

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `ws-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function captureSidebar(): WorkspaceSidebar {
  const hiddenSet = get(hiddenTabs);
  return {
    order: [...get(sidebarOrder)],
    hidden: TOGGLEABLE_VIEWS.filter((view) => hiddenSet.has(view)),
    width: get(sidebarWidth),
  };
}

/** Windows currently open, kept fresh by the main-process push. */
export const openPopouts = writable<PopoutWindowInfo[]>([]);

async function refreshOpenPopouts(): Promise<void> {
  try {
    openPopouts.set(await invoke("popoutList"));
  } catch (err) {
    log.warn("[Workspaces] popoutList failed:", err);
  }
}

/** Live view of the open windows for as long as the caller keeps the disposer. */
export function subscribeOpenPopouts(): () => void {
  const off = on("popout-state-changed", (list) => openPopouts.set(list ?? []));
  void refreshOpenPopouts();
  return off;
}

export async function closeAllPopouts(): Promise<void> {
  try {
    await invoke("popoutCloseAll");
  } catch (err) {
    log.warn("[Workspaces] popoutCloseAll failed:", err);
  }
  await refreshOpenPopouts();
}

export async function saveWorkspace(name: string): Promise<string | null> {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) return null;
  let popouts: WorkspacePopout[] = [];
  try {
    popouts = (await invoke("popoutList")).map((info) => ({
      target: info.target,
      pinned: info.pinned,
      bounds: info.bounds,
    }));
  } catch (err) {
    // A workspace without its windows still beats losing the layout.
    log.warn("[Workspaces] popoutList failed while saving:", err);
  }
  const workspace: Workspace = {
    id: newId(),
    name: trimmed,
    sidebar: captureSidebar(),
    layout: get(layoutState),
    filterLayout: getFilterLayoutState(),
    popouts,
  };
  const current = get(file);
  // At the cap the oldest entry makes room, so saving never silently no-ops.
  const kept = current.workspaces.slice(
    Math.max(0, current.workspaces.length - MAX_WORKSPACES + 1),
  );
  commit({ ...current, workspaces: [...kept, workspace] });
  return workspace.id;
}

export function deleteWorkspace(id: string): void {
  const current = get(file);
  commit({
    ...current,
    workspaces: current.workspaces.filter((workspace) => workspace.id !== id),
    restoreOnLaunch: current.restoreOnLaunch === id ? null : current.restoreOnLaunch,
  });
}

export function renameWorkspace(id: string, name: string): void {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) return;
  const current = get(file);
  commit({
    ...current,
    workspaces: current.workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, name: trimmed } : workspace,
    ),
  });
}

export function setRestoreOnLaunch(id: string | null): void {
  const current = get(file);
  commit({ ...current, restoreOnLaunch: id });
}

async function applyPopouts(wanted: readonly WorkspacePopout[]): Promise<void> {
  let open: PopoutWindowInfo[];
  try {
    open = await invoke("popoutList");
  } catch (err) {
    log.warn("[Workspaces] popoutList failed while applying:", err);
    return;
  }
  const wantedByKey = new Map(wanted.map((popout) => [popoutTargetKey(popout.target), popout]));

  for (const info of open) {
    if (wantedByKey.has(popoutTargetKey(info.target))) continue;
    try {
      await invoke("popoutClose", info.target);
    } catch (err) {
      log.warn("[Workspaces] popoutClose failed:", err);
    }
  }

  // Open targets are asked for too; main moves and pins a window already up,
  // so a workspace restores geometry and not just what happened to be closed.
  for (const popout of wantedByKey.values()) {
    try {
      await invoke(
        "popoutOpen",
        popout.target,
        popout.bounds
          ? { pinned: popout.pinned, bounds: popout.bounds }
          : { pinned: popout.pinned },
      );
    } catch (err) {
      log.warn("[Workspaces] popoutOpen failed:", err);
    }
  }
  await refreshOpenPopouts();
}

export async function applyWorkspace(id: string): Promise<boolean> {
  const workspace = get(file).workspaces.find((entry) => entry.id === id);
  if (!workspace) return false;

  applyLayoutState(workspace.layout);
  if (workspace.filterLayout) applyFilterLayoutState(workspace.filterLayout);

  sidebarOrder.set([...workspace.sidebar.order]);
  sidebarWidth.set(workspace.sidebar.width);
  const hidden = new Set<string>(workspace.sidebar.hidden);
  for (const view of TOGGLEABLE_VIEWS) tabVisibility[view].set(!hidden.has(view));

  await applyPopouts(workspace.popouts);
  return true;
}

let launchRestoreDone = false;

/** One shot per session. Safe mode renders defaults, so it never restores, and a
    failure here must never stop the rest of startup. */
export async function restoreWorkspaceOnLaunch(): Promise<void> {
  if (launchRestoreDone) return;
  launchRestoreDone = true;
  if (isSafeMode()) return;
  const id = get(file).restoreOnLaunch;
  if (!id) return;
  try {
    await applyWorkspace(id);
  } catch (err) {
    log.warn("[Workspaces] restore on launch failed:", err);
  }
}
