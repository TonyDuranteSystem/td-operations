#!/usr/bin/env python3
"""
r093_verifier.py — independent-model R093 enforcement.

WHY THIS EXISTS
---------------
Every prior R093 mechanism was the SAME Claude reminding itself to be careful
(assumption-check.sh static reminder, the injected behavior contract). A model
under pressure to be helpful skims its own reminders. They do not work — proven
by repeated violations (e.g. the Chiara Fazzini chat: $30,000 stated in the
client's messages, $35,000 in an internal draft; Claude silently presented
$35,000 as fact without flagging the conflict).

This hook takes verification OUT of the hands of the Claude that is trying to be
helpful. On Stop, it launches a SEPARATE, independent Claude whose only job is to
diff the answer against the raw tool outputs from this turn and report any claim
that the evidence does not support, or any conflict the answer failed to flag.
An auditor with no incentive to be helpful does not take the helpful-answer
shortcut. If it finds problems, the turn is forced to continue and correct.

MECHANICS (all verified against the live platform, not assumed)
---------------------------------------------------------------
- Stop hook continuation: print {"decision":"block","reason":...}; the recursive
  Stop event then carries stop_hook_active=true, which we use to break the loop.
- Auditor call: `claude -p` headless. --setting-sources user skips THIS project's
  hooks (no git-pull SessionStart, no recursion) and --strict-mcp-config with an
  empty config skips all MCP servers (fast). Auth comes from the keychain/OAuth
  the interactive session already holds (NOT --bare, which would force an API key
  that isn't set here).
- Transcript: tool_use blocks live on type="assistant" lines; tool_result blocks
  live on type="user" lines (content is a list).

FAIL-OPEN: any parse error, missing claude, timeout, or unparseable auditor
output exits 0 (no block). A broken safety net must never block legitimate work.

KILL SWITCH: set R093_VERIFIER_OFF=1 to disable.
MODEL: R093_AUDITOR_MODEL (default "sonnet").
"""

import json
import os
import re
import subprocess
import sys

EVIDENCE_CAP = 16000     # chars of tool-output evidence sent to the auditor
ANSWER_CAP = 8000        # chars of the assistant answer sent to the auditor
MIN_ANSWER_LEN = 120     # skip trivial answers
AUDITOR_TIMEOUT = 80     # seconds for the headless auditor call


def fail_open(msg=None):
    if msg:
        sys.stderr.write(f"r093-verifier: {msg}\n")
    sys.exit(0)


def main():
    # Never run inside the auditor's own sub-session.
    if os.environ.get("R093_AUDITOR"):
        fail_open()
    if os.environ.get("R093_VERIFIER_OFF"):
        fail_open()

    try:
        hook = json.load(sys.stdin)
    except Exception as e:
        fail_open(f"stdin parse: {e}")

    # Break the continuation loop: if we already blocked once this turn, let it end.
    if hook.get("stop_hook_active") in (True, "true", "True"):
        fail_open()

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
        # A real human turn boundary: a user message carrying human text,
        # NOT a tool_result delivery and NOT a meta/system line.
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

    last_human = -1
    for i, o in enumerate(lines):
        if is_human_prompt(o):
            last_human = i
    turn = lines[last_human + 1:] if last_human >= 0 else lines

    evidence_parts = []
    tool_names = []
    answer = ""
    for o in turn:
        msg = o.get("message")
        c = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(c, list):
            continue
        if o.get("type") == "assistant":
            for p in c:
                if not isinstance(p, dict):
                    continue
                if p.get("type") == "tool_use":
                    tool_names.append(p.get("name", "?"))
                elif p.get("type") == "text":
                    t = p.get("text", "")
                    if t.strip():
                        answer = t  # keep the last substantive assistant text
        elif o.get("type") == "user":
            for p in c:
                if isinstance(p, dict) and p.get("type") == "tool_result":
                    tc = p.get("content")
                    if isinstance(tc, str):
                        evidence_parts.append(tc)
                    elif isinstance(tc, list):
                        for q in tc:
                            if isinstance(q, dict) and q.get("type") == "text":
                                evidence_parts.append(q.get("text", ""))

    # ---- gate: only audit substantive, evidence-backed synthesis turns ----
    if not evidence_parts:
        fail_open()  # no tool outputs this turn — nothing to diff against
    if len(answer.strip()) < MIN_ANSWER_LEN:
        fail_open()  # trivial answer

    evidence = "\n\n----\n\n".join(evidence_parts)
    if len(evidence) > EVIDENCE_CAP:
        head = evidence[: EVIDENCE_CAP * 2 // 3]
        tail = evidence[-EVIDENCE_CAP // 3:]
        evidence = head + "\n\n...[evidence truncated]...\n\n" + tail
    if len(answer) > ANSWER_CAP:
        answer = answer[:ANSWER_CAP] + "\n...[answer truncated]..."

    # ---- build the auditor call ------------------------------------------
    system = (
        "You are a strict, independent fact-checker. You are auditing another AI "
        "assistant's reply against the RAW TOOL OUTPUTS it had access to this turn. "
        "You have exactly one job: catch claims the evidence does not support. You "
        "do not care whether the reply is helpful, well-written, or complete. You "
        "only verify that every concrete factual claim in the ANSWER is directly "
        "supported by the EVIDENCE, and that wherever the EVIDENCE contains "
        "conflicting values for the same fact, the ANSWER explicitly flagged the "
        "conflict instead of silently choosing one value. Output STRICT JSON only."
    )
    user = (
        "EVIDENCE — verbatim tool outputs available to the assistant this turn:\n"
        "<evidence>\n" + evidence + "\n</evidence>\n\n"
        "ANSWER — the assistant's reply to the user:\n"
        "<answer>\n" + answer + "\n</answer>\n\n"
        "TASK: List every CONCRETE factual claim in ANSWER — specific amounts, "
        "dates, names, IDs, counts, statuses, table/column names, or yes/no facts "
        "— that is either:\n"
        "  (a) NOT directly supported by EVIDENCE, or\n"
        "  (b) where EVIDENCE contains a DIFFERENT/conflicting value for the same "
        "fact that ANSWER did not explicitly flag.\n"
        "Do NOT flag opinions, recommendations, plans, or reasonable summaries — "
        "only verifiable factual claims. Be precise and conservative; only flag "
        "what you can point to in the evidence.\n\n"
        'Output STRICT JSON ONLY, no prose:\n'
        '{"violations":[{"claim":"<the claim as stated in ANSWER>",'
        '"issue":"unsupported|conflict",'
        '"evidence":"<what EVIDENCE actually says, or the word absent>"}]}\n'
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

    # Extract the JSON object from the auditor's reply (it may wrap prose).
    m = re.search(r'\{.*"violations".*\}', out, re.DOTALL)
    if not m:
        fail_open("no json in auditor output")
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        # last resort: try the largest brace span
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
        "against the actual tool outputs from this turn and found claims the "
        "evidence does not support (or conflicts you did not flag):\n\n"
        + "\n".join(bullets)
        + "\n\nYou MUST now go back to the ACTUAL tool outputs above, reconcile "
        "each flagged claim against what the evidence literally says, and CORRECT "
        "your reply. Where two sources disagree, present BOTH values and flag the "
        "conflict explicitly — never silently pick one. Do not simply restate your "
        "previous answer; fix the specific claims listed above and tell the user "
        "what changed."
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
