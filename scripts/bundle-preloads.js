/**
 * Post-build step: bundles each preload script into a single self-contained file.
 *
 * Electron's sandboxed preload `require()` cannot resolve relative file paths,
 * so all local dependencies (e.g. config/shared/ipcChannels) must be inlined.
 * Running esbuild over the tsc output achieves this while keeping the rest of
 * the main-process code as normal CommonJS modules.
 *
 * Pass `--watch` to keep re-bundling whenever the tsc output changes (used by
 * `npm run dev`). Without it we bundle once and exit (used by `npm run build`).
 */
const esbuild = require("esbuild");
const path = require("path");

const BUILD_DIR = path.resolve(__dirname, "..", ".electron-build");
const WATCH = process.argv.includes("--watch");

const PRELOADS = [
  "preload.js",
  "preload-overlay.js",
  "preload-riven.js",
  "preload-trade-notification.js",
];

async function main() {
  const configs = PRELOADS.map((name) => {
    const entry = path.join(BUILD_DIR, name);
    return {
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      outfile: entry,
      allowOverwrite: true,
      external: ["electron"],
      // Keep readable for debugging preload issues
      minify: false,
    };
  });

  if (!WATCH) {
    for (const cfg of configs) {
      esbuild.buildSync(cfg);
    }
    console.log(`Bundled ${PRELOADS.length} preload scripts.`);
    return;
  }

  // Watch mode: build once, then re-bundle on tsc output changes.
  const contexts = await Promise.all(configs.map((cfg) => esbuild.context(cfg)));
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(`[bundle-preloads] watching ${PRELOADS.length} preload scripts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
