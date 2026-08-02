# Agent Templates

Prompt templates for Claude Code's Agent tool. Each file defines a reusable
agent pattern that writes results to Supabase before returning, keeping the
main conversation context light and compaction-resistant.

## Available Agents

| Agent | File | When to Use |
|-------|------|-------------|
| Batch Processor | `batch-processor.md` | Processing 10+ records (docs, CRM updates, bulk ops) |
| Data Auditor | `data-auditor.md` | Data quality checks, cross-source verification, compliance |
| Report Generator | `report-generator.md` | KPI reports, analytics, business reviews |
| Client Onboarding | `client-onboarding.md` | New client setup end-to-end (account, contacts, Drive, offer, email) |
| Communication Triage | `communication-triage.md` | Daily inbox triage (Gmail + WA + TG), match to accounts, draft responses |

## Council of Reviewers — a different kind of agent (do not use the pattern below)

`senior-engineer.md` · `ai-architect.md` · `project-director.md` · `bug-hunter.md` · `system-counselor.md` are the **5 permanent CORE reviewers** of the Council. They are REGISTERED read-only subagents (Read/Grep/Glob only) — they write nothing, to Supabase or anywhere else, and they return a structured findings block, not a summary. Do not apply the anti-compaction "write to DB first" pattern to them.

Rules, tiers, routing and the two-phase bug flow: `.claude/skills/council/SKILL.md` + `PROTOCOL.md`. The System Counselor's living 360° map of the system and the business: `.claude/skills/council/SYSTEM-KNOWLEDGE.md`.

## How to Use

1. Read the agent template file
2. Copy the prompt template
3. Add your specific TASK at the end
4. Launch via Agent tool with `subagent_type: "general-purpose"`

## Key Pattern

All agents follow the same anti-compaction pattern:
- **Write to DB first** — results go to Supabase before returning to chat
- **Return compact summary** — max 10-15 lines in chat
- **Use ops_session docs** — slug format: `{type}-YYYY-MM-DD-topic`
