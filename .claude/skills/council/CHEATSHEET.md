# 🧑‍⚖️ Council Cheat Sheet

**What it is:** a team of read-only AI reviewers that stress-test a plan or change before it reaches you. They advise; **your "go" is the only thing that ships anything.**

## Tiers (control the cost)
| Command | Who reviews | When to use |
|---|---|---|
| `/council light` | 3 reviewers | quick sanity check, small/low-risk changes |
| `/council` | 4 core | a real plan or decision |
| `/council full` | 4 core + the right specialists | money, tax, client data, compliance, contracts, bank prep |
| `/council deep` | full + extra refute pass | the highest-stakes / hardest calls |

If you don't pick a tier, it picks by stakes — small work gets light, money/tax/client-facing gets full (never quietly downgraded). A full pass costs real tokens (~380K); light is about a third.

## Other commands
- **"add a CPA"** / **`/council with Security`** — pull in one specialist for a task.
- **`@add-specialist <Name>`** — create a brand-new expert (e.g. `@add-specialist Data-Scientist`).

## Examples tailored to your work
- **P&L / balance-sheet change** → `/council full` (pulls in CPA-IRS + Finance Auditor; catches a sheet that doesn't tie, a dropped currency line, a misstated figure).
- **New CRM / portal feature** → `/council` or `/council full` (Business Analyst checks it fits your workflow and mobile use; Security checks client-data exposure).
- **Compliance / deadline check** (Wyoming filings, annual reports, EIN/ITIN, registered agent, BOI) → `/council full` (Compliance & Deadlines Auditor + Legal).
- **Client bank-application prep** (their website's credibility) → `/council with Ecommerce-Bank-Auditor` (checks legitimacy, professionalism, policy pages, security signals a bank looks for).
- **Contract / offer / lease wording** → `/council full` (Legal Reviewer flags exposure).
- **Database migration / schema change / backfill** → `/council full` (Data & Migration Reviewer + Security).
- **"Find bugs before this breaks in production"** → the Bug Hunter is already core (on every call); use `/council deep` for the hardest cases.
- **Just shipped something small** → `/council light`.

## When you report a bug or ask for an investigation
You don't need to name experts — the council picks them from the task, and the **Bug Hunter is always included** for a bug/issue/investigation. It runs in two steps automatically:
1. **Investigate** — the Bug Hunter + the right specialists find the root cause with exact code references.
2. **Internal approval** — a fix plan is written, then your four core reviewers approve or improve it **before** it reaches you.
You only see the final, already-stress-tested recommendation — and nothing changes until you say go.

## The team
**Core reviewers:** Senior Engineer · AI Architect · Project Director · Bug Hunter. (Senior Engineer, Project Director, and Bug Hunter are on *every* call including light; the AI Architect joins at standard/full/deep — so light tier runs those 3.)
**Specialists (auto-pulled by topic):** CPA-IRS · Finance-Auditor · Compliance-Deadlines-Auditor · Business-Analyst · Web-Auditor · Ecommerce-Bank-Auditor · Security · Legal-Reviewer · Performance-Optimizer · QA-Tester · Data-Migration-Reviewer

## The rules that protect you
- Any one reviewer finding a real, pinpointed problem = **"fix first"** (no rubber-stamp voting).
- If the core reviewers **disagree**, one extra specialist is pulled in to break the tie.
- If **no expert fits** your topic, the council proposes one (temporary or permanent) before giving final advice — it never guesses past a gap.
- Tax/legal/compliance experts **look up current rules, never memorize numbers that go stale.**
- A quiet advisory flags when a change touches money, tax, client data, or compliance — reminding you to run a full council before merging (advisory only, never blocks).

**Bottom line:** `/council full` for anything that matters, `/council light` for small stuff, ignore it for chat — and nothing happens without your go.
