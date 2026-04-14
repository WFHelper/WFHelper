/**
 * Post-build step: bundles each preload script into a single self-contained file.
 *
 * Electron's sandboxed preload `require()` cannot resolve relative file paths,
 * so all local dependencies (e.g. config/shared/ipcChannels) must be inlined.
 * Running esbuild over the tsc output achieves this while keeping the rest of
 * the main-process code as normal CommonJS modules.
 */
const esbuild = require("esbuild");
const path = require("path");

const BUILD_DIR = path.resolve(__dirname, "..", ".electron-build");

const PRELOADS = [
  "preload.js",
  "preload-overlay.js",
  "preload-riven.js",
  "preload-trade-notification.js",
];

for (const name of PRELOADS) {
  const entry = path.join(BUILD_DIR, name);
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    outfile: entry,
    allowOverwrite: true,
    external: ["electron"],
    // Keep readable for debugging preload issues
    minify: false,
  });
}

console.log(`Bundled ${PRELOADS.length} preload scripts.`);
