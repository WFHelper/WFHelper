# Verification

Use pnpm 11 through Corepack and Node 22.12 or newer. `backend/worker` uses npm
on purpose. None of the automated checks below need a live account.

## Which checks to run

| Change                              | Checks after editing                                                  | What they cover                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Renderer or main-process logic only | `pnpm run test <test path>` and the matching typecheck                | Unit tests. Use E2E for Electron and native APIs.                                                                                 |
| Svelte UI                           | `pnpm run check`, `pnpm run build`, `pnpm run test:e2e:built <spec>`  | The built Electron UI, IPC and layout. Use a fixture that fits the change.                                                        |
| Preload scripts or IPC              | Typecheck, the sender tests for that call, build and the matching E2E | The real bridges, including calls from a rejected sender.                                                                         |
| Reward OCR                          | Build, `pnpm run test:reward-scan`                                    | The required full screenshots (synthetic, rebuilt and public) through the real OCR. Any host crash fails the run.                 |
| Riven OCR                           | Build, `pnpm run test:riven-scan`                                     | Exact stats and weapon for one full screenshot, and a blank frame that must give nothing. Add screenshots for new crop positions. |
| Windows DBWIN                       | Build, `pnpm run test:dbwin`                                          | The real Electron worker and native calls against a decoy game.                                                                   |
| Overlay windows                     | Build, `pnpm run test:overlay-stress`                                 | Native windows shown and hidden many times, plus fixture triggers. Live capture needs its own tests.                              |
| Keyboard hook                       | Build, `pnpm run test:keyhook --active-desktop`                       | Opt-in and interactive. The decoy game must have keyboard focus before a key is sent.                                             |
| Linux startup                       | Build, `xvfb-run -a pnpm run test:linux-boot`                         | The app starting on X11. Exit code 2 means something it needs is missing, which is not a pass.                                    |
| Packaged app                        | `pnpm run test:packaged <executable-or-AppImage>`                     | A fresh profile, the packaged UI, sharp and both ONNX models loading. It does not install or update the app.                      |
| Worker                              | `pnpm run backend:typecheck`, `pnpm run backend:test`                 | Tests in the Cloudflare runtime. The smoke test against the deployed Worker is separate and needs the network.                    |

`pnpm run test:e2e <spec>` builds first. `test:e2e:built` reuses the last build,
so rebuild after changing app code. For changes that touch many areas, run the
full pre-push and CI checks.

The Windows CI job runs a shorter overlay stress test (30 show and hide rounds,
12 trigger rounds); release checks use the full default counts. Keyboard focus
and compositor checks need an interactive throwaway session.

## Isolation and test output

On Windows, the E2E, DBWIN, OCR, packaged app and overlay stress commands run
through `scripts/hidden-desktop.mjs`, which keeps their windows off your
desktop. The keyboard hook test sends real key presses, so it will not start
without `--active-desktop`. Run it only when nothing else needs the keyboard.

Always set `WFHELPER_USER_DATA` to a separate profile folder. Setting `APPDATA`
alone does not move Electron's profile. The shared E2E harness also points
APPDATA and LOCALAPPDATA at the sandbox and turns off the global keyboard hook.
On every platform, set `WFHELPER_EE_LOG` to a path inside the sandbox. Either
supply a fixture inventory or save `inventorySource: "none"` in
`inventory-reload-state.json`, so the app does not look for inventory files in
Downloads. A custom launch has to do the same. Do not use a real market account
to test anything that creates or changes listings.

The shared harness saves console output and errors from every window, process
output and local logs in the test's output folder. A failed check keeps
screenshots and an Electron trace; set `WFHELPER_KEEP_TRACE=1` to keep traces
from passing runs too. Shutdown output and crash dumps are copied out before the
sandbox is removed. The native and packaged runners print the folder they kept
when they fail.

Open a Playwright trace with `pnpm exec playwright show-trace <trace.zip>`. When
CI fails it uploads `test-results/`. The reward, riven and Linux runners copy
some text diagnostics into `test-results/native/` (set
`WFHELPER_NATIVE_ARTIFACTS` to use another folder); full temporary profiles stay
on your machine. Crash dumps are private, so look through them locally before
sharing one.

## Repeatable test state

`e2e/electronTestHarness.ts` can load an inventory, localStorage and userData
JSON, run a test script before the app's main script, and restart the app cold
while keeping the sandbox. `e2e/offlineScenario.ts` has fixed World scenarios: a
Darvo deal, a World response that stays loading, and failed World sources. They run
the real parsing code and fail on any request the test did not declare.
`e2e/scenarios/README.md` lists which network calls they catch. Market tests
send made-up warframe.market responses through the real IPC calls that create
and change listings.

The required reward screenshots are in `scripts/reward-scan-e2e/fixtures/public`;
the runner checks their dimensions and hashes. Private screenshots are optional.
Screen capture, fullscreen window stacking, global input and Wayland output need
separate interactive tests.

## Screenshot comparisons

`e2e/visual-baselines.spec.ts` compares screenshots of selected Windows UI and
overlay previews. Keep the size and position checks next to the image
comparisons. Baseline images only apply to the platform they were made on, and
they use the local Arial font on purpose, with the bundled fonts blocked. Linux
has no approved baseline yet.

After a deliberate design change, run
`pnpm run test:e2e:built e2e/visual-baselines.spec.ts --update-snapshots`, look
at every PNG that changed, then run it again without updating. Do not accept a
changed image just to make a failing check pass. A new font or OS runner may
need its own reviewed baselines instead of a higher tolerance.

## Debug builds and bug reports

`pnpm run build:debug` builds source maps for the renderer, main process and
preload scripts, and copies the matching JavaScript into `.tmp/debug-symbols/`
with a manifest of the commit, the version and whether the tree had uncommitted
changes. It uploads nothing. Packaged builds never include source maps. Keep a
local bundle and its maps together; to read a minified stack trace from a
package, rebuild the package from that bundle. Normal builds make no renderer
maps.

For a user report, note the version, roughly when it failed, the inventory
source, the OS, display scale, game window mode and, on Linux, the session and
compositor when they matter. Use the existing opt-in feedback, log and
scan-debug options. Do not ask for tokens, full inventory exports or the user's
real profile as a routine step.

## Release checks

Before release files are uploaded, the packaged app test runs on Windows and
Linux. It checks that the models and libraries load and that the first-run
screen renders. Installing, updating, migrating and rolling back need separate
tests. Test installer upgrades in a throwaway VM or Windows Sandbox with made-up
state from the previous release. `scripts/installer-acceptance/README.md`
describes the prepared Windows Sandbox run: it takes two installers, checks the
saved state and keeps diagnostic files.

On Linux, the VM script `scripts/linux-vm-test.sh` keeps its own EE.log and
profile. Run its setup and launch commands in the throwaway session they are
meant for. Check native Wayland and XWayland output, scaling, click-through, a
refused screen-share request and a restarted capture stream there.
