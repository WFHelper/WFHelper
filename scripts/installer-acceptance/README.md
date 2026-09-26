# Windows installer upgrade acceptance

This prepares a throwaway Windows Sandbox run. Preparing only copies files; it
never starts an installer or the app on your own machine. Windows Sandbox has to
be available and turned on before you open the generated `.wsb` file.

```powershell
node scripts/installer-acceptance/prepare.mjs `
  --previous "D:\Installers\WFHelper-1.3.4-Setup.exe" --previous-version 1.3.4 `
  --current "D:\Installers\WFHelper-2.0.0-Setup.exe" --current-version 2.0.0 `
  --output "D:\WFHelper-upgrade-check"
```

The output folder must not exist yet. Open `D:\WFHelper-upgrade-check\WFHelper-upgrade.wsb`
to start the run. Only two folders are shared with the sandbox: `inputs`
(read-only) and `results` (writable). The repository, your home folder and your
real WFHelper profile are never shared. Networking and clipboard sharing are
turned off. The verifier runs on the copied Node executable; nothing is
installed.

Inside Windows Sandbox the runner:

1. Keeps a test `autoInstallHelper: false` preference in place during the silent install.
2. Installs the previous NSIS installer and checks the installed executable's version.
3. Uses that app's renderer IPC to save non-default scales and import a test
   trade. It also writes a marker to localStorage.
4. Closes the previous app, runs the current installer into the same folder,
   then checks the installed version and reads the saved state back through the current app.
5. Saves the state JSON, screenshots, settings and trade files, logs and `result.json` to `results`.

Check `result.json` for `passed: true`. If the file is missing, the run did not
finish. Each run needs a fresh Sandbox session. The runner will not run outside
the sandbox.

This checks NSIS upgrades, startup, and saved settings and trades. Updater
downloads, signature checks and the installer's own options need separate tests.
The previous release must have `getOverlaySettings`, `setOverlaySettings`,
`importTradeLog` and `getTradeLog`; v1.3.4 has them. Check that these calls
exist before testing other releases.

The runner stops when a shutdown fails, a call is missing, or the installed
version is not the expected one.
