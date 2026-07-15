---
name: council
description: Convene the Council of Reviewers — three independent read-only reviewers (Senior Engineer, AI Architect, Project Director) plus topic specialists — to adversarially review a non-trivial plan, design, or code change before it reaches Antonio. Use when the user says /council, asks for a review/second-opinion, or before presenting any significant plan or shipping any non-trivial change. Skip for trivial edits and casual chat.
---

# Council of Reviewers

A parallel red-team harness, not a voting body. It exists to catch — before Antonio sees a plan — what a single pass misses, by giving each reviewer an **independent context window**, a **disjoint lens**, and a **falsifiable-output contract**. The Council NEVER authorizes anything: Antonio's explicit "go" is the only gate. The Council only shapes the plan.

## When to convene (size gate — mandatory)
- **Convene** for: a real plan or design decision, a non-trivial code change, anything touching money, client-facing sends, irreversible actions, tax/legal/compliance, or sandbox-vs-prod risk.
- **Do NOT convene** for: casual chat, a one-line typo/copy fix, a pure lookup, or anything the existing operating contract already calls "skip the ritual". Convening a 3-agent fan-out for trivial work is the exact token waste this design was reviewed to avoid.

## Council tiers (cost control)
Pick the smallest tier that fits the stakes. A full pass is several parallel Opus reviewers (~300–400K tokens); light is roughly a third of that. The tier is chosen two ways — an **explicit modifier the user types wins**; otherwise pick by **stakes**.

| Tier (how the user asks) | Reviewers spawned | Use for |
|---|---|---|
| **light** — `/council light` / "quick council" | 2: `senior-engineer` + `project-director` | low-risk changes, a quick sanity check, reviewing the council's own tooling |
| **standard** — `/council` | 3 core: `senior-engineer` + `ai-architect` + `project-director` | a real plan or design decision with no special domain |
| **full** — `/council full` | 3 core + the routed topic specialists (table below) | anything touching money, tax, client data, compliance, contracts, or client-facing/irreversible actions |
| **deep** — `/council deep` | full + a single adversarial refute pass on each blocker | highest-stakes / hardest calls where a false finding is costly |

**Tier defaults by stakes (when the user gives no modifier):**
- trivial edit / casual chat → **no council** (size gate).
- low-risk change → **light**.
- a real plan, no money/client risk → **standard**.
- touches money / tax / client data / CRM-portal / compliance / irreversible / sandbox-vs-prod → **full** (never default these down to light).

**The one-specialist tiebreaker is NOT deep-exclusive** — it applies to every standard/full/deep pass whenever the 3 core reviewers genuinely disagree (step 5). `deep` adds one thing on top: an **adversarial refute pass**. That is NOT vote-tallying (that violates the no-voting rule) — it is ONE independent attempt to refute each blocker, to weed out a false positive before it reaches Antonio. **Guardrails:** a refute may downgrade a blocker ONLY on concrete contradicting evidence (file:line); any ambiguity resolves in favor of the blocker still halting; and a refuted blocker is STILL surfaced to Antonio in the synthesis (never silently dropped). **In light mode** (2 reviewers, no AI Architect) there is no 3-core tiebreaker — disjunctive escalation alone governs, and a genuinely contested finding escalates the tier rather than pulling a tiebreaker.

