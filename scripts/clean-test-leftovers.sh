#!/usr/bin/env bash
# Clear what interrupted test runs leave on THIS machine, and nothing else.
#
#   bash scripts/clean-test-leftovers.sh           clear
#   bash scripts/clean-test-leftovers.sh --dry-run say what would go
#
# Interrupted gates and probes leave tmux servers on their own sockets, dead
# socket files, isolated hub homes under /tmp/athe2e-*, and the ssh masters
# those homes started. Clearing them by hand meant ad-hoc loops typed beside
# a remote host's name, which a production guard reads as a production change
# (it happened four times in one session). This touches only local test
# leftovers, names no host, and stands down while a gate is running.
#
# What counts as a test leftover, and why it cannot be yours:
# - a tmux socket named `ath` + letters + a process number (`athwb12345`):
#   every test tool names its socket that way; the hub's own is `ath`, and an
#   ATH_SOCKET you chose yourself would have to copy that exact shape;
# - an isolated hub home /tmp/athe2e-*, only once no tmux server and no
#   process is using it, and it is over an hour old.
set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

lock="${TMPDIR:-/tmp}/ath-verify.lock"
if [ -d "$lock" ] && kill -0 "$(cat "$lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; then
  echo "clean-test-leftovers: a verify run is in progress (pid $(cat "$lock/pid")); nothing touched."
  exit 0
fi

act() { if [ "$DRY" = "1" ]; then echo "  would: $*"; else "$@"; fi; }

servers=0; sockets=0; homes=0; masters=0
dir="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
[ -d "$dir" ] || dir="/private/tmp/tmux-$(id -u)"
if [ -d "$dir" ]; then
  for path in "$dir"/ath*; do
    [ -S "$path" ] || continue
    name=$(basename "$path")
    [[ "$name" =~ ^ath[a-z]+[0-9]+$ ]] || continue
    if tmux -L "$name" list-sessions >/dev/null 2>&1; then
      act tmux -L "$name" kill-server; servers=$((servers + 1))
    fi
    act rm -f "$path"; sockets=$((sockets + 1))
  done
fi

for home in /tmp/athe2e-*; do
  [ -d "$home" ] || continue
  # Over an hour old, so no probe still running owns it.
  [ -n "$(find "$home" -maxdepth 0 -mmin +60 2>/dev/null)" ] || continue
  if pgrep -f -- "$home/" >/dev/null 2>&1; then
    # ssh masters an interrupted run never closed: theirs, by control path.
    if [ "$DRY" = "1" ]; then echo "  would: end ssh masters under $home"; else pkill -f -- "$home/" 2>/dev/null; fi
    masters=$((masters + 1))
  fi
  act rm -rf "$home"; homes=$((homes + 1))
done

verb=$([ "$DRY" = "1" ] && echo "would clear" || echo "cleared")
echo "clean-test-leftovers: $verb $servers tmux server(s), $sockets socket(s), $homes hub home(s), ssh masters in $masters of them."
