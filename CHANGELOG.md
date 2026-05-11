# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-05-11

### Added

- Added an old WF data titlebar state when inventory data is older than 1 hour.
- Added Riven Finder filters for online/in-game sellers and 1p listings.
- Added ducat, ownership, set progress, and full-set price metadata to the relic reward overlay.

## [0.0.1] - 2026-05-11

### Security

- Added `sandbox: true` to all BrowserWindow webPreferences
- Restricted `http://localhost:*` CSP connect-src to development builds only
- Gated F12 devtools behind `!app.isPackaged` check
- Added `Permissions-Policy` response header (camera, microphone, geolocation, usb disabled)
- Validated `logoDataUrl` to require `data:image/` prefix before storage
- Fixed high-severity `tar` dependency vulnerability

### Changed

- Removed localStorage persistence for price, item-meta, and relic runtime caches (now in-memory only per session; backend-lite Worker is source of truth)
- Extracted `cloneDefaultTheme()` helper to eliminate 4x duplicate deep-clone expressions
- Collapsed `request()`/`requestV2()` duplication into shared `_coreRequest()` (~100 lines removed)
- Removed duplicate `$: ipc.setDebugMode($debugMode)` reactive statement
- Simplified `ipc.ts` by removing intermediate handler objects; `ipc` export now calls `window.api.*` directly
- Extracted startup data loading into `src/lib/startupLoader.ts`
- Moved `applyUpdateState()` into `src/stores/updates.ts`
- App.svelte reduced from 358 to ~200 lines
- Wired `VITE_APP_VERSION` from `package.json` into renderer builds
- Added app version display in StatusBar

### Added

- Theme system test suite (contrastUtils, themeStorage, applyTheme)
- Expanded relic EV computation tests (null prices, empty inventory edge cases)
- `CHANGELOG.md` following Keep a Changelog format
