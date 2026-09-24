// Runs the overlay churn spec against the EXISTING built bundle; run
// `pnpm run build` first whenever main or renderer sources changed.
// The spec skips itself unless WFHELPER_OVERLAY_STRESS is set, which this sets.
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);

const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (
    !["--iterations", "--trigger-iterations", "--artifacts"].includes(name) ||
    !value ||
    value.startsWith("--") ||
    flags.has(name)
  ) {
    throw new Error(`Expected --iterations N, --trigger-iterations N or --artifacts PATH: ${name}`);
  }
  if (name !== "--artifacts" && (!/^\d+$/.test(value) || Number(value) < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
  flags.set(name, value);
}

const env = { ...process.env, WFHELPER_OVERLAY_STRESS: "1", WFHELPER_DISABLE_DBWIN: "1" };
const iterations = flags.get("--iterations");
const triggerIterations = flags.get("--trigger-iterations");
const artifacts = flags.get("--artifacts");
if (iterations) env.WFHELPER_OVERLAY_STRESS_ITERATIONS = iterations;
if (triggerIterations) env.WFHELPER_OVERLAY_STRESS_TRIGGER_ITERATIONS = triggerIterations;
env.WFHELPER_OVERLAY_STRESS_ARTIFACTS =
  artifacts ||
  env.WFHELPER_OVERLAY_STRESS_ARTIFACTS ||
  path.resolve("test-results", "overlay-stress-artifacts");

const command = [
  "corepack",
  "pnpm",
  "exec",
  "playwright",
  "test",
  "--config",
  "playwright.config.ts",
  "e2e/overlay-stress.spec.ts",
  "--workers",
  "1",
  "--retries",
  "0",
  "--reporter",
  "line",
];

// pnpm is a .cmd on Windows, so it needs a shell; passing one string avoids
// node's warning about unescaped args under shell:true.
const useShell = process.platform === "win32";
const child = useShell
  ? spawn(command.join(" "), { stdio: "inherit", env, shell: true })
  : spawn(command[0], command.slice(1), { stdio: "inherit", env });

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
child.on("error", (error) => {
  console.error(`Overlay stress could not start: ${error.message}`);
  process.exitCode = 1;
});
