#!/usr/bin/env python3
"""
r095_gate.py — blocking enforcement for R095 (Present Plainly).

WHY THIS EXISTS
---------------
The original r095-gate.sh detected jargon correctly but printed its findings
as plain stdout with exit 0 — which a Stop hook silently discards. It never
once forced a rewrite (root cause of dev job ef39fe73: Antonio kept receiving
file paths / commit hashes / table.column in reply bodies despite the rule).
This version emits the {"decision":"block"} JSON the platform actually acts
on — the same mechanic proven by r093_verifier.py.

DESIGN (council-reviewed, 2 passes, plan v2.1)
----------------------------------------------
- Deterministic regex, no model call (an LLM judging tone drifts/loops —
  demonstrated pathologically in the P3.4 #6 session).
- Scan = ALL assistant text blocks after the last GENUINE human prompt
  (isMeta / isCompactSummary / isSidechain filtered). If no genuine human
  prompt exists (post-compaction), fall back to the final assistant message
  only — never the whole file.
- Exclusions: fenced code blocks; a "Technical details" footer (multi-variant,
  case-insensitive) — but the footer is only exempt when a non-trivial plain
  body precedes it, so stuffing the whole reply into a footer still blocks.
- Tokens the user themselves typed this turn are whitelisted (talking ABOUT
  a file the user named is fine).
- Matches are span-deduped across classes (a path:line ref is ONE token, not
  two) and the gate blocks at >= 2 deduped technical tokens.
- Skips: user's prompt is itself technical (paths / SQL / code fence), or
  explicitly requests citations (English + Italian).
- The rewrite instruction RELOCATES references to a Technical details footer;
  it never asks to delete facts, citations, or client-facing links — keeping
  it consistent with the r093 verifier's "cite the source" order.

FAIL-OPEN: any error exits 0. KILL SWITCH: R095_GATE_OFF=1.
"""

import json
import os
import re
import sys

MAX_LINE_BYTES = 50_000       # skip pathological transcript lines (base64 pastes)
MIN_BODY_BEFORE_FOOTER = 80   # non-space chars required before an exempt footer
BLOCK_THRESHOLD = 2           # deduped technical tokens that trigger a block
MAX_LISTED = 8                # tokens listed back in the block reason

EXTS = r"(?:ts|tsx|js|jsx|py|sql|sh|rb|go|rs|md|json|yml|yaml)"

# Token classes — anchored shapes only (no bare hex: offer/lease draft links
# carry hex tokens; no bare :NNN: clock times).
RE_DIR_PATH = re.compile(
    r"(?<![\w/])(?:[A-Za-z0-9_.\-]+/)+[A-Za-z0-9_.\-]+\." + EXTS + r"(?::\d+)?\b"
)
RE_BARE_FILE = re.compile(r"\b[\w\-]+\.(?:ts|tsx|py|sql|sh|rb|go|rs|json)\b")
RE_FILE_LINE = re.compile(r"\b[\w.\-]+\." + EXTS + r":\d+\b")
# table.column: at least one side must carry an underscore, so domains
# (portal.tonydurante.us, claude.ai) never match.
RE_SCHEMA = re.compile(
    r"\b(?:[a-z]{2,}(?:_[a-z0-9]+)+\.[a-z][a-z0-9_]*|[a-z]{2,}\.[a-z]{2,}(?:_[a-z0-9]+)+)\b"
)
RE_BACKTICK = re.compile(r"`([^`\n]{1,80})`")
RE_HEX_CTX = re.compile(
    r"commits?[: ]+[a-f0-9]{7,40}|`[a-f0-9]{7,40}`|\b[a-f0-9]{7,12}\s+\(",
    re.IGNORECASE,
)

RE_FENCE = re.compile(r"```.*?(?:```|\Z)", re.DOTALL)
RE_FOOTER = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:technical\s+details?|tech\s+notes?|dettagli\s+tecnici)\s*:?\s*(?:\*\*)?\s*:?.*$",
    re.IGNORECASE | re.MULTILINE,
)

RE_CITATION_REQUEST = re.compile(
    r"citation|cite|where in the code|show me the (?:file|code|line)|which file"
    r"|line number|dove nel codice|fammi vedere il (?:file|codice)"
    r"|mostrami il (?:file|codice)|quale file|file e riga",
    re.IGNORECASE,
)
RE_TECH_PROMPT = re.compile(
    r"```|(?:[A-Za-z0-9_.\-]+/)+[A-Za-z0-9_.\-]+\." + EXTS
    + r"|\bselect\s+.+\bfrom\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b",
    re.IGNORECASE,
)


def fail_open(msg=None):
    if msg:
        sys.stderr.write(f"r095-gate: {msg}\n")
    sys.exit(0)


