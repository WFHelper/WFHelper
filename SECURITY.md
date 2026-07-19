# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/WFHelper/WFHelper/security/advisories/new)
(Security tab → "Report a vulnerability"). Include:

- what an attacker can do and how you found it,
- reproduction steps or a proof of concept,
- affected version and platform.

You'll get an acknowledgement, and we'll coordinate a fix and disclosure timeline
with you.

## Scope

WFHelper reads local game files (inventory snapshots, `EE.log`), captures the
screen for OCR, and talks to its own caching backend plus warframe.market. Areas
of particular interest:

- the Electron trust boundary (preload surface, IPC sender guards, CSP),
- the `backend/worker` public and admin routes,
- anything that could let remote data reach the main process or the filesystem.

Inventory snapshots, captured logs and stats stay on the user's machine; the app
bundles no telemetry.
