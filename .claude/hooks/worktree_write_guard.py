#!/usr/bin/env python3
"""
Decision logic for worktree-write-guard.sh (PreToolUse).

GOAL (Antonio, 2026-07-24): a session working in a worktree must be ISOLATED FOR
WRITES but UNRESTRICTED FOR READS — it needs a 360-degree view of the whole repo
(other branches, the main checkout, sibling worktrees) to reason correctly, and
must only ever *write* inside its own workspace.

So: WRITES into the main checkout (or a sibling worktree) are denied. READS are
NEVER denied — anywhere, by any command. Default is ALLOW; we only deny on a
high-confidence write-into-main signal.

Env in:  GUARD_SESSION_TOP, GUARD_MAIN_ROOT   (resolved by the shell wrapper)
Stdin:   the PreToolUse tool payload JSON
Stdout:  a deny JSON, or nothing (= allow)

Payload shape: parameters arrive nested under "tool_input"; some versions send
them top-level. We read BOTH (the 2026-07-24 review caught this guard reading
only the top level, which made it inert). Precedent: council-advisor.sh.
"""
import json
import os
import re
import shlex
import sys

ALLOW_OVERRIDE = re.compile(r"^\s*ALLOW_MAIN_REPO_WRITE=1(\s|$)")

# Verbs whose DESTINATION is the last argument — direction matters, because
# copying FROM main INTO the worktree is a legitimate read.
DEST_LAST = ("cp", "mv", "rsync", "install")
# Verbs that mutate every path argument they are given.
MUTATE_ANY = ("rm", "truncate", "touch", "mkdir", "rmdir", "chmod", "chown", "ln", "dd", "patch", "shred")
# git subcommands that write to the working tree / index / refs.
GIT_WRITE = (
    "checkout", "switch", "reset", "restore", "apply", "commit", "add", "merge",
    "rebase", "pull", "clean", "mv", "rm", "cherry-pick", "revert", "am", "gc",
    "prune", "worktree", "init", "clone", "push",
)
# Build/package tooling: writes into whatever directory it runs in.
BUILD_TOOLS = ("npm", "pnpm", "yarn", "npx", "next", "vite", "webpack", "tsc", "vitest", "playwright", "eslint")


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
    """Absolute, symlink- and ..-resolved. Works on non-existent paths."""
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        p = os.path.join(base, p)
    return os.path.realpath(p)


