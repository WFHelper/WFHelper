import { spawnSync } from "node:child_process";

// Chromium's desktop detection (base/nix/xdg_util.cc): the first XDG_CURRENT_DESKTOP
// entry it knows decides, and LXQt, KDE3 and anything unknown get basic_text, which
// safeStorage reports as no encryption at all.
const XDG_KEYRING = new Map([
  ["Unity", true],
  ["Deepin", true],
  ["GNOME", true],
  ["X-Cinnamon", true],
  ["KDE", true],
  ["Pantheon", true],
  ["XFCE", true],
  ["UKUI", true],
  ["LXQt", false],
]);
const SESSION_KEYRING = /^(deepin|gnome|mate|kde4|kde-plasma|xubuntu|ukui|.*xfce.*)$/;

const SECRET_SERVICE = "org.freedesktop.secrets";
const DBUS_CALL = [
  "--user",
  "call",
  "org.freedesktop.DBus",
  "/org/freedesktop/DBus",
  "org.freedesktop.DBus",
];
// Two calls at most, so startup waits no longer than 500ms for a stuck bus.
const BUS_CALL_TIMEOUT_MS = 250;

type SecretService = "running" | "activatable" | "absent" | "no-busctl" | "timeout" | "no-bus";

interface BusAnswer {
  status: number | null;
  stdout: string;
  error?: NodeJS.ErrnoException;
}

type BusRunner = (args: string[], timeoutMs: number) => BusAnswer;

interface PasswordStoreChoice {
  store: "gnome-libsecret" | null;
  summary: string;
}

function runBusctl(args: string[], timeoutMs: number): BusAnswer {
  const result = spawnSync("busctl", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

function busFailure(answer: BusAnswer): SecretService | null {
  if (answer.error?.code === "ENOENT") return "no-busctl";
  if (answer.error?.code === "ETIMEDOUT") return "timeout";
  if (answer.error || answer.status !== 0) return "no-bus";
  return null;
}

/** Whether a Secret Service (gnome-keyring, KWallet, KeePassXC) answers on the session bus. */
export function probeSecretService(run: BusRunner = runBusctl): SecretService {
  const owner = run([...DBUS_CALL, "NameHasOwner", "s", SECRET_SERVICE], BUS_CALL_TIMEOUT_MS);
  const ownerFailure = busFailure(owner);
  if (ownerFailure) return ownerFailure;
  if (/^b\s+true\b/.test(owner.stdout.trim())) return "running";
  const listed = run([...DBUS_CALL, "ListActivatableNames"], BUS_CALL_TIMEOUT_MS);
  const listFailure = busFailure(listed);
  if (listFailure) return listFailure;
  return listed.stdout.includes(`"${SECRET_SERVICE}"`) ? "activatable" : "absent";
}

function keyringDesktop(env: Record<string, string | undefined>): string | null {
  for (const name of (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((entry) => entry.trim())) {
    const keyring = XDG_KEYRING.get(name);
    if (keyring !== undefined) return keyring ? name : null;
  }
  const session = env.DESKTOP_SESSION ?? "";
  const kdeVersioned = env.KDE_SESSION_VERSION !== undefined;
  if (SESSION_KEYRING.test(session)) return session;
  if (session === "kde") return kdeVersioned ? session : null;
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return "GNOME";
  if (env.KDE_FULL_SESSION !== undefined && kdeVersioned) return "KDE";
  return null;
}

const NO_SWITCH_REASON: Record<Exclude<SecretService, "running" | "activatable">, string> = {
  absent: "no Secret Service on the session bus, the login is not saved",
  "no-busctl": "busctl is not installed, Secret Service not checked",
  timeout: `the session bus did not answer within ${BUS_CALL_TIMEOUT_MS}ms`,
  "no-bus": "no session bus reachable",
};

/**
 * Chromium reads the store once safeStorage starts, after this runs, so the switch
 * only takes effect when appended before app ready. Null off Linux.
 */
export function choosePasswordStore(
  platform: string,
  argv: readonly string[],
  env: Record<string, string | undefined>,
  probe: () => SecretService = probeSecretService,
): PasswordStoreChoice | null {
  if (platform !== "linux") return null;
  if (argv.some((arg) => arg === "--password-store" || arg.startsWith("--password-store="))) {
    return { store: null, summary: "left to --password-store from the command line" };
  }
  const desktop = keyringDesktop(env);
  if (desktop) return { store: null, summary: `left to Electron (${desktop} desktop)` };
  const service = probe();
  const named = `desktop "${env.XDG_CURRENT_DESKTOP || "unset"}"`;
  if (service === "running" || service === "activatable") {
    return {
      store: "gnome-libsecret",
      summary: `password-store=gnome-libsecret (${named} has no keyring default, Secret Service ${service})`,
    };
  }
  return { store: null, summary: `left to Electron (${named}: ${NO_SWITCH_REASON[service]})` };
}
