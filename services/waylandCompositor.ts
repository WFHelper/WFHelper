// Native Wayland gives a client no way to choose its window's output, so the
// compositor has to be asked over its own ipc. Placement only: no compositor
// lets a normal window sit above a fullscreen one, that needs layer-shell.

import net from "node:net";
import path from "node:path";

import { withScope } from "./logger";

const log = withScope("waylandCompositor");

const REQUEST_TIMEOUT_MS = 400;

type CompositorKind = "niri" | "sway" | "hyprland";

interface Compositor {
  kind: CompositorKind;
  socketPath: string;
}

interface NiriWindow {
  id?: unknown;
  title?: unknown;
  app_id?: unknown;
  workspace_id?: unknown;
}

interface NiriWorkspace {
  id?: unknown;
  output?: unknown;
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

// Only the game's own window titles itself exactly "Warframe"; a wiki tab or
// "Warframe - Properties" merely contains it.
const WARFRAME_TITLE_EXACT_RE = /^warframe$/i;

/** Whether any of these window fields names the game. The single matcher for
 *  every compositor path, including the foreign-toplevel and niri reads. */
export function looksLikeWarframe(...fields: unknown[]): boolean {
  return fields.some(
    (field) =>
      typeof field === "string" && (WARFRAME_NAME_RE.test(field) || WARFRAME_APP_ID_RE.test(field)),
  );
}

interface WarframeWindowCandidate {
  title: string;
  appId: string;
  activated?: boolean;
  fullscreen?: boolean;
}

// winewayland reports the exe as the app id, so an app id that names the game
// identifies it; a title that only contains the word does not.
function isStrongMatch(candidate: WarframeWindowCandidate): boolean {
  return (
    WARFRAME_APP_ID_RE.test(candidate.appId) ||
    WARFRAME_NAME_RE.test(candidate.appId) ||
    WARFRAME_TITLE_EXACT_RE.test(candidate.title.trim())
  );
}

function bestOf<T extends WarframeWindowCandidate>(candidates: T[]): T | null {
  return (
    candidates.find((entry) => entry.activated === true) ??
    candidates.find((entry) => entry.fullscreen === true) ??
    candidates[0] ??
    null
  );
}

/** The game among windows that merely mention it. Taking the first match lets
 *  a browser tab or the Steam properties dialog shadow the game, whose focus
 *  then reads false for the whole session. */
export function pickWarframeWindow<T extends WarframeWindowCandidate>(candidates: T[]): T | null {
  const strong = candidates.filter(isStrongMatch);
  if (strong.length > 0) return bestOf(strong);
  return bestOf(candidates.filter((entry) => WARFRAME_NAME_RE.test(entry.title)));
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

function asCandidate(win: NiriWindow): WarframeWindowCandidate & { win: NiriWindow } {
  return {
    title: typeof win.title === "string" ? win.title : "",
    appId: typeof win.app_id === "string" ? win.app_id : "",
    win,
  };
}

/** Which output the game window is on, via the workspace it sits in. */
export function niriGameOutput(windows: NiriWindow[], workspaces: NiriWorkspace[]): string | null {
  const game = pickWarframeWindow(windows.map(asCandidate));
  if (!game) return null;
  const workspace = workspaces.find((entry) => entry.id === game.win.workspace_id);
  return typeof workspace?.output === "string" ? workspace.output : null;
}

export function niriWindowIdByTitle(windows: NiriWindow[], title: string): number | null {
  const match = windows.find((win) => win.title === title);
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
  return niriGameOutput(windows as NiriWindow[], workspaces as NiriWorkspace[]);
}

async function placeNiri(
  socketPath: string,
  title: string,
  target: string | null,
): Promise<boolean> {
  const windows = niriOk(await niriRequest(socketPath, "Windows"), "Windows");
  const workspaces = niriOk(await niriRequest(socketPath, "Workspaces"), "Workspaces");
  if (!Array.isArray(windows) || !Array.isArray(workspaces)) return false;

  const output = target ?? niriGameOutput(windows as NiriWindow[], workspaces as NiriWorkspace[]);
  const id = niriWindowIdByTitle(windows as NiriWindow[], title);
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

/** Walks down from each output, so the enclosing output name is known by the
 *  time the game node is found. Proton windows carry window_properties. */
export function swayGameOutput(tree: SwayNode | null): string | null {
  if (!tree) return null;
  const walk = (node: SwayNode, output: string | null): string | null => {
    const nextOutput = node.type === "output" && typeof node.name === "string" ? node.name : output;
    const isGame = looksLikeWarframe(
      node.app_id,
      node.window_properties?.class,
      node.window_properties?.title,
      // An output is named after the connector, so its own name is only a game
      // match once we are below one.
      output ? node.name : null,
    );
    if (nextOutput && isGame) return nextOutput;
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
      const found = walk(child, nextOutput);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, null);
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

/** Hyprland moves windows between workspaces, not outputs, so the game's output
 *  is resolved to the workspace currently active on it. */
export function hyprGameWorkspace(clients: HyprClient[], monitors: HyprMonitor[]): number | null {
  const game = clients.find((client) => looksLikeWarframe(client.title, client.class));
  if (!game) return null;
  const monitor = monitors.find((entry) => entry.id === game.monitor);
  const workspace = monitor?.activeWorkspace?.id;
  return typeof workspace === "number" ? workspace : null;
}

/** Layer surfaces are addressed by output name, not by workspace. */
export function hyprGameOutputName(clients: HyprClient[], monitors: HyprMonitor[]): string | null {
  const game = clients.find((client) => looksLikeWarframe(client.title, client.class));
  if (!game) return null;
  const monitor = monitors.find((entry) => entry.id === game.monitor);
  const name = (monitor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name ? name : null;
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
