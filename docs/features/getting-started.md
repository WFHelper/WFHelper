---
title: Getting started
summary: Installation, inventory sources, and overlay setup.
group: Start here
order: 1
version: "2.1.1"
view: setup
screenshot: docs-setup.png
screenshotAlt: WFHelper setup with language, app size, and theme choices.
screenshotCaption: The setup wizard. You can change these choices later in Settings.
---

## Install and open WFHelper

1. Download WFHelper from [GitHub Releases](https://github.com/WFHelper/wfhelper/releases).
2. On Windows, download the release's `WFHelper-<version>-Setup.exe` and run it. The installer is unsigned, so Windows SmartScreen may show a warning. Make sure the file came from the project's release page, then choose **More info** and **Run anyway**.
3. On Linux, download the `.AppImage`, mark it executable in your file manager's Properties, and open it. See [Linux setup](#linux-setup) below for screen capture and Steam settings.
4. Choose your language, app size, and theme in the setup wizard, then select **Next**.

You do not need a WFHelper account. You only need a warframe.market sign-in for account features such as managing your listings.

## Choose an inventory source

### Automatic inventory

On Windows, select **warframe-api-helper**, then **Install Helper**. If it is already installed, select **Load Helper Data**. The setup wizard downloads the helper for you.

On Linux, select **Read from the running game**. The inventory reader is built in, so there is no separate helper to install.

Start Warframe and finish logging in. The first inventory can take a couple of minutes to arrive. Once it loads, continue to overlay placement.

While the game is running, automatic refreshes wait ten minutes between runs. What you see is a snapshot, so a trade or a newly claimed item can take a while to show up.

### Import a file

- **Import inventory JSON** reads an `inventory.json` from warframe-api-helper that you already have.
- **Import AlecaFrame cache** reads `lastData.dat` from `%LOCALAPPDATA%\AlecaFrame` on Windows. Pick the cache file itself, not an AlecaFrame stats or trade-history export.

An import shows what is in the file you picked. The automatic helper sync does not replace an imported inventory. You can change your inventory source in **Settings** later.

To read your inventory yourself, use **Export inventory** in **Settings**. It saves the loaded inventory as indented JSON instead of the single long line the helper writes.

### Continue without inventory

Choose **Continue without inventory** to use the World and market features. Connect a source later in Settings to see what you own and what you need for crafting.

## Position your overlays

The wizard shows previews of the relic reward, relic planner, riven, and arbitration summary overlays. Drag each preview into place and adjust its size. Positions save as you change them.

To check a reward scan:

1. Set **Warframe's UI language to English**. WFHelper's display language is a separate setting.
2. Leave WFHelper running, enter a Void Fissure mission, and open a relic.
3. When the reward choices appear, wait for the reward overlay to show their prices.
4. If it does not appear, check the overlay settings and the **Relic trigger hotkey** in **Settings > Overlays**. On Linux, also check the screen-share permission described below.

To move an overlay later, use **Position overlays** in **Settings > Overlays**, or press the unlock hotkey shown on the overlay and drag it. Native Wayland never delivers that hotkey; see Linux setup below.

## Customize overlay contents

Open **Settings > Appearance > Overlays** and select **Customize** next to an overlay. Select a field in the preview or in the element list, then drag it or change its offset, size, color and visibility. Arrow keys move the selected field by one pixel; hold Shift to move it by ten. Select **Save** to keep the layout, or **Cancel** to leave it unchanged.

The reward editor starts with **Mixed rewards**, which includes a long item name, three-digit prices and cards with different numbers of set parts. **Reward cards** shows six parts per card. After a reward scan, **Last reward screen** previews that screen with the prices and ownership it captured. This preview is only kept until WFHelper closes.

The preview uses the reward window's size. In the game, the window grows to fit its content until you resize it yourself; moving it somewhere else does not stop it from growing. Hover a large part count to see its full value.

Use **Settings > Appearance > Overlays > Overlay opacity** to make overlay backgrounds more or less see-through while the text stays visible. Expand **Customize each overlay** to set separate values for rewards, the relic planner, each Riven panel, the arbitration summary, and trade notifications. Reset a single value to make it follow the shared opacity again. Custom CSS only changes the main app, not the overlay windows.

## Linux setup

Run Warframe through Steam with Proton. For faster detection of overlay events, add `PROTON_LOG=1 %command%` to Warframe's **Properties > Launch Options**, then restart the game. The setup wizard also provides this string to copy.

On XWayland, WFHelper captures the screen through X11: there is nothing to install and no dialog. When WFHelper runs as a native Wayland app on Sway, Hyprland, river and niri, it copies the screen straight from the compositor, also with nothing to install and no dialog. If you turned on Hyprland's permission prompts, allow screen copy for WFHelper.

On KDE Plasma and COSMIC under native Wayland, the first capture in a session asks you to share a screen. Select the monitor showing Warframe and allow the request. If you dismiss it, the overlay cannot read the reward screen. Select **Set up screen capture** in **Settings > Overlays** before you play, so the dialog does not open behind the game. That dialog needs the desktop's portal package, `xdg-desktop-portal-kde` on KDE Plasma or `xdg-desktop-portal-cosmic` on COSMIC; log out and back in after installing it.

Keeping your warframe.market sign-in across restarts needs a keyring, such as gnome-keyring, KWallet or KeePassXC with Secret Service turned on. WFHelper uses a running keyring on its own; if it still asks you to sign in after every restart, start it with `--password-store=gnome-libsecret`.

Overlays work on X11, XWayland and native Wayland. On native Wayland they use the layer-shell protocol (KDE Plasma, Sway, Hyprland, niri, COSMIC); GNOME does not offer it, so WFHelper uses XWayland there. SteamOS game mode is unsupported.

Native Wayland gives apps no global hotkeys, so the overlay unlock hotkey never fires there. Select **Switch to interactive overlays** in **Settings > Overlays** and overlays open ready for clicks; the same button switches back. You can also bind `--toggle-overlay-interaction` to a key in your compositor. It switches the overlays on screen without opening the WFHelper window. In niri:

```
Mod+I { spawn "/path/to/WFHelper.AppImage" "--toggle-overlay-interaction"; }
```

## If setup gets stuck

- **Waiting for the game:** start Warframe and finish logging in. The launcher alone is not enough.
- **Access denied:** Warframe may be running as administrator. Restart the game and its launcher without **Run as administrator**.
- **Login token not found:** restart Warframe and try again. If the error comes back, include the exact message when you ask for help.
- **JSON rejected:** pick an inventory export, not a stats or trade-history export.
- **Items or quantities look old:** check which source is selected and remember the ten-minute wait between helper refreshes. An imported file only changes when you import a newer export.
- **Overlay cannot read a reward:** make sure the game's interface is in English, check screen-share permission on Linux, and follow any scan hint the app shows. If the app saved scan-debug files, **Settings > General > Open scan-debug folder** opens them.
- **Overlay fields overlap or look too small:** open [Customize overlay contents](#customize-overlay-contents), check the **Mixed rewards** preview, and reset the field or the whole layout.

Report problems that do not go away through [GitHub Issues](https://github.com/WFHelper/wfhelper/issues) or [Discord](https://discord.gg/7Gm3UvUSww). Include your app version, operating system, inventory source, and the exact error. Check logs and screenshots for personal information before you share them.

## Next: explore your inventory

See [Inventory](/docs/inventory) for prices, value estimates, and selling.