## How to run it (choreography — the main session is the coordinator)
1. **Pick the tier** (above), then **route by topic** using the table below for the specialists a full/deep pass needs. The main session (you) reads the table and picks the specialists — do NOT spawn a separate agent just to pick agents.
2. **Spawn the tier's reviewers in parallel**, one message, multiple Agent calls:
   - light = `senior-engineer` + `project-director`; standard/full/deep = the 3 core (`senior-engineer`, `ai-architect`, `project-director`), plus topic specialists for full/deep.
   - Give each the exact scope. **Auto-feed the real change** — pass the actual `git diff` (or the plan text) into each reviewer's prompt rather than a hand-summarized scope, so they reason on ground truth. Require file+line citations.
   - **After the pass, log the verdict AND its token cost** to the active dev-tracker job via `dev_task_update` as a progress entry (R112): reviewers + tier + GO/FIX-FIRST + any blockers, plus the pass's **total token cost** — sum the `subagent_tokens` the harness reports in each reviewer's Agent-tool result metadata (NOT the reviewer's prose). If that metadata isn't available, record "tokens: unavailable" — never guess a number (R093). This keeps the review trail AND makes the cost/value of each council pass visible over time.
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
| LLC setup, formation (esp. Wyoming), onboarding, compliance, renewals, annual reports, registered agent/CMRA, EIN/ITIN (CAA), BOI/FinCEN, contract renewals, dissolution | Compliance-Deadlines-Auditor, CPA-IRS, Legal-Reviewer |
| CRM, client portal, dashboard, business process, requirements, ROI, workflow, staff/ops tooling | Business-Analyst |
| ecommerce, website, public client site, landing page, SEO, general UI/UX | Web-Auditor |
| bank-account approval, payment-processor onboarding, client-site credibility for underwriters | Ecommerce-Bank-Auditor |
| banking, payments, credentials, auth, PII, data exposure, uploads, webhooks | Security |
| contracts, offers, leases, operating agreements, ICA, consent, liability, terms | Legal-Reviewer |
| performance, scalability, slow pages, function-timeout, query cost, bundle size | Performance-Optimizer |
| database migration, DDL, schema change, backfill, constraint/enum, data integrity, prod-vs-sandbox drift | Data-Migration-Reviewer, Security |
| test coverage, missing unit tests, e2e, regression risk, "is this proven?" | QA-Tester |
| external / third-party integrations (Tesla, banking APIs, other vendor APIs) | Security, Performance-Optimizer (and flag a dedicated integration specialist if the work is deep) |

If the task's domain is NOT covered by any specialist above, that is a **gap** — see "No good match → propose an expert BEFORE final advice".

## Adding a specialist
Specialists are **content templates**, not registered agents (a new agent file only wakes up next session). To use one **now**:
1. Read the matching template in `.claude/skills/council/specialists/`.
2. Spawn a `general-purpose` subagent with that template's text as its prompt, filling in the task scope. It runs this turn — no reload needed.

**Commands the user may say:**
- `/council with CPA` (or "add a CPA") → convene the 3 core + run the CPA-IRS template inline this turn.
- `@add-specialist <Name>` → create a new reusable template file in `specialists/` from `_TEMPLATE.md` (a plain content file, usable immediately by reading it) AND offer to register a permanent subagent for next session.

## No good match → propose an expert BEFORE final advice (self-memory rule)
Before running the Council on a plan, check the routing table. If no specialist cleanly covers the task's domain, you must — BEFORE the final recommendation — **propose an expert and say so in one plain line with the exact command**, e.g.:
> "No specialist covers <domain>. I can pull one in NOW for this task with `/council with <Name>` (temporary, this session) or make it permanent with `@add-specialist <Name>`."
Then either pull in the proposed temporary expert for the review, or explicitly flag the gap — never deliver final advice on an uncovered domain as if it were covered, and never silently skip it. Keep specialists **modular and easy to extend** (one template per lens). The only thing forbidden: silently auto-persisting a *permanent* specialist file without Antonio's nod. Proposing (temporary or permanent) is required; surface the gap and let Antonio choose whether to make it permanent.

## Reviewer contract (enforced)
Every reviewer is read-only (Read/Grep/Glob) and must return a concrete cited finding OR an enumerated "checked X/Y/Z, none found". "Looks good" is banned. The Senior Engineer specifically CANNOT approve — it only reports defects or none-found. Divergence lives in **different evidence + disjoint checklists**, not job titles.

See `PROTOCOL.md` in this folder for the standing rules the session should reload each session.
