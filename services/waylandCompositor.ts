// Native Wayland gives a client no way to choose its window's output, so the
// compositor has to be asked over its own ipc. Placement only: no compositor
// lets a normal window sit above a fullscreen one, that needs layer-shell.

import net from "node:net";
import path from "node:path";

import { withScope } from "./logger";
import { asRecord } from "../config/shared/objectValidation";

const log = withScope("waylandCompositor");

const REQUEST_TIMEOUT_MS = 400;

type CompositorKind = "niri" | "sway" | "hyprland";

interface Compositor {
  kind: CompositorKind;
  socketPath: string;
}

interface HyprClient {
  title?: unknown;
  class?: unknown;
  monitor?: unknown;
}

interface HyprMonitor {
  id?: unknown;
  name?: unknown;
  activeWorkspace?: { id?: unknown } | null;
}

const WARFRAME_NAME_RE = /warframe/i;
// Under Proton the wayland app id is the steam app id, not the game's name.
const WARFRAME_APP_ID_RE = /steam_app_230410/i;
const WARFRAME_TITLE_EXACT_RE = /^warframe$/i;

interface WarframeWindowCandidate {
  title: string;
  appId: string;
  activated?: boolean;
  fullscreen?: boolean;
}

// winewayland reports the exe as the app id, so an app id that names the game
// identifies it; any browser tab can carry the game's exact title.
function hasGameAppId(candidate: WarframeWindowCandidate): boolean {
  return WARFRAME_APP_ID_RE.test(candidate.appId) || WARFRAME_NAME_RE.test(candidate.appId);
}

function hasGameTitle(candidate: WarframeWindowCandidate): boolean {
  return WARFRAME_TITLE_EXACT_RE.test(candidate.title.trim());
}

function mentionsGame(candidate: WarframeWindowCandidate): boolean {
  return WARFRAME_NAME_RE.test(candidate.title);
}

function bestOf<T extends WarframeWindowCandidate>(candidates: T[]): T | null {
  return (
    candidates.find((entry) => entry.activated === true) ??
    candidates.find((entry) => entry.fullscreen === true) ??
    candidates[0] ??
    null
  );
}

/** The game window for every compositor path; a wiki tab or Steam dialog also has the name. */
export function pickWarframeWindow<T extends WarframeWindowCandidate>(candidates: T[]): T | null {
  for (const matches of [hasGameAppId, hasGameTitle, mentionsGame]) {
    const tier = candidates.filter(matches);
    if (tier.length > 0) return bestOf(tier);
  }
  return null;
}

export function detectCompositor(env: NodeJS.ProcessEnv): Compositor | null {
  if (env.NIRI_SOCKET) return { kind: "niri", socketPath: env.NIRI_SOCKET };
  if (env.SWAYSOCK) return { kind: "sway", socketPath: env.SWAYSOCK };
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (signature && runtimeDir) {
    const socketPath = path.join(runtimeDir, "hypr", signature, ".socket.sock");
    return { kind: "hyprland", socketPath };
  }
  return null;
}

/** One request per connection, which is what all three protocols expect. */
function socketExchange(
  socketPath: string,
  payload: Buffer,
  isComplete: (received: Buffer) => boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err: Error | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? Buffer.alloc(0));
    };

    const timer = setTimeout(() => finish(new Error("compositor ipc timeout")), REQUEST_TIMEOUT_MS);

    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      if (isComplete(received)) finish(null, received);
    });
    socket.on("error", (err: Error) => finish(err));
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
  });
}

function hasNewline(received: Buffer): boolean {
  return received.includes(0x0a);
}

/** One niri request, one parsed reply line. Throws on a socket, timeout or
 *  json failure, which every caller turns into "no answer". */
export async function niriRequest(socketPath: string, request: unknown): Promise<unknown> {
  const payload = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  const received = await socketExchange(socketPath, payload, hasNewline);
  const line = received.toString("utf8").split("\n")[0];
  return line ? JSON.parse(line) : null;
}

/** The payload of `{"Ok":{"<key>":...}}`, or undefined for anything else,
 *  including `{"Err":"..."}`. Undefined is "no answer"; null is an answer. */
