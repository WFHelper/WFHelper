# Verification

Use Corepack/pnpm 11 and Node 22.12 or newer. `backend/worker` intentionally uses
npm. No live account is needed for the automated checks below.

## Choose checks

| Change                   | Checks after editing                                                 | Coverage                                                                                                |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pure renderer/main logic | `pnpm run test <test path>` and relevant typecheck                   | Unit tests; use E2E for Electron and native APIs.                                                       |
| Svelte UI                | `pnpm run check`, `pnpm run build`, `pnpm run test:e2e:built <spec>` | Built Electron UI, IPC and layout; use a relevant fixture.                                              |
| Preload/IPC              | Typecheck, focused sender tests, build and relevant E2E              | Test production bridges, including rejected senders.                                                    |
| Reward OCR               | Build, `pnpm run test:reward-scan`                                   | Required synthetic/reconstructed/public full frames through production OCR. Every host crash fails.     |
| Riven OCR                | Build, `pnpm run test:riven-scan`                                    | Exact stat/weapon assertions on one full frame and blank rejection. Expand the corpus for new geometry. |
| Windows DBWIN            | Build, `pnpm run test:dbwin`                                         | Real Electron worker and native ABI against a decoy game.                                               |
| Overlay lifecycle        | Build, `pnpm run test:overlay-stress`                                | Repeated native window show/hide and fixture triggers. Live capture needs separate tests.               |
| Keyboard interception    | Build, `pnpm run test:keyhook --active-desktop`                      | Interactive opt-in. Decoy must own foreground focus before a key is sent.                               |
| Linux startup            | Build, `xvfb-run -a pnpm run test:linux-boot`                        | X11 application boot; exit 2 means prerequisites missing, not a pass.                                   |
| Packaged runtime         | `pnpm run test:packaged <executable-or-AppImage>`                    | Fresh profile, packaged UI, sharp and both ONNX models loading. Does not install or update the app.     |
| Worker                   | `pnpm run backend:typecheck`, `pnpm run backend:test`                | Cloudflare runtime tests. Deployed smoke is separate and uses the network.                              |

`pnpm run test:e2e <spec>` builds first. `test:e2e:built` reuses the existing
bundle, so rebuild after production changes. Run the full pre-push and CI checks
for cross-cutting changes.

The Windows CI job runs a shorter overlay stress test (30 churn/12 trigger
iterations); release acceptance runs the full defaults. Keyboard focus and
compositor checks require an interactive disposable session.

## Isolation and artifacts

Windows E2E, DBWIN, OCR, packaged smoke and overlay stress commands use
`scripts/hidden-desktop.mjs`. It keeps windows off the active desktop. The
keyboard-hook command refuses to start without its active-desktop flag, because it
sends real key presses; run it only when nothing else needs the keyboard.

Always use `WFHELPER_USER_DATA` for an isolated profile. `APPDATA` alone does not
relocate Electron's profile. The shared E2E harness also isolates APPDATA and LOCALAPPDATA
and disables the global keyboard hook. Set `WFHELPER_EE_LOG` to a sandbox path
on every platform, and supply a fixture inventory or persist `inventorySource:
"none"` in `inventory-reload-state.json` to prevent Downloads auto-discovery.
A custom launch must do the same.
Never use a real market account to verify mutations.

The shared harness records all-window console/errors, process output and local
logs under the test's output directory. Failed checks retain screenshots and
an Electron trace; `WFHELPER_KEEP_TRACE=1` keeps passing
traces too. Shutdown output and crash dumps are copied before sandbox cleanup.
Native/package runners print the retained directory on failure.

Playwright traces can be opened with `pnpm exec playwright show-trace <trace.zip>`.
The failure upload in CI collects `test-results/`. Reward, Riven and Linux
runners copy selected text diagnostics into `test-results/native/` (override
with `WFHELPER_NATIVE_ARTIFACTS`); full temporary profiles stay local. Inspect
private crash dumps locally before sharing.

## Reproducible state

`e2e/electronTestHarness.ts` supports inventory, localStorage, userData JSON,
pre-main test entrypoints and a cold restart that preserves the sandbox.
`e2e/offlineScenario.ts` provides fixed World deal/loading/unavailable scenarios.
They execute production parsing and fail undeclared requests. See
`e2e/scenarios/README.md` for intercepted transports.
Market tests use synthetic transport responses through production mutation IPC.

Required reward fixtures are tracked under `scripts/reward-scan-e2e/fixtures/public`;
the runner checks their dimensions and hashes. Private screenshots are optional.
Capture, fullscreen stacking, global input and Wayland output require separate
interactive tests.

## Visual review

`e2e/visual-baselines.spec.ts` compares selected Windows UI and overlay-preview
surfaces. Keep geometry assertions alongside image comparisons. Baselines are
platform-specific and deliberately use local Arial with the bundled fonts blocked;
Linux currently has no approved visual baseline.

After an intentional design change, use
`pnpm run test:e2e:built e2e/visual-baselines.spec.ts --update-snapshots`, inspect
every changed PNG, then run again without updating. Never accept a changed image
only to clear a failed check. A new font/OS runner may need separate reviewed
baselines rather than increasing tolerance.

## Debug builds and reports

`pnpm run build:debug` builds renderer/main/preload source maps and copies matching
JavaScript plus a commit/version/dirty-state manifest into `.tmp/debug-symbols/`.
It does not upload anything. Source maps are excluded from packaged artifacts.
Keep the matching local bundle and maps together; rebuild the package from that
bundle if diagnosing its minified stack. Normal builds do not produce renderer
maps.

For user reports, retain version, approximate failure time, inventory source,
OS, display scale, game window mode and Linux session/compositor when relevant.
Use the existing opt-in feedback/log and scan-debug paths. Do not collect tokens,
full inventory exports or the real profile as routine diagnostics.

## Release checks

Packaged smoke runs before release asset upload on Windows and Linux. It checks
model/library loading and first-run rendering. Installation, updates, migration
and rollback need separate tests. Use a disposable VM/Sandbox for installer
upgrades with synthetic previous-release state.
`scripts/installer-acceptance/README.md` describes the prepared Windows Sandbox
runner for two supplied installers, saved-state checks and diagnostic files.

Linux's VM recipe, `scripts/linux-vm-test.sh`, owns a separate EE.log and profile.
Run its setup and explicit launch commands in the intended disposable session.
Verify native Wayland and XWayland output, scaling, click-through, portal refusal
and stream restart there.
