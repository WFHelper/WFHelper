# layer-shell addon

Optional. Built only by `scripts/build-layer-shell.mjs` on Linux, never during
`pnpm install`, and the build is allowed to fail: without the `.node` the app
uses ordinary BrowserWindow overlays exactly as before.

`wlr-layer-shell-unstable-v1.xml` is vendored because it ships with wlroots and
is in no Debian package. `wlr-foreign-toplevel-management-unstable-v1.xml`, which
backs `toplevels()`, is vendored for the same reason. Generated code also needs
`xdg-shell-protocol.c` from `wayland-protocols`, or the link fails on
`xdg_popup_interface`.

Develop against a throwaway compositor rather than a desktop session:

    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c /dev/null
