#!/bin/bash
# Always-on phone → CRM reactions reader (dev job 5962e46d, Release 1). Its OWN job — never inside agent-loop.sh: a slow or
# locked read must not delay the health report (the CRM would raise a false "offline" alert), and launchd StartInterval jobs
# were measured never firing on this Mac (agent-loop.sh header). Register as launchd com.td.wa-bridge-reactions with KeepAlive,
# the same way as the send and media jobs.
#
# One scan a minute. If another copy is already running this exits (a lock DIRECTORY plus a command-name check, so a stale
# lock left by a reboot — with the number reused by some other program — cannot wedge the job forever).
cd "$HOME/wa-bridge" || exit 1
LOCK="$HOME/wa-bridge/storages/reactions-loop.lock"
NODE=/Users/10225office/.nvm/versions/node/v20.20.1/bin/node
mkdir -p logs
if ! mkdir "$LOCK" 2>/dev/null; then
  old="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$old" ] && ps -p "$old" -o command= 2>/dev/null | grep -q "reactions-loop"; then
    echo "$(date '+%F %T') reactions-loop: another copy is already running (pid $old) — exiting"; exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1   # stale lock
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
while true; do
  "$NODE" "$HOME/wa-bridge/reactions.mjs" --once >> logs/reactions.log 2>&1
  sleep 60
done
