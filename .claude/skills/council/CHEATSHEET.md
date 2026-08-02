# 🧑‍⚖️ Council Cheat Sheet

**What it is:** a team of read-only AI reviewers that stress-test a plan or change before it reaches you. They advise; **your "go" is the only thing that ships anything.**

## Tiers (control the cost)
| Command | Who reviews | When to use |
|---|---|---|
| `/council light` | 4 reviewers | quick sanity check, small/low-risk changes |
| `/council` | 5 core | a real plan or decision |
| `/council full` | 5 core + the right specialists | money, tax, client data, compliance, contracts, bank prep |
| `/council deep` | full + extra refute pass | the highest-stakes / hardest calls |

If you don't pick a tier, it picks by stakes — small work gets light, money/tax/client-facing gets full (never quietly downgraded). **These cost real money:** the light pass that reviewed this very change (4 reviewers) measured about 570,000 tokens. Full costs more again. Use light for small things and skip it entirely for chat.

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
- **"Are we sure this doesn't already exist?" / "is this how it really works?"** → the System Counselor is already core (on every call) and answers this first.
- **Just shipped something small** → `/council light`.

## When you report a bug or ask for an investigation
You don't need to name experts — the council picks them from the task, and the **Bug Hunter and the System Counselor are always included**. It runs in two steps automatically:
1. **Investigate** — the System Counselor first checks the hunt is pointed at the right place, then the Bug Hunter + the right specialists find the root cause with exact code references.
2. **Internal approval** — a fix plan is written, then your five core reviewers approve or improve it **before** it reaches you.
You only see the final, already-stress-tested recommendation — and nothing changes until you say go.

## The System Counselor — and the thing it fixes for you

**You should stop having to say "no, that's not how it works here."**

From now on, before a session forms any theory about anything — a bug, how something works, an audit — it has to ask the System Counsellor first, and ask it again once it thinks it has the answer. The counsellor checks the live system and tells it how the thing *actually* works, where to look, and what it's about to get wrong. If the session is heading down the wrong road it gets stopped there, not after an hour.

This happens on **every** investigation, not just the big ones — your call, and the right one: correcting a wrong investigation costs more than asking.


It is the one that actually knows **your business and your system as they are today** — and unlike the other four, it is not reading documents about them.

**It can see everything.** Not a selected list — everything the system can reach: the database, the whole CRM, every client, offer, payment and invoice, the rules and procedures, the service catalog, deliveries and where they're stuck, deadlines, tax records, leases, documents and Drive, email and chat, the dev board, the code and its full history. Nobody curates what it's allowed to look at, because the whole point is that it sees the parts a session wouldn't think to check.

**It cannot change anything.** Not one record, not one message, not one file. Three separate barriers stop it, and the last one refuses anything it doesn't recognise as reading — so a tool built next month is blocked by default rather than trusted by default.

Its job is to stop the session going down the wrong road: building something you already have, digging in the wrong part of the system, inventing a rule that isn't yours, quoting a price from memory instead of from the client's actual offer, or resting a plan on something that was retired. It is asked **first, not last** — and if it finds a real mismatch it can **halt the work and redirect it** before more effort is spent. It still can't authorize anything; only your go does that.

**The rule that keeps it honest:** if something can be checked live, it must check it — quoting a written file when a lookup was available is treated as a failure, not a shortcut. Its own knowledge file deliberately contains **no prices, no counts, no client facts** — only where to look, what's structurally true, and what changed over time. Nothing that goes out of date fast is written down anywhere it can rot. When something big does change — a system retired, a decision reversed — updating that file is the last step of the process you already have for propagating a decision.

## The team
**Core reviewers:** Senior Engineer · AI Architect · Project Director · Bug Hunter · System Counselor. (Senior Engineer, Project Director, Bug Hunter, and System Counselor are on *every* call including light; the AI Architect joins at standard/full/deep — so light tier runs those 4.)
**Specialists (auto-pulled by topic):** CPA-IRS · Finance-Auditor · Compliance-Deadlines-Auditor · Business-Analyst · Web-Auditor · Ecommerce-Bank-Auditor · Security · Legal-Reviewer · Performance-Optimizer · QA-Tester · Data-Migration-Reviewer

## The rules that protect you
- Any one reviewer finding a real, pinpointed problem = **"fix first"** (no rubber-stamp voting).
- The System Counselor finding that the work is built on something untrue about your system or business = **stop and redirect**, before more effort is spent.
- If the core reviewers **disagree**, one extra specialist is pulled in to break the tie.
- If **no expert fits** your topic, the council proposes one (temporary or permanent) before giving final advice — it never guesses past a gap.
- Tax/legal/compliance experts **look up current rules, never memorize numbers that go stale.**
- A quiet advisory flags when a change touches money, tax, client data, or compliance — reminding you to run a full council before merging (advisory only, never blocks).

**Bottom line:** `/council full` for anything that matters, `/council light` for small stuff, ignore it for chat — and nothing happens without your go.
