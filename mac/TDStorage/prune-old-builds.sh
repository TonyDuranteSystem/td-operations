#!/bin/zsh
# Removes the OLD built copies of the TD Storage app from this Mac when a newer build exists (dev job 1992a087, 2026-11-23: the old copies in the builds
# folder were still registered with macOS, which started them next to the real app). Run at the end of every build (build.sh calls it).
#
# Keeps the NEWEST build folder as it is. For every older TDStorage-production-<version> folder: tells macOS to forget each app copy in it
# (Launch Services), then moves the app copies and archives into the Trash (nothing is erased — the Trash can be put back). The small files
# (build.sh, log, notes) stay. Usage: prune-old-builds.sh [builds-folder] [--dry-run]
set -u
root="$HOME/Developer/td-operations-builds"; dry=0
for a in "$@"; do case "$a" in --dry-run) dry=1 ;; *) root="$a" ;; esac; done
LS=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
folders=("${(@f)$(ls -1d "$root"/TDStorage-production-[0-9]* 2>/dev/null | sort -V)}")
[[ -z "${folders[1]:-}" ]] && { echo "no build folders in $root"; exit 0; }
newest="${folders[-1]}"
echo "keeping: ${newest:t}"
trash="$HOME/.Trash"; stamp=$(date +%Y%m%d-%H%M%S); moved=0
for f in "${folders[@]}"; do
  [[ "$f" == "$newest" ]] && continue
  for item in "$f/export/TDStorage.app" "$f/TDStorage.app" "$f/a.xcarchive" "$f/export"; do
    [[ -e "$item" ]] || continue
    if (( dry )); then echo "would remove: ${item#$root/}"; continue; fi
    # forget every app copy inside it, then move the whole thing to the Trash
    find "$item" -name "TDStorage.app" -maxdepth 4 -prune 2>/dev/null | while read -r app; do "$LS" -u "$app" 2>/dev/null; done
    [[ "$item" == *.app ]] && "$LS" -u "$item" 2>/dev/null
    dest="$trash/${f:t}-${item:t}-$stamp"
    mv "$item" "$dest" 2>/dev/null && { echo "removed: ${item#$root/}"; moved=$((moved+1)); }
  done
done
echo "done ($moved moved to the Trash)"
