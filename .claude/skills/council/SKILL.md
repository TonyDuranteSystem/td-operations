---
name: council
description: Convene the Council of Reviewers — three independent read-only reviewers (Senior Engineer, AI Architect, Project Director) plus topic specialists — to adversarially review a non-trivial plan, design, or code change before it reaches Antonio. Use when the user says /council, asks for a review/second-opinion, or before presenting any significant plan or shipping any non-trivial change. Skip for trivial edits and casual chat.
---

# Council of Reviewers

A parallel red-team harness, not a voting body. It exists to catch — before Antonio sees a plan — what a single pass misses, by giving each reviewer an **independent context window**, a **disjoint lens**, and a **falsifiable-output contract**. The Council NEVER authorizes anything: Antonio's explicit "go" is the only gate. The Council only shapes the plan.

## When to convene (size gate — mandatory)
- **Convene** for: a real plan or design decision, a non-trivial code change, anything touching money, client-facing sends, irreversible actions, tax/legal/compliance, or sandbox-vs-prod risk.
- **Do NOT convene** for: casual chat, a one-line typo/copy fix, a pure lookup, or anything the existing operating contract already calls "skip the ritual". Convening a 3-agent fan-out for trivial work is the exact token waste this design was reviewed to avoid.

## How to run it (choreography — the main session is the coordinator)
1. **Route by topic** using the table below. The main session (you) reads the table and picks the specialists — do NOT spawn a separate agent just to pick agents.
2. **Spawn the reviewers in parallel**, one message, multiple Agent calls:
   - Always: `senior-engineer`, `ai-architect`, `project-director` (the 3 core, real subagents).
   - Plus any topic specialists selected below (see "Adding a specialist").
   Give each the exact scope (files:line-ranges or the plan text) and require file+line citations.
3. **Collect the structured outputs.** Each reviewer returns a defect/concern list or an enumerated "none found".
4. **Escalate disjunctively.** If ANY reviewer returns a concrete, cited blocker → the plan is "fix first". No vote counting, no unanimity. The valuable signal is "did anyone find a blocker", not "did everyone bless it".
5. **If the three core reviewers disagree significantly, pull in ONE tiebreaker specialist** (per PROTOCOL.md) — chosen for the domain of the disagreement — to review the contested point with fresh evidence BEFORE the final recommendation. Capped at one extra reviewer. Do not smooth a real split over silently.
6. **The Project Director writes the plain-English synthesis** for Antonio: bottom line, any disagreement between reviewers (and how the tiebreaker resolved it), the single most important finding, and go / fix-first / stop.
7. **Escape hatch.** The main session may override a "no findings" result and proceed, or discard a reviewer's noise — the Council advises, it does not block obviously-correct work. Say so plainly when you override.

## Topic → specialist routing table
Match on meaning, not exact keywords — the phrases are cues, not a whitelist. Pull in every row the task plausibly touches (a change can hit several).

| If the task involves… | Pull in these specialists (beyond the 3 core) |
|---|---|
| tax, tax returns, profit & loss, balance sheet, IRS, filing, extensions, entity type | CPA-IRS, Finance-Auditor |
| money math, invoices, payments, payouts, financial statements, reconciliation | Finance-Auditor |
| LLC setup, formation, onboarding, compliance, renewals, registered agent, EIN/ITIN, dissolution | CPA-IRS, Legal-Reviewer |
| CRM, client portal, dashboard, business process, requirements, ROI, workflow, staff/ops tooling | Business-Analyst |
| ecommerce, website, public client site, landing page, SEO, general UI/UX | Web-Auditor |
| bank-account approval, payment-processor onboarding, client-site credibility for underwriters | Ecommerce-Bank-Auditor |
| banking, payments, credentials, auth, PII, data exposure, uploads, webhooks | Security |
| contracts, offers, leases, operating agreements, ICA, consent, liability, terms | Legal-Reviewer |
| performance, scalability, slow pages, function-timeout, query cost, bundle size | Performance-Optimizer |
| test coverage, missing unit tests, e2e, regression risk, "is this proven?" | QA-Tester |
| external / third-party integrations (Tesla, banking APIs, other vendor APIs) | Security, Performance-Optimizer (and flag a dedicated integration specialist if the work is deep) |

If the task's domain is NOT covered by any specialist above, that is a **gap** — see "Flag a missing specialist".

## Adding a specialist
Specialists are **content templates**, not registered agents (a new agent file only wakes up next session). To use one **now**:
1. Read the matching template in `.claude/skills/council/specialists/`.
2. Spawn a `general-purpose` subagent with that template's text as its prompt, filling in the task scope. It runs this turn — no reload needed.

**Commands the user may say:**
- `/council with CPA` (or "add a CPA") → convene the 3 core + run the CPA-IRS template inline this turn.
- `@add-specialist <Name>` → create a new reusable template file in `specialists/` from `_TEMPLATE.md` (a plain content file, usable immediately by reading it) AND offer to register a permanent subagent for next session.

## Flag a missing specialist (self-memory rule)
Before running the Council on a plan, check the routing table. If no specialist covers the task's domain, **say so to Antonio in one plain line and give the exact command to add one**, e.g.:
> "No specialist covers <domain>. I can add one now with `/council with <Name>` (just this session) or make it permanent with `@add-specialist <Name>`."
Then continue — never silently skip a domain, and never auto-manufacture a specialist just to complete the ritual. Surface the gap; let Antonio choose.

## Reviewer contract (enforced)
Every reviewer is read-only (Read/Grep/Glob) and must return a concrete cited finding OR an enumerated "checked X/Y/Z, none found". "Looks good" is banned. The Senior Engineer specifically CANNOT approve — it only reports defects or none-found. Divergence lives in **different evidence + disjoint checklists**, not job titles.

See `PROTOCOL.md` in this folder for the standing rules the session should reload each session.
