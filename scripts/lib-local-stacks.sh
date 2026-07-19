#!/usr/bin/env bash
# lib-local-stacks.sh — shared helpers for reclaiming isolated local DB stacks.
# Sourced by worktree-stack-sweep.sh and env-down.sh. Not executable on its own.
#
# WHY THIS EXISTS (incident 2026-07-18)
# Three stacks were found running with ~1 GB of RAM each, belonging to worktrees
# that no longer existed, and NOTHING could reclaim them. The chain:
#
#   1. A purge ran `supabase stop` with its failure swallowed (`|| true`, output
#      to /dev/null), then deleted the stack directory unconditionally.
#   2. When that stop did not actually stop anything — Docker/Colima down, or a
#      config already gutted by a previous half-purge — the containers survived
#      and their config was deleted out from under them.
#   3. A container with no config is UNMANAGEABLE: `supabase stop` in an empty
#      directory exits 0 and does nothing, so every later attempt "succeeds"
#      while the containers keep running. Their restart policy is
#      `unless-stopped`, so they also came back after every reboot.
#   4. The sweep could not see them either, because it identifies orphans by the
#      `.worktree-path` marker — which the same deletion had removed.
#
# So the deletion destroyed the only two things that could have reclaimed the
# memory. The fixes below are therefore: NEVER delete the directory until the
# containers are confirmed gone, and be able to find an orphan without the marker.

STACKS_ROOT="${STACKS_ROOT:-$HOME/.td-local-stacks}"

# The stack name for a worktree. THE single source of truth — env-up, env-down
# and the sweep must all agree, or a session provisions one stack and tears down
# a different one.
#
# Normally the branch, slashes → dashes. That is unique BY CONSTRUCTION: git
# refuses to check the same branch out in two worktrees ("is already used by
# worktree at …"), so two live worktrees can never derive the same name.
#
# EXCEPT when detached. A worktree parked on a bare commit reports its branch as
# the literal string "HEAD" — a placeholder, not a name — so EVERY detached
# worktree would derive the same stack and they would silently share one
# database: each other's writes, and a teardown by the first destroying the
# second's data mid-session. (Not hypothetical: a stack literally named "HEAD"
# was found running on this machine, 2026-07-18.)
#
# So for the detached case only, fall back to the worktree's folder name, which
# is unique per worktree. Deliberately narrow: every already-provisioned stack
# keeps the name it has, because the branch path is untouched.
stack_name_for_worktree() {
  local wt="${1:-$PWD}" branch
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')"
  if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
    basename "$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo "$wt")"
  else
    printf '%s' "$branch"
  fi
}

# Compose project name for a stack. env-up sets `project_id = "tdlocal-<name>"`,
# which Docker records as the compose project label on every container.
stack_project() { printf 'tdlocal-%s' "$1"; }

# Docker TRUNCATES the compose project label (observed cap: 40 chars). A stack
# named claude-2023-return-reader-limit-3da3a1 wants a 46-char project and gets
# a 40-char label. So `--filter label=...=<full>` matches NOTHING for any long
# name — silently. That is not hypothetical: it is why an earlier attempt to
# stop these containers reported success while stopping nothing at all.
#
# So match by PREFIX instead of equality, and never hardcode the cap as the
# rule. The length floor below only exists to make a false prefix match
# impossible (a short label that happens to prefix a longer stack's name):
# a label shorter than the cap was not truncated, so it must match exactly.
STACK_LABEL_TRUNCATION_FLOOR="${STACK_LABEL_TRUNCATION_FLOOR:-40}"

# True when a compose project LABEL belongs to the stack called <name>, allowing
# for Docker having truncated it. Use this anywhere a label is compared to a
# stack name — comparing them raw is how a live stack gets mistaken for an
# orphan (a truncated label does not equal, and is not a valid path component).
label_matches_stack() {
  local label="$1" full="tdlocal-$2"
  [ "$label" = "$full" ] && return 0
  case "$full" in
    "$label"*) [ "${#label}" -ge "$STACK_LABEL_TRUNCATION_FLOOR" ] && return 0 ;;
  esac
  return 1
}

# Container ids belonging to a stack. $2 = "running" to limit to live ones.
stack_container_ids() {
  local name="$1" scope="${2:-all}" psargs="-a"
  [ "$scope" = "running" ] && psargs=""
  # shellcheck disable=SC2086
  docker ps $psargs --format '{{.ID}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null |
    awk -F'|' -v full="$(stack_project "$name")" -v floor="$STACK_LABEL_TRUNCATION_FLOOR" '
      $2 == "" { next }
      $2 == full { print $1; next }                       # exact
      index(full, $2) == 1 && length($2) >= floor { print $1 }  # truncated
    '
}

