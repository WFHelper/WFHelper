---
title: Getting started
summary: Installation, inventory sources, and overlay setup.
group: Start here
order: 1
version: "2.0"
view: setup
screenshot: docs-setup.png
screenshotAlt: WFHelper setup with language, app size, and theme choices.
screenshotCaption: The setup wizard. You can change these choices later in Settings.
---

## Install and open WFHelper

1. Download WFHelper from [GitHub Releases](https://github.com/WFHelper/wfhelper/releases).
2. On Windows, download the release's `WFHelper-<version>-Setup.exe` and run it. The installer is unsigned, so Windows SmartScreen may show a warning. Check that the file came from the project's release page before choosing **More info**, then **Run anyway**.
3. On Linux, download the `.AppImage`, mark it executable in your file manager's Properties, and open it. See [Linux setup](#linux-setup) below for screen capture and Steam settings.
4. Choose your language, app size, and theme in the setup wizard, then select **Next**.

You do not need a WFHelper account. A warframe.market sign-in is only needed for account features such as managing your listings.

## Choose an inventory source

### Automatic inventory

On Windows, select **warframe-api-helper**, then **Install Helper**. If it is already installed, select **Load Helper Data**. WFHelper downloads the helper through the setup wizard.

On Linux, select **Read from the running game**. The inventory reader is built in, so there is no separate helper executable to install.

Start Warframe and finish logging in. The first inventory can take a couple of minutes to arrive. Once it loads, continue to overlay placement.

Automatic inventory refreshes run on a ten-minute cooldown while the game is available. Your displayed inventory is a snapshot, so a trade or newly claimed item may take time to appear.

### Import a file

- **Import inventory JSON** reads an existing `inventory.json` from warframe-api-helper.
- **Import AlecaFrame cache** reads `lastData.dat` from `%LOCALAPPDATA%\AlecaFrame` on Windows. Select the cache itself, rather than an AlecaFrame stats or trade-history export.

Imported data reflects the selected file. Automatic helper sync does not overwrite an imported inventory. You can change your inventory source in **Settings** later.

### Continue without inventory

Choose **Continue without inventory** to use World and market features. Connect a source later in Settings to see your ownership and crafting requirements.

## Position your overlays

The wizard previews the relic reward, relic planner, riven, and arbitration summary overlays. Drag each preview into place and adjust its size. Positions save as you change them.

To check a reward scan:

1. Set **Warframe's UI language to English**. WFHelper's display language is a separate setting.
2. Leave WFHelper running, enter a Void Fissure mission, and open a relic.
3. When the reward choices appear, wait for the reward overlay to show their prices.
4. If it does not appear, check the overlay settings and the **Relic trigger hotkey** in **Settings > Overlays**. On Linux, also check the screen-share permission described below.

To reposition an overlay later, use the unlock hotkey shown on it.

## Customize overlay contents

Open **Settings > Appearance > Overlays** and select **Customize** beside an overlay. Select a field in the preview or the element list, then drag it or adjust its offset, size, color and visibility. Arrow keys move the selected preview field by one pixel; hold Shift for ten pixels. Select **Save** to keep the layout, or **Cancel** to leave it unchanged.

The reward editor starts with **Mixed rewards**, including a long item name, three-digit prices and cards with different numbers of set parts. **Reward cards** shows six parts per card. After a completed reward scan, **Last reward screen** previews that screen with its captured prices and ownership state. This preview is kept only until WFHelper closes.

The preview follows the reward window's size. The live window grows to fit its content until you manually resize it; dragging it to a different position does not disable automatic height. Large part counts keep their full value in the hover tooltip.

Use **Settings > Appearance > Overlays > Overlay opacity** to adjust overlay backgrounds while keeping text visible. Expand **Customize each overlay** to set separate values for rewards, the relic planner, each Riven panel, the arbitration summary, and trade notifications. Reset an individual value to follow the shared opacity again. Custom CSS applies to the main app, not overlay windows.

## Linux setup

Run Warframe through Steam with Proton. For faster detection of overlay events, add `PROTON_LOG=1 %command%` to Warframe's **Properties > Launch Options**, then restart the game. The setup wizard also provides this string to copy.

The first capture in a session asks you to share a screen. Select the monitor showing Warframe and allow the request. If you dismiss it, the overlay cannot read the reward screen.

Overlays work on X11, XWayland and native Wayland. On native Wayland they use the layer-shell protocol (KDE Plasma, Sway, Hyprland, niri, COSMIC); GNOME does not offer it, so WFHelper uses XWayland there. SteamOS game mode is unsupported.

## If setup gets stuck

- **Waiting for the game:** start Warframe and finish logging in. The launcher alone is not enough.
- **Access denied:** the setup message may indicate that Warframe is running as administrator. Restart the game and its launcher without **Run as administrator**.
- **Login token not found:** restart Warframe and try again. If the error persists, include the exact message when asking for help.
- **JSON rejected:** choose an inventory export, rather than a stats or trade-history export.
- **Items or quantities look old:** check the selected source and allow for the helper cooldown. Imported files need a newer export to reflect later changes.
- **Overlay cannot read a reward:** confirm the game's English interface, check screen-share permission on Linux, and follow any OCR hint shown by the app. If a scan-debug bundle was created, **Settings > Advanced > Open scan-debug folder** opens it.
- **Overlay fields overlap or look too small:** open [Customize overlay contents](#customize-overlay-contents), try the mixed preview and reset the affected field or layout.

Report persistent problems through [GitHub Issues](https://github.com/WFHelper/wfhelper/issues) or [Discord](https://discord.gg/7Gm3UvUSww). Include your app version, operating system, inventory source, and exact error. Check logs and screenshots for personal information before sharing them.

## Next: explore your inventory

See [Inventory](/docs/inventory) for prices, value estimates, and selling.
