# Hooks, Guardrails & Safety System
_Last verified against code: 2026-05-29 — Claude (read .claude/settings.json, all .claude/hooks/*.sh, .husky/pre-push)_

## What it is
The automated safety net that keeps a session from breaking production or skipping discipline. Three kinds: **Claude Code hooks** (fire on session/tool events), **git pre-push/pre-commit gates**, and **code-level guards**. Plus the 35 policy rules (R-rules) in CLAUDE.md.

## Claude Code hooks (wired in `.claude/settings.json`)
- **PreToolUse:**
  - `Bash` → `bash-production-guard.sh` — fires before every Bash call; blocks dangerous commands (prod-targeted `npm dev/build/test`, `vercel deploy/build/env pull` against the production project, etc.).
  - `Edit|Write` → `verify-before-edit.sh` — **blocks editing source files until `session-context` has been read** (per-session temp-file state).
  - send tools (`portal_chat_send`, `gmail_send`, `gmail_draft`, `offer_send`, `lease_send`, `oa_send`, `portal_team_send`, `msg_send`, `portal_invoice_send`) → `send-guard.sh`.
  - `mcp__af7d85f2-*__execute_sql` → `production-write-guard.sh` — **requires a sandbox-verified marker** (`/tmp/.sandbox-verified-YYYY-MM-DD`) before a production write.
- **PostToolUse:** `checkpoint-counter.sh` — the 5/10/15 "save a checkpoint" nudges + a remote-commit check every 50 calls.
- **Stop:** `stop-check.sh` (unsaved-changes reminder), `post-push-qa.sh` (post-push browser-QA reminder), `r095-gate.sh` (regex scan for "Present Plainly" / R095 violations), `assumption-check.sh` (**deprecated**, inert), `r093-verifier.sh` (**the independent R093 verifier** — a Python model audits the last reply's external-state claims against this session's evidence; 90s).
- **PreCompact:** `pre-compact-save.sh` + a prompt — last-chance detailed save before context is lost.
- **UserPromptSubmit:** `user-prompt-contract.sh` — injects Antonio's behavior contract on every prompt.
- **SessionStart:** `session-git-pull.sh` (git pull + `npm ci` if lockfile changed + environment report), `system-docs-index.sh` (R107 — prints the System Reference Library), then the session-start protocol prompt.

(`test-*.sh` are unit tests for the guards, not active hooks.)

## Git gates (`.husky/pre-push`, in order)
1. **Sandbox-first guard** — if pushing to `main` and `.vercel/project.json` is the production project, block unless `ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1`.
2. Remote-ahead check (another machine pushed) → rebase first.
3. Hardcoded client-facing domain check (R012).
4. Hardcoded `/Users/...` path check in hook scripts.
5. ESLint (max-warnings 0) on changed files.
6. Schema-drift check (`npm run gen:types` vs committed types).
7. Unit tests → integration tests → full build.
8. **R107 System Reference Library freshness** (`scripts/check-system-docs-freshness.sh`) — blocks if documented subsystem code changed without its doc.
Pre-commit (`lint-staged`) runs ESLint on staged files with zero-warning tolerance.

## Code-level guards
- `lib/supabase-admin.ts` — `EXPECTED_SUPABASE_REF` assertion: the server refuses to start locally if pointed at the production ref (R104).
- `.vercel/project.json` — committed with sandbox values; `git pull` resets it every machine (R104). `scripts/dev-setup.sh` is first-time setup.

## Business rules (the policy layer)
The 35 R-rules in CLAUDE.md are the human-readable policy; the hooks/gates enforce the mechanical subset. Especially: **R104** (sandbox-only dev — 3 structural layers), **R105** (DDL via migration files), **R070** (git pull each session), **R071** (no `git add -A`), **R076** (no force push), **R093** (verify, no assumptions — enforced by the Stop verifier), **R095** (present plainly), **R107** (system docs).

## Gotchas, invariants & past bugs
- **⚠️ CRITICAL (R104): `git push origin main` is NOT unconditionally blocked.** The repo is wired to BOTH the sandbox AND production Vercel projects, and `bash-production-guard` only blocks the push when `.env.local` holds the prod URL (not set during dev). **So pushing to main = deploying to production. Discipline is the only guard — NEVER push to main without Antonio's explicit "ship it."**
- **⚠️ MCP tools bypass the sandbox enforcement entirely (R096).** The `mcp__af7d85f2-*` connection is hardwired to PRODUCTION. `.env.local`, `.vercel/project.json`, and the `supabase-admin` ref check do NOT apply to MCP calls — every `mcp__af7d85f2-*__execute_sql` hits production. The only MCP-side guard is `production-write-guard.sh` (the sandbox-verified marker). For sandbox DB work use `mcp__td-ops-sandbox__*` or `psql`.
- **Production DDL via `execute_sql` is blocked outright** (R105) — even with a `migration:` reason on the prod MCP tool. The real promotion path is running the migration in the Supabase SQL editor. (CLAUDE.md R105 wording is stale on this — flag/fix it.)
- `verify-before-edit` will block your first edit until you've read `session-context`.
- The Stop `r093-verifier` can re-open a turn if it finds an unsupported external-state claim — write only what the session's tool output supports.

## How to verify current state
- Read `.claude/settings.json` (the authoritative hook wiring) and each `.claude/hooks/*.sh`.
- Read `.husky/pre-push` for the gate order.
- Confirm env enforcement: `lib/supabase-admin.ts` (`EXPECTED_SUPABASE_REF`), `.vercel/project.json` (should be the sandbox project id).
