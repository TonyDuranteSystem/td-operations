# Hook 2 — Design Spec (NOT YET BUILT)

**Status:** Draft. Do not implement until failure modes below are accepted.
**Goal:** Block `execute_sql` writes against a table when no schema verification has happened in the same session.

## What the hook would do

PreToolUse hook on `execute_sql`. Before any mutation:

1. Parse `tool_input.query` and `tool_input.mode`.
2. If mode == `write` (INSERT / UPDATE / DELETE):
   - Extract the target table from the query.
   - Check `/tmp/claude-schema-verified-${SESSION_ID}` for that table.
   - If absent → block with: *"You have not verified the schema of `<table>` in this session. Run a SELECT on `information_schema.columns WHERE table_name = '<table>'` first."*
3. If query is `SELECT ... FROM information_schema.columns WHERE table_name = X`:
   - Append `X` to `/tmp/claude-schema-verified-${SESSION_ID}`.

## Why this is FRAGILE — failure modes I have to surface

### 1. SQL parsing is regex on free-form text
| Statement shape | Target table | Easy? |
|---|---|---|
| `INSERT INTO accounts ...` | accounts | yes |
| `UPDATE accounts SET ...` | accounts | yes |
| `DELETE FROM accounts WHERE ...` | accounts | yes |
| `WITH x AS (SELECT...) UPDATE y SET ...` | y | needs CTE-aware parser |
| `UPDATE accounts SET ... FROM other_table` | accounts | needs to ignore the FROM |
| `INSERT INTO accounts SELECT * FROM staging` | accounts | source != target |
| `public.accounts` vs `"Accounts"` | accounts | schema strip + case |
| Multi-statement (`; ... ;`) | multiple | needs splitter |

A regex-based extractor will be wrong on ~5–10% of writes. Each false positive blocks legitimate work and trains me to disable the hook.

### 2. "Same session" is a leaky concept
- Hooks share state via `/tmp/{session_id}` files. That works for the lifetime of one session.
- But a SELECT 50 turns ago is not "verification" — context has rotted, the model doesn't remember the columns. The hook would let a stale schema check pass.
- Fix: timestamp each verification, expire after N minutes or M tool calls. Adds complexity.

### 3. The lying problem
- The hook checks IF a schema query ran. It cannot check that the model READ the result.
- Workaround: model runs `SELECT column_name FROM information_schema.columns WHERE table_name = X` once per write target, doesn't look at the output, then INSERTs wrong columns anyway.
- The hook becomes a ritual to satisfy, not a verification. Same failure mode as filling out a form with `verified: true` without verifying.

### 4. False-positive cost
- First-time writes to a table in a session are common (every setup script, every one-off cleanup).
- If the hook fires often without genuine value, it gets disabled within a day.
- Existing precedent: many "lint warning" hooks in other projects get disabled within a week of install.

### 5. Doesn't cover the worst class of assumption
The biggest R093 violations are NOT in SQL writes — they are in **claims I make in chat** (e.g. "the IRS received a form with state=Italy" without reading the PDF). Hooks can't see chat content.

## What this hook would actually catch

Realistic catch list:
- INSERT against a table I've never seen before in this session → blocked
- UPDATE on a familiar table where I assumed a column name → caught only if the column name itself causes a `column does not exist` error from Postgres (which already happens without the hook)

In practice: incremental safety on top of what Postgres already does (rejecting bad column names with a clear error).

## Recommendation

**Do not build Hook 2 today.** Reasons:
1. Hook 1 (UserPromptSubmit) is in place — observe its effect for 1 week before adding more.
2. The biggest assumption-failure class (chat claims without verification) is not addressable by a SQL hook. The lever for that is the `plan_challenge` MCP tool already in `dev_tasks` (`24cfad54`).
3. If still wanted after 1 week of Hook 1 observation, the right design is an MCP-server-level guard inside `execute_sql` itself (where SQL is already parsed correctly), not a regex hook.

## Trigger to revisit

Revisit Hook 2 if:
- Hook 1 + plan_challenge are both shipped AND
- We still see ≥1 SQL-write assumption failure per week in `governance-metrics` after a 4-week observation window.

Otherwise close as "wontfix — addressed by Hook 1 + plan_challenge."