export function niriOk(reply: unknown, key: string): unknown {
  const ok = (reply as { Ok?: Record<string, unknown> } | null)?.Ok;
  return ok && typeof ok === "object" ? ok[key] : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The game in niri's `Windows` reply, as the raw window record. */
export function niriGameWindow(windows: unknown[]): Record<string, unknown> | null {
  const candidates: Array<WarframeWindowCandidate & { win: Record<string, unknown> }> = [];
  for (const entry of windows) {
    const win = asRecord(entry);
    if (!win) continue;
    candidates.push({
      title: asString(win.title),
      appId: asString(win.app_id),
      activated: win.is_focused === true,
      win,
    });
  }
  return pickWarframeWindow(candidates)?.win ?? null;
}

export function niriWorkspaceOutput(workspaces: unknown[], workspaceId: unknown): string | null {
  if (typeof workspaceId !== "number") return null;
  const workspace = workspaces.map(asRecord).find((entry) => entry?.id === workspaceId);
  return asString(workspace?.output) || null;
}

/** Which output the game window is on, via the workspace it sits in. */
export function niriGameOutput(windows: unknown[], workspaces: unknown[]): string | null {
  const game = niriGameWindow(windows);
  return game ? niriWorkspaceOutput(workspaces, game.workspace_id) : null;
}

export function niriWindowIdByTitle(windows: unknown[], title: string): number | null {
  const match = windows.map(asRecord).find((win) => win?.title === title);
  return typeof match?.id === "number" ? match.id : null;
}

/** Older niri has no `focus` field on this action and rejects a request that
 *  carries it, so the caller falls back to the shorter form on an Err reply. */
export function niriMoveRequests(id: number, output: string): unknown[] {
  return [
    { Action: { MoveWindowToMonitor: { id, output, focus: false } } },
    { Action: { MoveWindowToMonitor: { id, output } } },
  ];
}

async function niriOutputName(socketPath: string): Promise<string | null> {
  const windows = niriOk(await niriRequest(socketPath, "Windows"), "Windows");
  const workspaces = niriOk(await niriRequest(socketPath, "Workspaces"), "Workspaces");
  if (!Array.isArray(windows) || !Array.isArray(workspaces)) return null;
  return niriGameOutput(windows, workspaces);
}

async function placeNiri(
  socketPath: string,
  title: string,
  target: string | null,
): Promise<boolean> {
  const windows = niriOk(await niriRequest(socketPath, "Windows"), "Windows");
  const workspaces = niriOk(await niriRequest(socketPath, "Workspaces"), "Workspaces");
  if (!Array.isArray(windows) || !Array.isArray(workspaces)) return false;

  const output = target ?? niriGameOutput(windows, workspaces);
  const id = niriWindowIdByTitle(windows, title);
  if (!output || id === null) return false;

  for (const request of niriMoveRequests(id, output)) {
    const reply = await niriRequest(socketPath, request);
    if (reply && typeof reply === "object" && "Ok" in reply) return true;
  }
  return false;
}

const SWAY_MAGIC = "i3-ipc";
const SWAY_HEADER_BYTES = SWAY_MAGIC.length + 8;
const SWAY_RUN_COMMAND = 0;
const SWAY_GET_TREE = 4;

function swayFrame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(SWAY_HEADER_BYTES);
  header.write(SWAY_MAGIC, 0, "ascii");
  header.writeUInt32LE(body.length, SWAY_MAGIC.length);
  header.writeUInt32LE(type, SWAY_MAGIC.length + 4);
  return Buffer.concat([header, body]);
}

function swayFrameComplete(received: Buffer): boolean {
  if (received.length < SWAY_HEADER_BYTES) return false;
  const length = received.readUInt32LE(SWAY_MAGIC.length);
  return received.length >= SWAY_HEADER_BYTES + length;
}

async function swayRequest(socketPath: string, type: number, payload: string): Promise<unknown> {
  const received = await socketExchange(socketPath, swayFrame(type, payload), swayFrameComplete);
  if (!swayFrameComplete(received)) return null;
  const length = received.readUInt32LE(SWAY_MAGIC.length);
  const body = received.subarray(SWAY_HEADER_BYTES, SWAY_HEADER_BYTES + length);
  return JSON.parse(body.toString("utf8"));
}

interface SwayNode {
  type?: unknown;
  name?: unknown;
  app_id?: unknown;
  window_properties?: { class?: unknown; title?: unknown } | null;
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

/** Walks down from each output, so every window is known with its enclosing
 *  output. Proton windows carry window_properties. */
export function swayGameOutput(tree: SwayNode | null): string | null {
  if (!tree) return null;
  const windows: Array<WarframeWindowCandidate & { output: string }> = [];
  const walk = (node: SwayNode, output: string | null): void => {
    const nextOutput = node.type === "output" && typeof node.name === "string" ? node.name : output;
    if (output && (node.type === "con" || node.type === "floating_con")) {
      windows.push({
        title: asString(node.name) || asString(node.window_properties?.title),
        appId: asString(node.app_id) || asString(node.window_properties?.class),
        output,
      });
    }
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
      walk(child, nextOutput);
    }
  };
  walk(tree, null);
  return pickWarframeWindow(windows)?.output ?? null;
}

/** Titles are ours and carry no regex metacharacters, so anchoring is enough. */
export function swayMoveCommand(title: string, output: string): string {
  return `[title="^${title}$"] move window to output "${output}"`;
}

async function swayOutputName(socketPath: string): Promise<string | null> {
  const tree = (await swayRequest(socketPath, SWAY_GET_TREE, "")) as SwayNode | null;
  return swayGameOutput(tree);
}

