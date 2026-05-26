#!/usr/bin/env python3
"""
r093_verifier.py — independent-model R093 enforcement (v2: session-wide evidence).

WHY THIS EXISTS
---------------
Every prior R093 mechanism was the SAME Claude reminding itself to be careful
(assumption-check.sh static reminder + injected behavior contract). A model
under pressure to be helpful skims its own reminders. They do not work — proven
by repeated violations (e.g. the Chiara Fazzini chat: $30,000 stated in the
client's messages, $35,000 in an internal draft; Claude silently presented
$35,000 as fact without flagging the conflict).

This hook takes verification OUT of the hands of the Claude that is trying to be
helpful. On Stop, it launches a SEPARATE, independent Claude whose only job is to
diff the answer against the grounded evidence available this session and report
any external-state claim the evidence does not support, or any conflict the
answer failed to flag. If it finds problems, the turn is forced to continue and
correct.

v2 CHANGES (closing the two v1 gaps)
------------------------------------
- Gap 1 (under-checking): v1 only ran when THIS turn had tool outputs, so claims
  made without a fresh lookup were never audited. v2 uses session-wide evidence,
  so a turn that summarizes earlier lookups is still audited.
- Gap 2 (false alarms): v1 only saw THIS turn's tool outputs, so a true claim
  resting on an earlier lookup or on the conversation got flagged "unsupported".
  v2 feeds tiered evidence — this turn's tool outputs, earlier tool outputs this
  session, and what the USER stated — and sharpens scope so the auditor polices
  ONLY concrete external-state facts and ignores meta-claims about our own work,
  recommendations, and reasoning. The assistant's own earlier words are NEVER
  evidence (only real tool results and user statements are ground truth).

MECHANICS (verified against the live platform, not assumed)
-----------------------------------------------------------
- Stop hook continuation: print {"decision":"block","reason":...}; the recursive
  Stop event carries stop_hook_active=true, which breaks the loop.
- Auditor call: `claude -p` headless. --setting-sources user skips THIS project's
  hooks (no git-pull SessionStart, no recursion); --strict-mcp-config with an
  empty config skips all MCP servers. Auth comes from the keychain/OAuth the
  interactive session already holds (NOT --bare, which forces an API key).
- Transcript: tool_use blocks on type="assistant" lines; tool_result blocks on
  type="user" lines (content is a list).

FAIL-OPEN: any parse error, missing claude, timeout, or unparseable auditor
output exits 0. A broken safety net must never block legitimate work.

KILL SWITCH: R093_VERIFIER_OFF=1 disables.
MODEL: R093_AUDITOR_MODEL (default "sonnet").
"""

import json
import os
import re
import subprocess
import sys

THIS_TURN_CAP = 14000    # chars of this turn's tool-output evidence
PRIOR_CAP = 8000         # chars of earlier-this-session tool-output evidence
USER_CAP = 4000          # chars of user-stated context
MIN_ANSWER_LEN = 120     # skip trivial answers
AUDITOR_TIMEOUT = 80     # seconds for the headless auditor call


def fail_open(msg=None):
    if msg:
        sys.stderr.write(f"r093-verifier: {msg}\n")
    sys.exit(0)