# Number of RUNNING containers for a stack. 0 when Docker is unreachable — the
# caller must treat "cannot tell" as "not confirmed stopped", never as "gone".
stack_running_count() {
  stack_container_ids "$1" running | grep -c . || true
}

# True when Docker is reachable at all.
docker_up() { docker info >/dev/null 2>&1; }

# Stop and remove a stack's containers, then VERIFY. Returns 0 only when nothing
# is left running. Tries the clean path first, then falls back to Docker directly
# — which is the only thing that works once a config has been lost.
stack_force_stop() {
  local name="$1" dir="${2:-}" proj
  proj="$(stack_project "$name")"

  if ! docker_up; then
    echo "[stacks] Docker is not reachable — cannot stop '$name'" >&2
    return 1
  fi

  # 1) Clean path: only meaningful when a real config still exists. An empty
  #    directory makes `supabase stop` a silent no-op that reports success.
  if [ -n "$dir" ] && [ -f "$dir/supabase/config.toml" ]; then
    ( cd "$dir" && supabase stop --no-backup >/dev/null 2>&1 ) || true
  fi

  # 2) Fallback: address the containers by their compose label. This works with
  #    no config at all, which is exactly the case the clean path cannot handle.
  local ids id
  ids="$(stack_container_ids "$name" all)"
  if [ -n "$ids" ]; then
    # One at a time: a batched stop/rm aborts partway on a single bad id, which
    # is how a "successful" teardown silently leaves half a stack running.
    for id in $ids; do docker stop "$id" >/dev/null 2>&1 || true; done
    for id in $ids; do docker rm -v "$id" >/dev/null 2>&1 || true; done
  fi

  # 3) Named volumes survive `docker rm`; without this the disk is never freed.
  #    Same truncation caveat as the container labels, so match by prefix too.
  local vols v
  vols="$(docker volume ls --format '{{.Name}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null |
    awk -F'|' -v full="$proj" -v floor="$STACK_LABEL_TRUNCATION_FLOOR" '
      $2 == "" { next }
      $2 == full { print $1; next }
      index(full, $2) == 1 && length($2) >= floor { print $1 }')"
  for v in $vols; do docker volume rm "$v" >/dev/null 2>&1 || true; done

  # 4) VERIFY. This is the whole point — the old code assumed success.
  if [ "$(stack_running_count "$name")" -gt 0 ]; then
    echo "[stacks] '$name' still has running containers after teardown" >&2
    return 1
  fi
  return 0
}

# Delete a stack directory, but ONLY after its containers are confirmed gone.
# Keeping a directory whose containers survive is strictly better than a tidy
# folder and a gigabyte nobody can reclaim.
stack_remove_dir_if_stopped() {
  local name="$1" dir="$2"
  if [ "$(stack_running_count "$name")" -gt 0 ]; then
    echo "[stacks] KEEPING '$dir' — containers are still running, so its config" >&2
    echo "         must survive or the stack becomes unreclaimable. Retry later." >&2
    return 1
  fi
  case "$dir" in
    "$STACKS_ROOT"/?*) rm -rf "$dir" ;;   # guard: only a named child, never the root
    *) echo "[stacks] refusing to delete unexpected path '$dir'" >&2; return 1 ;;
  esac
  return 0
}

# Stack names that map to a worktree that still EXISTS, one per line.
#
# Mirrors stack_name_for_worktree exactly: branch with slashes → dashes, and the
# worktree's FOLDER name when detached. These two must never disagree — if they
# do, the sweep stops recognising a live stack and reclaims it out from under a
# running session.
#
# Also emits the legacy "HEAD" name for any detached worktree, so a stack
# provisioned under the old scheme is still recognised as live and protected
# until it is torn down normally.
#
# Empty output means "could not tell" (not a git repo, git missing) — callers
# MUST treat that as "prove nothing" and fall back to marker-only behaviour.
live_stack_names() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git worktree list --porcelain 2>/dev/null | awk '
    /^worktree /   { wt = substr($0, 10) }
    /^branch /     { b = substr($0, 8); sub(/^refs\/heads\//, "", b); gsub(/\//, "-", b); print b }
    /^detached/    { n = split(wt, p, "/"); print p[n]; print "HEAD" }
  ' | sort -u
}
