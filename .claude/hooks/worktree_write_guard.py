#!/usr/bin/env python3
"""
Decision logic for worktree-write-guard.sh (PreToolUse, Edit|Write only).

GOAL (Antonio, 2026-07-24): a session working in a worktree must be ISOLATED FOR
WRITES but UNRESTRICTED FOR READS — it needs a 360-degree view of the whole repo
(the main checkout, other branches, sibling worktrees) to diagnose correctly, and
must only ever *write* inside its own workspace.

SCOPE — FILE WRITES ONLY. This guard inspects the target path of Edit/Write/
NotebookEdit. It does NOT inspect shell commands, deliberately:

    A previous version tried to classify Bash commands as read-or-write. Two
    review rounds and a direct test proved that unwinnable — it missed all six
    realistic writes into main (relative write after a `cd`, path held in a
    shell variable, quoted redirect target, `tee`, `git stash pop`, a copy with
    a trailing `2>/dev/null`) while blocking three legitimate reads (grepping
    main for a word that happens to be a command name, symlinking main's
    node_modules, reading main then working in the worktree). Worse, its own
    error text recommended exactly the two idioms it could not see (shell
    variables and quoted paths), so the advice generated the bypass.
    Predicting shell semantics is the wrong tool. Commands are now covered by
    OBSERVATION instead: main-repo-change-detector.sh (PostToolUse) reports when
    the main checkout actually changed. See docs/systems/hooks-guardrails.md.

Because nothing here reads a command, READS CAN NEVER BE BLOCKED. That is a
structural guarantee, not a heuristic.

Env in:  GUARD_SESSION_TOP, GUARD_MAIN_ROOT  (resolved by the shell wrapper)
Stdin:   the PreToolUse tool payload JSON
Stdout:  a deny JSON, or nothing (= allow)

Payload shape: parameters arrive nested under "tool_input"; some versions send
them top-level. Both are read — the first version read only the top level, which
made the guard silently inert. Precedent: council-advisor.sh.
"""
import json
import os
import sys


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, separators=(",", ":")))
    sys.exit(0)


def allow() -> None:
    sys.exit(0)


def resolve(path: str, base: str) -> str:
    """Absolute, ~-expanded, symlink- and ..-resolved. Works on paths that do
    not exist yet (which is the normal case for a new file)."""
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(base, p)
    return os.path.realpath(p)


def inside(child: str, parent: str) -> bool:
    """Is `child` at or under `parent`? Case-insensitive, because macOS volumes
    are case-insensitive by default: a case-variant path reaches the same file
    and must not slip past. The trailing-separator check keeps a sibling like
    `<root>-sandbox` from matching `<root>`."""
    c, p = child.casefold(), parent.casefold().rstrip(os.sep)
    return c == p or c.startswith(p + os.sep)


def main() -> None:
    session_top = os.environ.get("GUARD_SESSION_TOP", "")
    main_root = os.environ.get("GUARD_MAIN_ROOT", "")
    if not session_top or not main_root:
        allow()

    ST = os.path.realpath(session_top)
    MR = os.path.realpath(main_root)
    # Not a worktree session (the common case) → this guard has no opinion.
    if ST == MR:
        allow()

    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        allow()
    if not isinstance(payload, dict):
        allow()

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    file_path = ""
    for key in ("file_path", "notebook_path"):
        for src in (tool_input, payload):
            v = src.get(key)
            if isinstance(v, str) and v:
                file_path = v
                break
        if file_path:
            break
    if not file_path:
        allow()

    try:
        target = resolve(file_path, ST)
    except Exception:
        allow()

    if inside(target, ST):
        allow()                       # inside this worktree → fine
    if not inside(target, MR):
        allow()                       # outside the repo entirely → not ours

    if inside(target, os.path.join(MR, ".claude", "worktrees")):
        deny(
            "BLOCKED — that path is a DIFFERENT worktree, not this session's.\n\n"
            f"  target        : {target}\n"
            f"  this worktree : {ST}\n\n"
            "Another session may be working there; writing into it corrupts their state. "
            "Write inside this session's worktree instead.\n\n"
            "READS ARE NEVER BLOCKED — this guard only ever inspects the target of a file "
            "write, never a command, so you can read any checkout freely.\n\n"
            "Deliberate exception: set ALLOW_MAIN_REPO_WRITE=1 in the environment."
        )

    rel = os.path.relpath(target, MR)
    deny(
        "BLOCKED — wrong checkout. This session runs in a WORKTREE, but that path writes "
        "into the MAIN repo:\n\n"
        f"  target        : {target}\n"
        f"  this worktree : {ST}\n"
        f"  main repo     : {MR}\n\n"
        "The main repo is usually parked on an UNRELATED branch, and the repo's 5-minute "
        "auto-pull auto-stashes uncommitted work — writing there silently loses your changes "
        "and puts them on the wrong branch (2026-07-24 incident).\n\n"
        "Write here instead:\n"
        f"  {os.path.join(ST, rel)}\n\n"
        "READS ARE NEVER BLOCKED — read the main checkout, other branches and sibling "
        "worktrees freely for full context. Only file writes are confined.\n\n"
        "Commit to the worktree branch early; the auto-stash cannot touch committed work.\n\n"
        "Deliberate exception (e.g. recovering a stash into the main repo): set "
        "ALLOW_MAIN_REPO_WRITE=1 in the environment."
    )


if __name__ == "__main__":
    main()