def inside(child: str, parent: str) -> bool:
    """Is `child` at or under `parent`? Case-insensitive: macOS volumes are
    case-insensitive by default, so a case-variant path reaches the same file
    and must not slip past (bug-hunter finding, 2026-07-24)."""
    c, p = child.casefold(), parent.casefold()
    return c == p or c.startswith(p.rstrip(os.sep) + os.sep)


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

    def pick(*keys: str) -> str:
        for k in keys:
            for src in (tool_input, payload):
                v = src.get(k)
                if isinstance(v, str) and v:
                    return v
        return ""

    file_path = pick("file_path", "notebook_path")
    command = pick("command")

    worktrees_base = os.path.join(MR, ".claude", "worktrees")

    # ── File writes (Edit / Write / NotebookEdit): exact, after normalization ──
    if file_path:
        target = resolve(file_path, ST)
        if inside(target, ST):
            allow()                      # inside this worktree → fine
        if not inside(target, MR):
            allow()                      # outside the repo entirely → not ours
        if inside(target, worktrees_base):
            deny(
                "BLOCKED — that path is a DIFFERENT worktree, not this session's.\n\n"
                f"  target        : {target}\n"
                f"  this worktree : {ST}\n\n"
                "Another session may be working there; writing into it corrupts their state. "
                "Write inside this session's worktree instead.\n\n"
                "Reads are never blocked — inspect any checkout freely.\n\n"
                "Deliberate exception: ALLOW_MAIN_REPO_WRITE=1."
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
            "worktrees freely for full context. Only writes are confined.\n\n"
            "Also: in Bash, 'cd' does NOT persist between calls — set W once and use \"$W\". "
            "Commit to the worktree branch early; the auto-stash cannot touch committed work.\n\n"
            "Deliberate exception (e.g. recovering a stash into the main repo): prefix "
            "ALLOW_MAIN_REPO_WRITE=1."
        )

    # ── Bash: deny only a clear write INTO main. Reads always pass. ──────────
    if not command:
        allow()
    if ALLOW_OVERRIDE.match(command):
        allow()

    try:
        tokens = shlex.split(command, comments=False)
    except ValueError:
        tokens = command.split()

    def hits_main(tok: str) -> bool:
        """Does this token point at the main checkout (outside this worktree)?"""
        if not tok or tok.startswith("-"):
            return False
        looks_pathish = ("/" in tok) or tok in (".", "..")
        if not looks_pathish:
            return False
        try:
            r = resolve(tok, ST)
        except Exception:
            return False
        return inside(r, MR) and not inside(r, ST)

    # 1) Redirection target inside main  (>, >>).  /dev/null and worktree paths are fine.
    for m in re.finditer(r"(?<![0-9<>])>>?\s*([^\s;&|)]+)", command):
        if hits_main(m.group(1)):
            deny(_bash_reason(ST, MR, "it redirects output into the main checkout"))

    # 2) Destination-is-last verbs: cp/mv/rsync/install — only the DEST matters,
    #    so copying FROM main INTO the worktree stays allowed (that is a read).
    # 3) Mutate-any verbs: rm/touch/sed -i/... — any main-repo argument is a write.
    # 4) git write subcommands aimed at main (via -C or a cd).
    # 5) Build tooling running with main as its working directory.
    cd_into_main = False
    for i, tok in enumerate(tokens):
        base = os.path.basename(tok)

        if base == "cd" and i + 1 < len(tokens) and hits_main(tokens[i + 1]):
            cd_into_main = True

        if base in DEST_LAST:
            args = [t for t in tokens[i + 1:] if not t.startswith("-")]
            # stop at a shell separator if shlex kept them
            for sep in (";", "&&", "||", "|"):
                if sep in args:
                    args = args[: args.index(sep)]
            if args and hits_main(args[-1]):
                deny(_bash_reason(ST, MR, f"'{base}' writes its destination into the main checkout"))

        if base in MUTATE_ANY and any(hits_main(t) for t in tokens[i + 1:]):
            deny(_bash_reason(ST, MR, f"'{base}' modifies a path in the main checkout"))

        if base == "sed" and "-i" in tokens[i + 1: i + 4] and any(hits_main(t) for t in tokens[i + 1:]):
            deny(_bash_reason(ST, MR, "'sed -i' edits a file in the main checkout in place"))

        if base == "git":
            rest = tokens[i + 1:]
            dash_c_main = any(
                rest[j] == "-C" and j + 1 < len(rest) and hits_main(rest[j + 1])
                for j in range(len(rest))
            )
            # First non-flag token, skipping the value that belongs to -C.
            sub = ""
            skip_next = False
            for t in rest:
                if skip_next:
                    skip_next = False
                    continue
                if t == "-C":
                    skip_next = True
                    continue
                if t.startswith("-"):
                    continue
                sub = t
                break
            if sub in GIT_WRITE and (dash_c_main or cd_into_main):
                deny(_bash_reason(ST, MR, f"'git {sub}' writes to the main checkout"))

        if base in BUILD_TOOLS and cd_into_main:
            deny(_bash_reason(
                ST, MR,
                f"'{base}' would run with the main checkout as its working directory and write build output there"
            ))

    allow()


def _bash_reason(st: str, mr: str, what: str) -> str:
    return (
        f"BLOCKED — wrong checkout: {what}.\n\n"
        f"  this worktree : {st}\n"
        f"  main repo     : {mr}\n\n"
        "The main repo is usually on an UNRELATED branch and its auto-pull auto-stashes "
        "uncommitted work, which silently loses changes (2026-07-24 incident).\n\n"
        "READS ARE NEVER BLOCKED — inspect the main checkout, other branches and sibling "
        "worktrees freely (cat / ls / grep / git log / git show / git diff / git stash list all pass). "
        "Only writes are confined to this worktree.\n\n"
        "Point the write at the worktree instead:\n"
        f"  W={st}\n"
        "  cd \"$W\"      # or: git -C \"$W\" ...\n\n"
        "Note 'cd' does not persist between Bash calls.\n\n"
        "Deliberate exception (e.g. recovering a stash, or repairing the other checkout): "
        "START the command with ALLOW_MAIN_REPO_WRITE=1."
    )


if __name__ == "__main__":
    main()
