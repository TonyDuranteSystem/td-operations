#!/bin/sh
# counselor-readonly-guard.sh — the System Counselor's write brake.
#
# WHY THIS EXISTS
# The System Counselor is deliberately granted EVERYTHING the session can reach:
# every MCP tool on every connected server, plus the built-ins. Antonio's rule is
# that nobody gets to curate what it may SEE — it must hold the 360-degree view of
# the business and the system. The only thing it may never do is CHANGE anything.
#
# A deny-list cannot deliver that safely. The docs are explicit that a server-level
# grant is evaluated at runtime, so a NEW tool added to an MCP server later is
# automatically handed to the agent. Any hand-written list of "the mutating tools"
# is therefore wrong the moment someone ships tool number 220. This guard inverts it:
#
#   FAIL CLOSED. A tool call is allowed only if it is RECOGNISABLY A READ.
#   Anything unrecognised is DENIED.
#
# That is a judgement about the VERB, never about the subject matter. Every client,
# every payment, every document, every mailbox, every line of code stays readable.
# A brand-new tool called `foo_frobnicate` is refused until someone classifies it —
# a false deny costs one message; a false allow is a reviewer writing to production.
#
# Registered as a PreToolUse hook in the system-counselor agent's own frontmatter,
# so it applies to that agent ONLY and cannot slow down or block anyone else.
#
# Protocol: stdin = tool-call JSON. Deny by emitting a permissionDecision of "deny".
# Fail-open ONLY on a parse failure (a broken guard must not brick the reviewer) —
# every other path fails closed.
#
# Kill switch: COUNSELOR_GUARD_OFF=1 (for debugging only — it disarms the brake).

[ "${COUNSELOR_GUARD_OFF:-}" = "1" ] && exit 0

INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0

python3 - "$INPUT" <<'PY' 2>/dev/null || exit 0
import json, re, sys

try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)                      # unparsable → fail open, never brick the agent

name = d.get("tool_name") or d.get("name") or ""
ti   = d.get("tool_input") or d.get("input") or {}
if not isinstance(ti, dict):
    ti = {}

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)

def allow():
    sys.exit(0)

# ── 1. Built-ins: reading and searching are fine; anything that produces or
#       executes is not. Bash is handled separately below.
BUILTIN_READ = {
    "Read", "Grep", "Glob", "NotebookRead", "WebFetch", "WebSearch",
    "ToolSearch", "TodoWrite", "Skill", "Monitor", "TaskGet", "TaskList",
    "TaskOutput", "mcp__ccd_session__read_widget_context",
}
BUILTIN_BLOCK = {
    "Write", "Edit", "NotebookEdit", "Artifact", "SendUserFile",
    "Agent", "Task", "TaskCreate", "TaskUpdate", "TaskStop",
    "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete",
    "RemoteTrigger", "SendMessage", "PushNotification", "Workflow",
    "ScheduleWakeup", "DesignSync", "ExitPlanMode", "EnterPlanMode",
}

if name in BUILTIN_BLOCK:
    deny(f"System Counselor is READ-ONLY: `{name}` can create, change, or dispatch "
         f"work. Report the finding instead; the coordinator acts on it.")

if name in BUILTIN_READ:
    allow()

# ── 2. Bash: allow genuinely read-only inspection (git history, file listing,
#       counting) and refuse the rest. This is what lets it see "everything that
#       happened" — git log, diffs, blame — without being able to touch anything.
if name in ("Bash", "PowerShell"):
    cmd = (ti.get("command") or "").strip()
    if not cmd:
        deny("System Counselor: empty shell command refused.")
    # Any redirection, pipe-to-writer, chaining into a mutator, or substitution
    # that could hide a write → refuse outright rather than try to parse it.
    if re.search(r'(^|[^2])>|>>|\|\s*(tee|xargs|sh|bash|zsh|python|node)\b|`|\$\(', cmd):
        deny("System Counselor: shell redirection, command substitution, or piping "
             "into an interpreter is refused — it can hide a write. Use a read tool.")
    READ_CMD = re.compile(
        r'^\s*(git\s+(log|show|diff|status|blame|branch|tag|describe|rev-parse|'
        r'rev-list|shortlog|ls-files|cat-file|remote|config\s+--get|worktree\s+list)'
        r'|ls|cat|head|tail|wc|find|grep|rg|sed\s+-n|awk|sort|uniq|cut|tr|jq|column|'
        r'stat|file|du|df|date|pwd|which|echo|basename|dirname|realpath|diff|tree)\b'
    )
    # A compound command is only as safe as its worst segment.
    segments = [s for s in re.split(r'&&|\|\||;|\|', cmd) if s.strip()]
    for seg in segments:
        if not READ_CMD.match(seg):
            deny(f"System Counselor is READ-ONLY: the shell segment `{seg.strip()[:80]}` "
                 f"is not a recognised read command. Allowed: git history/inspection and "
                 f"read-only file utilities. If you need a real read that is blocked here, "
                 f"say so in your report and the coordinator will run it.")
    allow()

