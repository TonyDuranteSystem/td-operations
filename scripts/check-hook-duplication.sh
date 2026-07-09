#!/usr/bin/env bash
#
# check-hook-duplication.sh — one-shot diagnostic for Claude Code hook duplication.
#
# WHY THIS EXISTS (2026-07-09):
#   The Claude Code "OPERATING CONTRACT" UserPromptSubmit hook was found registered
#   a SECOND time in the machine-local global config (~/.claude/settings.json), which
#   lives OUTSIDE the repo — so git never fixed it and the contract text was injected
#   TWICE per prompt (pure wasted tokens). See dev_task 21406181.
#
#   Claude Code merges hooks from FOUR layers and runs EVERY one — it does NOT
#   de-duplicate identical commands. So the same hook present in two layers fires twice.
#   This script checks all four layers and flags any hook registered more than once
#   for the same event. It is READ-ONLY: it changes nothing, only reports.
#
# USAGE:
#   Run from the repo root:  bash scripts/check-hook-duplication.sh
#   Exit 0 = clean (every hook fires once). Exit 1 = duplicate(s) found.
#
# The four layers scanned (all merge at runtime, in this precedence):
#   1. ~/.claude/settings.json          (user global — where yesterday's dup lived)
#   2. ~/.claude/settings.local.json    (user global, local overrides)
#   3. ./.claude/settings.json          (project — the correct single source, tracked in git)
#   4. ./.claude/settings.local.json    (project, local overrides — untracked)

set -uo pipefail

echo "================ Claude Code hook duplication check ================"
echo "Machine : $(scutil --get ComputerName 2>/dev/null || hostname)"
echo "Repo    : $(pwd)"
echo

python3 - "$HOME/.claude/settings.json" \
          "$HOME/.claude/settings.local.json" \
          ".claude/settings.json" \
          ".claude/settings.local.json" <<'PY'
import json, os, sys

files = sys.argv[1:]

# label each source file for readable output
def label(path):
    home = os.path.expanduser("~")
    if path.startswith(home):
        return "~" + path[len(home):]
    return path

# registry[(event, identifier)] = { "label": human_label, "sources": [file, ...] }
registry = {}

def hook_identifier(hook):
    """Stable identity for a single hook entry, plus a short human label."""
    htype = hook.get("type", "command")
    if htype == "command":
        cmd = (hook.get("command") or "").strip()
        # normalise a leading "bash " so 'bash x.sh' and 'x.sh' collapse to the same hook
        norm = cmd
        if norm.startswith("bash "):
            norm = norm[5:].strip()
        return ("cmd:" + norm, cmd or "(empty command)")
    if htype == "prompt":
        text = (hook.get("prompt") or "").strip()
        snippet = " ".join(text.split())[:60]
        return ("prompt:" + snippet, f'[prompt] "{snippet}..."')
    return ("other:" + json.dumps(hook, sort_keys=True), f"[{htype}]")

any_file = False
for path in files:
    if not os.path.isfile(path):
        continue
    any_file = True
    try:
        with open(path) as fh:
            data = json.load(fh)
    except Exception as e:
        print(f"⚠️  Could not parse {label(path)}: {e}")
        continue
    hooks = data.get("hooks", {})
    if not isinstance(hooks, dict):
        continue
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for group in groups:
            for hook in (group.get("hooks") or []):
                ident, human = hook_identifier(hook)
                key = (event, ident)
                entry = registry.setdefault(key, {"label": human, "sources": []})
                entry["sources"].append(label(path))

if not any_file:
    print("No Claude settings files found — nothing to check.")
    sys.exit(0)

# ---- report -------------------------------------------------------------
events = sorted({event for (event, _ident) in registry})
duplicates = []

for event in events:
    print(f"── {event} ──")
    rows = sorted(
        [(k, v) for k, v in registry.items() if k[0] == event],
        key=lambda kv: kv[1]["label"].lower(),
    )
    for (ev, _ident), info in rows:
        n = len(info["sources"])
        mark = "✅" if n == 1 else "🔴 DUPLICATE"
        src = ", ".join(info["sources"])
        fires = "fires once" if n == 1 else f"fires {n}× (registered in {n} layers)"
        print(f"   {mark}  {info['label']}")
        print(f"        {fires} — from: {src}")
        if n > 1:
            duplicates.append((event, info["label"], info["sources"]))
    print()

print("=================================== RESULT ===================================")
if not duplicates:
    print("✅ CLEAN — every hook is registered exactly once. No wasted double-firing.")
    sys.exit(0)

print(f"🔴 {len(duplicates)} DUPLICATE HOOK(S) — each fires more than once per trigger (wasted tokens):")
for event, human, sources in duplicates:
    print(f"   • [{event}] {human}")
    print(f"       remove the extra registration; it appears in: {', '.join(sources)}")
print()
print("FIX: keep the copy in ./.claude/settings.json (the tracked single source).")
print("     Remove the duplicate from whichever OTHER layer it appears in")
print("     (usually ~/.claude/settings.json). Re-run this script — it must print CLEAN.")
sys.exit(1)
PY
