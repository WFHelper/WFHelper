# Security Policy

## Supported versions

Only the latest release gets security fixes. Please update before reporting.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/WFHelper/WFHelper/security/advisories/new)
(Security tab > "Report a vulnerability"). Include:

- what an attacker can do and how you found it,
- steps to reproduce it or a proof of concept,
- the affected version and platform.

We will confirm that we got your report and agree on a fix and disclosure
timeline with you.

## Scope

WFHelper reads local game files (inventory snapshots, `EE.log`), captures the
screen for OCR, and talks to its own caching backend and to warframe.market.
We are most interested in:

- the boundary between the app's pages and Electron: what the preload scripts
  expose, the IPC sender checks and the content security policy,
- the public and admin routes of `backend/worker`,
- anything that could let remote data reach the main process or the filesystem.

Inventory snapshots, captured logs and stats stay on the user's machine. The app
has no telemetry; the backend only keeps an anonymous count of daily active users.