def cap(text, n):
    if len(text) <= n:
        return text
    return text[: n * 2 // 3] + "\n...[truncated]...\n" + text[-n // 3:]


def main():
    if os.environ.get("R093_AUDITOR"):
        fail_open()  # never run inside the auditor's own sub-session
    if os.environ.get("R093_VERIFIER_OFF"):
        fail_open()

    try:
        hook = json.load(sys.stdin)
    except Exception as e:
        fail_open(f"stdin parse: {e}")

    if hook.get("stop_hook_active") in (True, "true", "True"):
        fail_open()  # break the continuation loop

    transcript_path = hook.get("transcript_path") or ""
    if not transcript_path or not os.path.isfile(transcript_path):
        fail_open("no transcript")

    # ---- parse transcript ------------------------------------------------
    lines = []
    try:
        with open(transcript_path) as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    lines.append(json.loads(raw))
                except Exception:
                    continue
    except Exception as e:
        fail_open(f"transcript read: {e}")

    def is_human_prompt(o):
        if o.get("type") != "user":
            return False
        if o.get("isMeta") or o.get("isCompactSummary"):
            return False
        msg = o.get("message")
        if not isinstance(msg, dict):
            return False
        c = msg.get("content")
        if isinstance(c, str):
            return bool(c.strip())
        if isinstance(c, list):
            has_text = any(isinstance(p, dict) and p.get("type") == "text" for p in c)
            has_tool_result = any(
                isinstance(p, dict) and p.get("type") == "tool_result" for p in c
            )
            return has_text and not has_tool_result
        return False

    def human_text(o):
        msg = o.get("message", {})
        c = msg.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "\n".join(
                p.get("text", "")
                for p in c
                if isinstance(p, dict) and p.get("type") == "text"
            )
        return ""

    def tool_result_text(p):
        tc = p.get("content")
        if isinstance(tc, str):
            return tc
        if isinstance(tc, list):
            return "\n".join(
                q.get("text", "")
                for q in tc
                if isinstance(q, dict) and q.get("type") == "text"
            )
        return ""

    last_human = -1
    for i, o in enumerate(lines):
        if is_human_prompt(o):
            last_human = i

    this_turn_results = []   # tool outputs produced THIS turn
    prior_results = []       # tool outputs from earlier in the session
    user_texts = []          # everything the user has stated (authoritative)
    answer = ""              # the assistant's final text this turn

    for i, o in enumerate(lines):
        if is_human_prompt(o):
            t = human_text(o).strip()
            if t:
                user_texts.append(t)
            continue
        msg = o.get("message")
        c = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(c, list):
            continue
        typ = o.get("type")
        if typ == "assistant":
            for p in c:
                if not isinstance(p, dict):
                    continue
                if p.get("type") == "text" and i > last_human:
                    t = p.get("text", "")
                    if t.strip():
                        answer = t  # keep last substantive assistant text this turn
        elif typ == "user":
            for p in c:
                if isinstance(p, dict) and p.get("type") == "tool_result":
                    txt = tool_result_text(p)
                    if not txt:
                        continue
                    if i > last_human:
                        this_turn_results.append(txt)
                    else:
                        prior_results.append(txt)

    # ---- gate ------------------------------------------------------------
    # Need SOME grounded evidence in the session to diff against, and a
    # substantive answer. Pure chit-chat with no lookups anywhere is skipped.
    if not this_turn_results and not prior_results:
        fail_open()
    if len(answer.strip()) < MIN_ANSWER_LEN:
        fail_open()

    this_turn = (
        cap("\n\n----\n\n".join(this_turn_results), THIS_TURN_CAP)
        if this_turn_results
        else "(no tool calls this turn)"
    )
    prior = (
        cap("\n\n----\n\n".join(prior_results[-30:]), PRIOR_CAP)
        if prior_results
        else "(none)"
    )
    users = (
        cap("\n\n----\n\n".join(user_texts[-15:]), USER_CAP)
        if user_texts
        else "(none)"
    )

    # ---- build the auditor call ------------------------------------------
    system = (
        "You are a strict, independent fact-checker auditing another AI "
        "assistant's reply against the grounded evidence it had access to this "
        "session. You have exactly one job: catch claims about EXTERNAL STATE "
        "that the evidence does not support. You do not care whether the reply "
        "is helpful, well-written, or complete. EVIDENCE comes in tiers; only "
        "real tool outputs and user statements are ground truth — the "
        "assistant's own earlier words are NOT evidence and must never be "
        "treated as support. Output STRICT JSON only."
    )
    user = (
        "EVIDENCE — grounded source material, in tiers:\n\n"
        "[THIS TURN'S TOOL OUTPUTS]\n" + this_turn + "\n\n"
        "[EARLIER TOOL OUTPUTS THIS SESSION]\n" + prior + "\n\n"
        "[WHAT THE USER HAS STATED]\n" + users + "\n\n"
        "ANSWER — the assistant's latest reply:\n<answer>\n" + cap(answer, 8000)
        + "\n</answer>\n\n"
        "TASK: Audit ONLY concrete claims about EXTERNAL STATE — client/account/"
        "contact/payment/document facts, database values, what a file/table/"
        "column/function contains or does, system configuration, and specific "
        "dates/amounts/IDs/statuses that should come from tool outputs.\n\n"
        "Flag a claim when:\n"
        "  (a) it CONTRADICTS the EVIDENCE, or\n"
        "  (b) the EVIDENCE contains a different/conflicting value for the same "
        "fact that the ANSWER did not explicitly flag, or\n"
        "  (c) it is a specific external-state fact with NO support anywhere in "
        "EVIDENCE (an ungrounded assertion).\n\n"
        "NEVER flag (these are not violations): recommendations, plans, next "
        "steps, opinions, reasoning, fair summaries or paraphrases of the "
        "evidence, restatements of what the user said, general world knowledge, "
        "or META statements about this work session itself — what was built, "
        "tested, committed, pushed, how the tooling behaves, or what happened "
        "earlier in the conversation.\n\n"
        "Be precise and conservative; only flag what you can point to. Output "
        "STRICT JSON ONLY, no prose:\n"
        '{"violations":[{"claim":"<claim as stated in ANSWER>",'
        '"issue":"contradiction|conflict|ungrounded",'
        '"evidence":"<what EVIDENCE says, or the word absent>"}]}\n'
        'If there are no violations, output exactly {"violations":[]}.'
    )

    model = os.environ.get("R093_AUDITOR_MODEL", "sonnet")
    cmd = [
        "claude", "-p",
        "--model", model,
        "--setting-sources", "user",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--no-session-persistence",
        "--append-system-prompt", system,
        user,
    ]
    env = dict(os.environ)
    env["R093_AUDITOR"] = "1"
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=AUDITOR_TIMEOUT, env=env
        )
    except Exception as e:
        fail_open(f"auditor call: {e}")
    out = (r.stdout or "").strip()
    if not out:
        fail_open("auditor empty output")

    m = re.search(r'\{.*"violations".*\}', out, re.DOTALL)
    if not m:
        fail_open("no json in auditor output")
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        try:
            parsed = json.loads(out[out.index("{"): out.rindex("}") + 1])
        except Exception as e:
            fail_open(f"auditor json parse: {e}")

    violations = parsed.get("violations") or []
    if not isinstance(violations, list) or not violations:
        fail_open()  # clean — let the turn end

    # ---- block and force correction --------------------------------------
    bullets = []
    for v in violations[:12]:
        if not isinstance(v, dict):
            continue
        claim = str(v.get("claim", "")).strip()
        issue = str(v.get("issue", "")).strip()
        ev = str(v.get("evidence", "")).strip()
        bullets.append(
            f"- CLAIM: {claim}\n  ISSUE: {issue}\n  EVIDENCE ACTUALLY SAYS: {ev}"
        )
    reason = (
        "🔴 R093 INDEPENDENT VERIFIER — an independent model audited your reply "
        "against the grounded evidence this session (this turn's tool outputs, "
        "your earlier lookups, and what the user stated) and found external-state "
        "claims the evidence does not support (or conflicts you did not flag):\n\n"
        + "\n".join(bullets)
        + "\n\nGo back to the ACTUAL evidence, reconcile each flagged claim against "
        "what it literally says, and CORRECT your reply. Where two sources "
        "disagree, present BOTH values and flag the conflict — never silently "
        "pick one. For an 'ungrounded' flag, either cite the real source of the "
        "fact or look it up before asserting it. Do not simply restate your "
        "previous answer; fix the specific claims above and tell the user what "
        "changed."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail_open(f"unhandled: {e}")
