#!/bin/bash
# Always-on CRM → phone reaction sender (dev job 5962e46d, Release 2). Its OWN job — never inside send-loop.sh / agent-loop.sh / reactions-loop.sh.
# Register as launchd com.td.wa-bridge-react with KeepAlive, the same way as the send and reactions jobs. It does NOTHING until the CRM's
# reactions switch is on (the CRM answers "paused" and this just waits 20 s between looks).
#
# One round, then wait as long as the round said (wait=<seconds> on its last line; 2-60 s). A lock DIRECTORY plus a command-name check keeps
# a single copy running, and a stale lock (reboot, reused pid) cannot wedge it.
cd "$HOME/wa-bridge" || exit 1
LOCK="$HOME/wa-bridge/storages/react-loop.lock"
NODE=/Users/10225office/.nvm/versions/node/v20.20.1/bin/node
mkdir -p logs
if ! mkdir "$LOCK" 2>/dev/null; then
  old="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$old" ] && ps -p "$old" -o command= 2>/dev/null | grep -q "react-loop"; then
    echo "$(date '+%F %T') react-loop: another copy is already running (pid $old) — exiting"; exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1   # stale lock
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
while true; do
  out="$("$NODE" "$HOME/wa-bridge/react.mjs" --once 2>&1)"
  # keep the log to lines that mean something (the "wait=" line is control output, not a log line)
  printf '%s\n' "$out" | grep -v '^wait=' >> logs/react.log
  wait="$(printf '%s\n' "$out" | sed -n 's/^wait=\([0-9][0-9]*\)$/\1/p' | tail -1)"
  case "$wait" in ''|*[!0-9]*) wait=15 ;; esac
  [ "$wait" -lt 2 ] && wait=2
  [ "$wait" -gt 60 ] && wait=60
  sleep "$wait"
done