def code_shaped(inner):
    """A backticked token counts only when it looks like code, not a quoted word."""
    if not re.fullmatch(r"[A-Za-z0-9_.:/()\-]+", inner):
        return False
    return (
        "_" in inner
        or inner.endswith("()")
        or re.search(r"[a-z][A-Z]", inner) is not None
    )


def collect_spans(text):
    spans = []
    for rx in (RE_DIR_PATH, RE_BARE_FILE, RE_FILE_LINE, RE_SCHEMA, RE_HEX_CTX):
        for m in rx.finditer(text):
            spans.append((m.start(), m.end(), m.group(0)))
    for m in RE_BACKTICK.finditer(text):
        if code_shaped(m.group(1)):
            spans.append((m.start(), m.end(), m.group(1)))
    return spans


def merge_spans(spans):
    """Overlapping matches (path vs path:line vs bare file) count as ONE token."""
    if not spans:
        return []
    spans.sort(key=lambda s: (s[0], -s[1]))
    merged = [spans[0]]
    for s in spans[1:]:
        last = merged[-1]
        if s[0] < last[1]:  # overlap → keep the longer, already-first one
            continue
        merged.append(s)
    return merged


def strip_exclusions(text):
    text = RE_FENCE.sub("", text)
    m = RE_FOOTER.search(text)
    if m:
        body_before = re.sub(r"\s", "", text[: m.start()])
        # Footer-stuffing guard: only exempt the footer when a real plain body
        # precedes it. A reply that is ALL footer stays fully scanned.
        if len(body_before) >= MIN_BODY_BEFORE_FOOTER:
            text = text[: m.start()]
    return text


def main():
    if os.environ.get("R095_GATE_OFF"):
        fail_open()

    try:
        hook = json.load(sys.stdin)
    except Exception as e:
        fail_open(f"stdin parse: {e}")

    if hook.get("stop_hook_active") in (True, "true", "True"):
        fail_open()  # one-shot enforcement: never re-block a forced rewrite

    transcript_path = hook.get("transcript_path") or ""
    if not transcript_path or not os.path.isfile(transcript_path):
        fail_open("no transcript")

    lines = []
    try:
        with open(transcript_path) as f:
            for raw in f:
                if len(raw) > MAX_LINE_BYTES:
                    continue
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
        if o.get("isMeta") or o.get("isCompactSummary") or o.get("isSidechain"):
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

    def text_blocks(o):
        msg = o.get("message")
        c = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(c, str):
            return [c] if c.strip() else []
        if not isinstance(c, list):
            return []
        return [
            p.get("text", "")
            for p in c
            if isinstance(p, dict) and p.get("type") == "text" and p.get("text", "").strip()
        ]

    last_human = -1
    for i, o in enumerate(lines):
        if is_human_prompt(o):
            last_human = i

    assistant_parts = []
    if last_human >= 0:
        for i, o in enumerate(lines):
            if i > last_human and o.get("type") == "assistant" and not o.get("isSidechain"):
                assistant_parts.extend(text_blocks(o))
        user_prompt = "\n".join(text_blocks(lines[last_human]))
    else:
        # Post-compaction fallback: no genuine human prompt in the file —
        # scan ONLY the final assistant message, never the whole transcript.
        for o in lines:
            if o.get("type") == "assistant" and not o.get("isSidechain"):
                blocks = text_blocks(o)
                if blocks:
                    assistant_parts = blocks
        user_prompt = ""

    answer = "\n".join(assistant_parts).strip()
    if not answer:
        fail_open()

    # Skips: the user asked a technical question or asked for citations.
    if user_prompt:
        if RE_CITATION_REQUEST.search(user_prompt) or RE_TECH_PROMPT.search(user_prompt):
            fail_open()

    scanned = strip_exclusions(answer)
    spans = collect_spans(scanned)

    # Whitelist tokens the user themselves typed this turn.
    prompt_lower = user_prompt.lower()
    if prompt_lower:
        spans = [s for s in spans if s[2].lower() not in prompt_lower]

    merged = merge_spans(spans)
    if len(merged) < BLOCK_THRESHOLD:
        fail_open()

    tokens = []
    seen = set()
    for _, _, tok in merged:
        t = tok.strip()
        if t.lower() not in seen:
            seen.add(t.lower())
            tokens.append(t)
        if len(tokens) >= MAX_LISTED:
            break

    reason = (
        "🔴 R095 PLAIN-ENGLISH GATE — your reply body contains raw technical "
        "references Antonio asked you to keep out of the explanation:\n\n  "
        + "\n  ".join(f"- {t}" for t in tokens)
        + "\n\nREWRITE the reply now:\n"
        "1. The body must read in plain English — say what each reference MEANS "
        "instead of naming it (\"the file that builds invoices\", \"the change "
        "shipped earlier today\").\n"
        "2. MOVE the technical references into a short 'Technical details' "
        "footer at the END of the reply. Do NOT delete facts, citations, "
        "links, or anything client-facing — relocate them.\n"
        "3. Keep the answer itself and its meaning unchanged."
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
