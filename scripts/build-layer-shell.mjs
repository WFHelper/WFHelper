// Builds the optional Wayland layer-shell addon. Never wired into `pnpm install`,
// so a box without the toolchain still gets an AppImage that falls back to
// ordinary overlay windows. --require turns a skip into a failure, which release
// builds want: a silent skip there ships the feature permanently dead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native", "layer-shell");
const outDir = path.join(source, "build");
const protocolXml = path.join(source, "wlr-layer-shell-unstable-v1.xml");
const toplevelXml = path.join(source, "wlr-foreign-toplevel-management-unstable-v1.xml");

const required = process.argv.includes("--require");

function skip(reason) {
  if (required) {
    console.error(`build-layer-shell: ${reason} (required by --require)`);
    process.exit(1);
  }
  console.log(`build-layer-shell: skipped (${reason})`);
  process.exit(0);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

// execFileSync puts "Command failed: cc ..." in the message and the compiler
// diagnostics in stderr, so a failure reported from the message alone says
// nothing about what went wrong.
function failureReason(err) {
  const stderr = String(err?.stderr ?? "").trim();
  if (stderr) return stderr.split("\n").slice(-6).join("; ");
  return err?.message?.split("\n")[0] ?? "compile failed";
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

if (process.platform !== "linux") skip(`platform ${process.platform}`);

for (const tool of ["wayland-scanner", "pkg-config", "cc"]) {
  try {
    run("sh", ["-c", `command -v ${tool}`]);
  } catch {
    skip(`${tool} not installed`);
  }
}

let xdgShellXml = "";
let xdgOutputXml = "";
try {
  const dir = capture("pkg-config", ["--variable=pkgdatadir", "wayland-protocols"]);
  xdgShellXml = path.join(dir, "stable", "xdg-shell", "xdg-shell.xml");
  xdgOutputXml = path.join(dir, "unstable", "xdg-output", "xdg-output-unstable-v1.xml");
  if (!fs.existsSync(xdgShellXml)) skip("xdg-shell.xml not found");
  if (!fs.existsSync(xdgOutputXml)) skip("xdg-output-unstable-v1.xml not found");
} catch {
  skip("wayland-protocols not installed");
}

const nodeHeaders = path.join(path.dirname(path.dirname(process.execPath)), "include", "node");
const headerDirs = [nodeHeaders, "/usr/include/node", "/usr/local/include/node"];
const includeDir = headerDirs.find((dir) => fs.existsSync(path.join(dir, "node_api.h")));
if (!includeDir) skip("node_api.h not found");

try {
  fs.mkdirSync(outDir, { recursive: true });

  const generated = [];
  for (const [xml, base] of [
    [protocolXml, "wlr-layer-shell-unstable-v1"],
    [toplevelXml, "wlr-foreign-toplevel-management-unstable-v1"],
    [xdgShellXml, "xdg-shell"],
    [xdgOutputXml, "xdg-output-unstable-v1"],
  ]) {
    run("wayland-scanner", ["client-header", xml, path.join(outDir, `${base}-client-protocol.h`)]);
    const code = path.join(outDir, `${base}-protocol.c`);
    run("wayland-scanner", ["private-code", xml, code]);
    generated.push(code);
  }

  // wayland-cursor draws the pointer over an interactive surface.
  const packages = ["wayland-client", "wayland-cursor"];
  const cflags = capture("pkg-config", ["--cflags", ...packages])
    .split(/\s+/)
    .filter(Boolean);
  const libs = capture("pkg-config", ["--libs", ...packages])
    .split(/\s+/)
    .filter(Boolean);

  run(
    "cc",
    [
      "-O2",
      "-Wall",
      "-Wextra",
      "-shared",
      "-fPIC",
      "-o",
      path.join(outDir, "layershell.node"),
      path.join(source, "addon.c"),
      ...generated,
      `-I${includeDir}`,
      `-I${outDir}`,
      ...cflags,
      ...libs,
    ],
    root,
  );

  console.log(`build-layer-shell: built ${path.join(outDir, "layershell.node")}`);
} catch (err) {
  // Same contract as a missing tool: optional off release builds, fatal under
  // --require, where a swallowed compile error ships the feature dead.
  skip(failureReason(err));
}
process.exit(0);