async function placeSway(
  socketPath: string,
  title: string,
  target: string | null,
): Promise<boolean> {
  const output =
    target ?? swayGameOutput((await swayRequest(socketPath, SWAY_GET_TREE, "")) as SwayNode | null);
  if (!output) return false;
  const reply = await swayRequest(socketPath, SWAY_RUN_COMMAND, swayMoveCommand(title, output));
  return Array.isArray(reply) && reply.every((entry) => (entry as { success?: unknown })?.success);
}

async function hyprRequest(socketPath: string, command: string): Promise<string> {
  const received = await socketExchange(socketPath, Buffer.from(command, "utf8"), () => false);
  return received.toString("utf8");
}

function hyprGameMonitor(clients: HyprClient[], monitors: HyprMonitor[]): HyprMonitor | null {
  const game = pickWarframeWindow(
    clients.map((client) => ({
      title: asString(client.title),
      appId: asString(client.class),
      client,
    })),
  );
  if (!game) return null;
  return monitors.find((entry) => entry.id === game.client.monitor) ?? null;
}

/** Hyprland moves windows between workspaces, not outputs, so the game's output
 *  is resolved to the workspace currently active on it. */
export function hyprGameWorkspace(clients: HyprClient[], monitors: HyprMonitor[]): number | null {
  const workspace = hyprGameMonitor(clients, monitors)?.activeWorkspace?.id;
  return typeof workspace === "number" ? workspace : null;
}

/** Layer surfaces are addressed by output name, not by workspace. */
export function hyprGameOutputName(clients: HyprClient[], monitors: HyprMonitor[]): string | null {
  return asString(hyprGameMonitor(clients, monitors)?.name) || null;
}

export function hyprWorkspaceOnOutput(monitors: HyprMonitor[], name: string): number | null {
  const workspace = monitors.find((entry) => entry.name === name)?.activeWorkspace?.id;
  return typeof workspace === "number" ? workspace : null;
}

/** Falls back to the game client's own monitor when hyprland does not report `target`. */
export function hyprTargetWorkspace(
  clients: HyprClient[],
  monitors: HyprMonitor[],
  target: string | null,
): number | null {
  const named = target === null ? null : hyprWorkspaceOnOutput(monitors, target);
  return named ?? hyprGameWorkspace(clients, monitors);
}

export function hyprMoveCommand(title: string, workspace: number): string {
  return `dispatch movetoworkspacesilent ${workspace},title:^(${title})$`;
}

async function placeHyprland(
  socketPath: string,
  title: string,
  target: string | null,
): Promise<boolean> {
  const clients = JSON.parse(await hyprRequest(socketPath, "j/clients")) as HyprClient[];
  const monitors = JSON.parse(await hyprRequest(socketPath, "j/monitors")) as HyprMonitor[];
  if (!Array.isArray(clients) || !Array.isArray(monitors)) return false;
  const workspace = hyprTargetWorkspace(clients, monitors, target);
  if (workspace === null) return false;
  const reply = await hyprRequest(socketPath, hyprMoveCommand(title, workspace));
  return reply.trim().toLowerCase().startsWith("ok");
}

async function hyprOutputName(socketPath: string): Promise<string | null> {
  const clients = JSON.parse(await hyprRequest(socketPath, "j/clients")) as HyprClient[];
  const monitors = JSON.parse(await hyprRequest(socketPath, "j/monitors")) as HyprMonitor[];
  if (!Array.isArray(clients) || !Array.isArray(monitors)) return null;
  return hyprGameOutputName(clients, monitors);
}

/** The connector the game is on, in the same spelling a layer surface wants.
 *  Null means unknown, and the caller must not guess: a layer surface pinned to
 *  the wrong output is worse than one the compositor placed itself. */
export async function resolveGameOutput(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const compositor = detectCompositor(env);
  if (!compositor) return null;
  try {
    if (compositor.kind === "niri") return await niriOutputName(compositor.socketPath);
    if (compositor.kind === "sway") return await swayOutputName(compositor.socketPath);
    return await hyprOutputName(compositor.socketPath);
  } catch (err) {
    log.warn(`[Compositor] ${compositor.kind} output lookup failed:`, (err as Error)?.message);
    return null;
  }
}

let loggedKind: CompositorKind | null = null;

/** Best effort: a compositor that answers differently than expected leaves the
 *  overlay exactly where it would have been, so every failure is only logged. */
export async function placeWindowOnGameOutput(
  title: string,
  target: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const compositor = detectCompositor(env);
  if (!compositor) return false;
  if (loggedKind !== compositor.kind) {
    loggedKind = compositor.kind;
    log.info(`[Compositor] placing overlays via ${compositor.kind} ipc`);
  }
  try {
    if (compositor.kind === "niri") return await placeNiri(compositor.socketPath, title, target);
    if (compositor.kind === "sway") return await placeSway(compositor.socketPath, title, target);
    return await placeHyprland(compositor.socketPath, title, target);
  } catch (err) {
    log.warn(`[Compositor] ${compositor.kind} placement failed:`, (err as Error)?.message);
    return false;
  }
}
