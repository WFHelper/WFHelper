// Runs the overlay churn spec against the EXISTING built bundle; run
// `pnpm run build` first whenever main or renderer sources changed.
// The spec skips itself unless WFHELPER_OVERLAY_STRESS is set, which this sets.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

function readFlag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const env = { ...process.env, WFHELPER_OVERLAY_STRESS: "1" };
const iterations = readFlag("--iterations");
const triggerIterations = readFlag("--trigger-iterations");
const artifacts = readFlag("--artifacts");
if (iterations) env.WFHELPER_OVERLAY_STRESS_ITERATIONS = iterations;
if (triggerIterations) env.WFHELPER_OVERLAY_STRESS_TRIGGER_ITERATIONS = triggerIterations;
if (artifacts) env.WFHELPER_OVERLAY_STRESS_ARTIFACTS = artifacts;

const command = [
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
