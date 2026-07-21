#!/bin/bash
# Linux VM test kit for WFHelper (tier-2: overlay + desktop behavior, no game).
#
# Fakes what the app uses to decide "Warframe is running": a process whose
# name contains "warframe" and lines appended to the Proton-prefix EE.log.
#
# Usage:
#   ./linux-vm-test.sh setup      one-time: create the fake Proton EE.log tree
#   ./linux-vm-test.sh game-on    start the fake Warframe process
#   ./linux-vm-test.sh game-off   stop it
#   ./linux-vm-test.sh reward     fire a reward-screen trigger (overlay should pop)
#   ./linux-vm-test.sh relic      open the relic-picker (planner overlay, top right)
#   ./linux-vm-test.sh relic-close  close the relic-picker overlay
#   ./linux-vm-test.sh whisper    fake an incoming whisper (desktop notification)
#   ./linux-vm-test.sh status     show fake-game/EE.log state
# With no argument: interactive menu.
#
# Test recipe: setup -> start the AppImage -> game-on -> play a fullscreen
# video -> reward -> does the overlay appear ABOVE the fullscreen window?
# Repeat in both a Wayland and an "Ubuntu on Xorg" login session.

set -u
EE_DIR="$HOME/.local/share/Steam/steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe"
EE_LOG="$EE_DIR/EE.log"
PID_FILE="/tmp/wfhelper-fake-game.pid"

now_stamp() { date +%s.%3N; }

append_line() {
  if [ ! -f "$EE_LOG" ]; then
    echo "EE.log missing - run: $0 setup (and restart WFHelper)"; exit 1
  fi
  echo "$(now_stamp) $1" >> "$EE_LOG"
  echo "appended: $1"
}

cmd_setup() {
  mkdir -p "$EE_DIR"
  {
    echo "0.000 Sys [Info]: Main Startup."
    echo "0.500 Sys [Info]: Current time: $(date)"
  } > "$EE_LOG"
  echo "Fake Proton EE.log created at:"
  echo "  $EE_LOG"
  echo "Start (or restart) WFHelper now so it picks the file up."
}

cmd_game_on() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "fake game already running (pid $(cat "$PID_FILE"))"; return
  fi
  # comm rename; the loop keeps bash alive (a trailing sleep would get exec'd
  # and overwrite comm with "sleep")
  bash -c 'echo -n Warframe.x64 > /proc/self/comm; while sleep 1; do :; done' &
  echo $! > "$PID_FILE"
  echo "fake Warframe.x64 process started (pid $!)"
}

cmd_game_off() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
    echo "fake game stopped"
  else
    echo "fake game not running"
  fi
}

cmd_reward() {
  append_line "Sys [Info]: Pause countdown done"
}

cmd_relic() {
  append_line "Script [Info]: activeMissionTag=VoidT3"
  append_line "Script [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd"
}

cmd_relic_close() {
  append_line "Sys [Info]: InitMapping for all devices with bindings"
}

cmd_whisper() {
  append_line "Script [Info]: ChatRedux::AddTab: Adding tab with channel name: FTestTenno to index 4"
}

cmd_status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "fake game: RUNNING (pid $(cat "$PID_FILE"))"
  else
    echo "fake game: stopped"
  fi
  if [ -f "$EE_LOG" ]; then
    echo "EE.log: $EE_LOG ($(wc -l < "$EE_LOG") lines)"
  else
    echo "EE.log: NOT SET UP - run: $0 setup"
  fi
}

menu() {
  echo "WFHelper VM test kit"
  cmd_status
  echo ""
  echo "  1) setup EE.log tree      4) reward trigger     7) whisper"
  echo "  2) fake game ON           5) relic picker open  8) status"
  echo "  3) fake game OFF          6) relic picker close q) quit"
  while true; do
    read -r -p "> " choice
    case "$choice" in
      1) cmd_setup ;;
      2) cmd_game_on ;;
      3) cmd_game_off ;;
      4) cmd_reward ;;
      5) cmd_relic ;;
      6) cmd_relic_close ;;
      7) cmd_whisper ;;
      8) cmd_status ;;
      q) exit 0 ;;
      *) echo "?" ;;
    esac
  done
}

case "${1:-}" in
  setup) cmd_setup ;;
  game-on) cmd_game_on ;;
  game-off) cmd_game_off ;;
  reward) cmd_reward ;;
  relic) cmd_relic ;;
  relic-close) cmd_relic_close ;;
  whisper) cmd_whisper ;;
  status) cmd_status ;;
  "") menu ;;
  *) echo "unknown command: $1 (run with no args for menu)"; exit 1 ;;
esac
