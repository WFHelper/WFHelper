# Offline World scenarios

`createOfflineScenario` in `e2e/offlineScenario.ts` gives the shared Electron
harness a throwaway script that runs before the app's main script, plus a
callback that sets the renderer clock. Pick `world-darvo` for a fixed Darvo
deal, `world-loading` to hold the World response until you call
`scenario.releaseWorld(harness.app)`, or `world-unavailable` for failed DE and
oracle.browse.wf sources. Call `scenario.assertNoUnexpectedRequests()` after
each test, then close the harness before `scenario.dispose()`.

The World response uses raw DE fields and goes through the real parsing code
and IPC. The main-process and renderer clocks are both fixed at 2026-09-13
12:00 UTC, and timers keep running. Before the app starts, the scenario catches
`fetch` in the main process and HTTP(S) requests in Electron's default session.
Any request the scenario did not declare gets HTTP 599 and fails the request
assertion. Loading the warframe.market item list gets an empty fixture answer,
so it never falls back to its own Node HTTPS request.

Startup services that have nothing to do with the test get an "unavailable"
answer on purpose, and images from `assets.wfhelper.com` get a 404. The fonts
ship with the app in `renderer/fonts`, so they load normally, and so does the
catalog data packaged with the app. Use these scenarios for
layout, loading and error states. They are not meant for screenshot baselines,
market screens full of data, or tests of online services. They do not catch
other Node HTTPS or socket calls, WebSockets, or other Electron sessions, so add
your own interceptors when a test uses those.