# ── 3. MCP tools. Everything the servers expose is reachable; only reads pass.
if name.startswith("mcp__"):
    short = name.split("__")[-1]

    # 3a. SQL is the one tool whose safety depends on an ARGUMENT, not its name.
    if short == "execute_sql":
        mode = (ti.get("mode") or "read").lower()
        if mode != "read":
            deny("System Counselor is READ-ONLY: execute_sql must run with mode='read'. "
                 "A write or DDL is never the Counselor's to make — report it instead.")
        q = (ti.get("query") or "").upper()
        if re.search(r'\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|'
                     r'COMMENT\s+ON|REFRESH\s+MATERIALIZED|CALL|DO)\b', q):
            deny("System Counselor is READ-ONLY: that SQL contains a mutating statement. "
                 "SELECT only.")
        allow()

    # 3b. Recognised read verbs — the naming convention this codebase actually uses.
    #     Matched on a word boundary so `catalog_list` is a read while `catalog_add`
    #     is not, and `crm_update_record` can never be mistaken for one.
    READ_TOKENS = (
        "get", "list", "search", "read", "find", "query", "stats", "status",
        "inbox", "tracker", "pipeline", "summary", "upcoming", "availability",
        "heartbeat", "pending", "labels", "report", "check", "audit", "count",
        "history", "info", "detail", "details", "allowed", "memberships",
        "registrations", "companies", "licenses", "deliveries", "bookings",
        "calls", "call", "order", "channels", "group", "thread", "threads",
        "folder", "folders", "map", "pnl", "classify", "compliance", "aging",
    )
    tokens = set(re.split(r'[_\W]+', short.lower()))

    # An explicit mutation verb anywhere in the name disqualifies it, even if a
    # read-ish word also appears (e.g. `doc_update_health`, `msg_mark_read`,
    # `portal_chat_mark_read`, `tax_send_to_accountant`, `session_checkpoint`).
    WRITE_TOKENS = {
        "create", "update", "delete", "send", "write", "upload", "move", "rename",
        "add", "set", "remove", "claim", "release", "decide", "execute", "advance",
        "deactivate", "reactivate", "payout", "sync", "process", "prepare", "draft",
        "reply", "resend", "submit", "cleanup", "setup", "patch", "confirm",
        "transition", "generate", "ocr", "mark", "log", "checkpoint", "review",
        "complete", "recategorize", "batch", "bulk", "mass", "mail", "post",
        "trigger", "run", "apply", "assign", "close", "open", "cancel", "approve",
        "reject", "download", "export", "import", "seed", "reset", "revoke",
    }
    hit = tokens & WRITE_TOKENS
    if hit:
        deny(f"System Counselor is READ-ONLY: `{short}` looks like it changes state "
             f"({', '.join(sorted(hit))}). If this is genuinely a read that was "
             f"misclassified, say so in your report — the guard gets corrected, "
             f"the Counselor does not get to write.")

    if tokens & set(READ_TOKENS):
        allow()

    # 3c. Unrecognised: FAIL CLOSED. This is the clause that survives new tools.
    deny(f"System Counselor is READ-ONLY and `{short}` is not recognised as a read. "
         f"New tools are refused until classified — a false deny costs one message, "
         f"a false allow is a write to production. Report what you needed and why.")

# ── 4. Anything else unknown → closed.
deny(f"System Counselor is READ-ONLY: `{name}` is not a recognised read operation.")
PY
exit 0
