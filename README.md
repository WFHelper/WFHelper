# WFHelper

Unofficial Warframe companion app for Windows and Linux. Reads your
inventory, prices it with live warframe.market data, scans relic rewards on
screen and tracks your arbitration runs straight from EE.log.

**[wfhelper.com](https://wfhelper.com)**: download, the full feature tour, and FAQ.

![WFHelper inventory with live warframe.market prices](.github/screenshots/inventory.png)

<sub>Shown in the midnight-blue theme. 10 themes are built in, or build your own.</sub>

## Features

In the app:

- **Inventory** - full account inventory with platinum prices, order books and
  an equipment tab for weapons and frames
- **Relics** - browse owned relics with contents, drop sources and rewards
- **Foundry** - crafting requirements with full component trees
- **Mastery** - what you have not mastered yet, and what you could build
- **Rivens** - your rivens with market comparison and a riven finder
- **Market** - manage your warframe.market orders in-app (sign-in optional)
- **Arbitrations** - automatic per-run analysis from EE.log: kills, drones,
  rotations and vitus luck vs. the expected drop model, plus the schedule with
  Windows notifications for favorited nodes
- **World** - cycles, fissures, invasions, bounties and circuit rotations
- **Stats** - daily platinum/credits/endo tracking and trade history
- **Wiki** - item drop locations and relic reward tables
- **Themes** - preset looks or build your own

In-game overlays (Warframe in Borderless mode):

- **Relic rewards** - prices every reward when your squad's relics crack
- **Relic planner** - ranks your owned relics on the relic selection screen
- **Riven scanner** - reads rolls and compares old vs. new stats while rerolling
- **Arbitration summary** - your run stats the moment the mission ends

Notifications: in-game whispers, warframe.market DMs and arbitration windows can
raise Windows notifications while you play.

> **Use English for Warframe's interface.** Relic and riven OCR recognizes only
> English item names. WFHelper's display language is separate and can be changed
> in Settings.

## Install

Download the latest `WFHelper-<version>-Setup.exe` from
[Releases](https://github.com/WFHelper/WFHelper/releases) and run it.

Windows SmartScreen may warn on first run because the installer is not
code-signed: click "More info", then "Run anyway".

### Linux

Download `WFHelper-<version>.AppImage` from
[Releases](https://github.com/WFHelper/WFHelper/releases), make it executable
and run it:

```
chmod +x WFHelper-*.AppImage
./WFHelper-*.AppImage
```

In a file manager instead: right-click the file, open Properties, then
Permissions, tick "Allow executing as program" and double-click it.

Good to know:

- **Warframe runs through Steam (Proton).** WFHelper finds the game's log
  inside the Proton prefix on its own, including Flatpak and Snap Steam
  installs.
- **Inventory comes straight from the running game.** Nothing extra to
  download on Linux.
- **Wayland picks its own backend.** The app puts itself on XWayland so the overlays
  can sit on top of the game. Compositors without a real XWayland (niri) show
  no window at all, so WFHelper notices, restarts on native Wayland and
  remembers it. Settings lets you pick the backend by hand. Wayland gives no
  app a way to force itself above another, so overlays are best-effort there.
- **Native Wayland has no global hotkeys.** The overlay unlock key never fires
  there, so use "Switch to interactive overlays" in Settings > Overlays, or bind
  `--toggle-overlay-interaction` to a key in your compositor. In niri:
  `Mod+I { spawn "/path/to/WFHelper.AppImage" "--toggle-overlay-interaction"; }`
- **SteamOS is untested.** Desktop mode may work like any other distro. Game
  mode is not supported: gamescope only displays the game it launched, so
  forcing the app into it can freeze the session.
- **Screen capture asks once per session.** The first overlay scan opens your
  desktop's screen-share dialog. Pick the monitor Warframe runs on.
- **Instant overlays need one launch option.** Add `PROTON_LOG=1 %command%` to
  Warframe's launch options (in Steam: right-click Warframe, Properties,
  Launch Options) and restart the game. The setup wizard shows the same string
  with a copy button. Without it the overlays still fire, just a few seconds
  later.

### Linux requirements

- **AppImage on Ubuntu 24.04 or newer:** install `libfuse2t64` and start the
  AppImage with `--no-sandbox` (Ubuntu's AppArmor blocks Electron's sandbox).
- **Reward and planner scans on native Wayland need a screen-share portal.**
  Install the one for your desktop:
  - niri: `xdg-desktop-portal-gnome`, and start niri with `niri-session`
    (NixOS: `programs.niri.enable = true;`)
  - sway or river: `xdg-desktop-portal-wlr`
  - Hyprland: `xdg-desktop-portal-hyprland`
  - KDE Plasma: `xdg-desktop-portal-kde`
  - GNOME has no layer-shell overlays, so keep WFHelper on XWayland there.

  Log out and back in after installing it. To check it, start a PipeWire screen capture in OBS or share your screen in a
  browser: a share dialog should open. **Settings > Overlays > Set up screen
  capture** opens that dialog before you play, so it does not hide behind the
  game on the first reward screen.
- **Saving your warframe.market login needs a keyring:** gnome-keyring, KWallet
  or KeePassXC with Secret Service turned on. WFHelper uses it on its own when
  one is running. If you still have to sign in after every restart, start
  WFHelper with `--password-store=gnome-libsecret` (or
  `--password-store=kwallet6` on KDE).

### Inventory data

The game client offers no local inventory API, so the first-run wizard offers
three sources:

- **warframe-api-helper** (recommended) - downloads
  [Sainan/warframe-api-helper](https://github.com/Sainan/warframe-api-helper)
  and loads its `inventory.json` snapshots while you play
- **JSON import** - open an existing `inventory.json` export
- **AlecaFrame import** - decrypts AlecaFrame's local `lastData.dat` cache

## Privacy

Inventory snapshots, captured arbitration logs and stats stay on your PC. The
app talks to its own caching backend for warframe.market prices and icons, the
public game-data sources listed below, and GitHub for updates. No crash
reporting or telemetry is built into the app. Backend requests produce route,
status, timing and item-slug observability records in Cloudflare/Grafana, plus
an anonymous daily active-user count.
Update checks are manual.

## Building from source

Requires Node 22+ and pnpm 11 (via corepack).

```
corepack enable
pnpm install --frozen-lockfile
pnpm run dev        # dev loop
pnpm run dist:win   # build the NSIS installer
```

## Credits

- [warframe.market](https://warframe.market) - prices and order data
- Digital Extremes' Public Export - item data and images
- [WFCD](https://github.com/WFCD) community projects - item database
  ([warframe-items](https://github.com/WFCD/warframe-items)), drop tables
  ([drops.warframestat.us](https://drops.warframestat.us)) and world-state API
- [browse.wf](https://browse.wf) - supplemental item icons
- [sves' arbi analyzer](https://svesk.github.io/arbi/) - the arbitration
  stats model this app's analyzer is ported from
- [Sainan/warframe-api-helper](https://github.com/Sainan/warframe-api-helper) -
  inventory snapshot tool
- AlecaFrame - `lastData.dat` import compatibility

## Support

WFHelper is free and open source, with no ads or accounts. If it saves you
plat, [Patreon](https://www.patreon.com/WFHelper) helps cover the Cloudflare
infrastructure it runs on. Supporters get a Discord role and a thank-you in
the app.

## Disclaimer

Unofficial fan project, not affiliated with or endorsed by Digital
Extremes. "Warframe" and related assets are property of Digital Extremes
Ltd.

## License

[MIT](LICENSE). The bundled Barlow and Rajdhani fonts in `renderer/fonts/` are
licensed under the SIL Open Font License 1.1.
