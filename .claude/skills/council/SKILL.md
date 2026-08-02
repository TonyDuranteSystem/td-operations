---
name: council
description: Convene the Council of Reviewers — five independent read-only core reviewers (Senior Engineer, AI Architect, Project Director, Bug Hunter, System Counselor) plus topic specialists — to adversarially review a non-trivial plan, design, or code change before it reaches Antonio. Use when the user says /council, asks for a review/second-opinion, or before presenting any significant plan or shipping any non-trivial change. Skip for trivial edits and casual chat.
---

# Council of Reviewers

A parallel red-team harness, not a voting body. It exists to catch — before Antonio sees a plan — what a single pass misses, by giving each reviewer an **independent context window**, a **disjoint lens**, and a **falsifiable-output contract**. The Council NEVER authorizes anything: Antonio's explicit "go" is the only gate. The Council only shapes the plan.

## When to convene (size gate — mandatory)
- **Convene** for: a real plan or design decision, a non-trivial code change, anything touching money, client-facing sends, irreversible actions, tax/legal/compliance, or sandbox-vs-prod risk.
- **Do NOT convene** for: casual chat, a one-line typo/copy fix, a pure lookup, or anything the existing operating contract already calls "skip the ritual". Convening a 4-agent fan-out for trivial work is the exact token waste this design was reviewed to avoid.

## Council tiers (cost control)
Pick the smallest tier that fits the stakes — every reviewer is a cold-context Opus subagent and costs real tokens. **Measured, not estimated (2026-08-01, the pass that reviewed this very change):** a `light` pass of 4 reviewers over a documentation-sized diff cost **569K subagent tokens** (126K + 144K + 110K + 188K). Earlier "~380K for a full pass" figures in these files were guesses and were LOW; scale from measurements you log (step 2), never from a remembered number. The tier is chosen two ways — an **explicit modifier the user types wins**; otherwise pick by **stakes**. NOTE: the **Bug-Hunter and the System Counselor are permanent CORE reviewers — present in every tier, including light.**

| Tier (how the user asks) | Reviewers spawned | Use for |
|---|---|---|
| **light** — `/council light` / "quick council" | 4: `senior-engineer` + `project-director` + `bug-hunter` + `system-counselor` | low-risk changes, a quick sanity check, reviewing the council's own tooling |
| **standard** — `/council` | 5 core: `senior-engineer` + `ai-architect` + `project-director` + `bug-hunter` + `system-counselor` | a real plan or design decision with no special domain |
| **full** — `/council full` | 5 core + the routed topic specialists (table below) | anything touching money, tax, client data, compliance, contracts, or client-facing/irreversible actions |
| **deep** — `/council deep` | full + a single adversarial refute pass on each blocker | highest-stakes / hardest calls where a false finding is costly |

**Tier defaults by stakes (when the user gives no modifier):**
- trivial edit / casual chat → **no council** (size gate).
- low-risk change → **light**.
- a real plan, no money/client risk → **standard**.
- touches money / tax / client data / CRM-portal / compliance / irreversible / sandbox-vs-prod → **full** (never default these down to light).

**The one-specialist tiebreaker is NOT deep-exclusive** — it applies to every standard/full/deep pass whenever the core reviewers genuinely disagree (step 5). `deep` adds one thing on top: an **adversarial refute pass**. That is NOT vote-tallying (that violates the no-voting rule) — it is ONE independent attempt to refute each blocker, to weed out a false positive before it reaches Antonio. **Guardrails:** a refute may downgrade a blocker ONLY on concrete contradicting evidence (file:line); any ambiguity resolves in favor of the blocker still halting; and a refuted blocker is STILL surfaced to Antonio in the synthesis (never silently dropped). **In light mode** (4 reviewers — no AI Architect) the tiebreaker is optional — disjunctive escalation alone governs, and a genuinely contested finding escalates the tier rather than pulling a tiebreaker.

## How to run it (choreography — the main session is the coordinator)
1. **Auto-select the team from the task** (the user should not have to name experts): read what the task touches, then pick the tier + route by topic using the table below. **The Bug-Hunter and the System Counselor are permanent CORE reviewers — always present, every call, every task.** If the task is a bug / issue / defect / investigation / audit, you ALSO run the two-phase Bug flow (below), not a single pass. The main session (you) reads the table and picks the specialists — do NOT spawn a separate agent just to pick agents.
   - **Bug flow (bugs & investigations):** Phase 1 — convene **the core reviewers (Bug-Hunter leads the hunt; the System Counselor is consulted EARLY for context and correctness) + routed specialists** to INVESTIGATE and return concrete cited findings (file+line, repro, root cause); you verify the key facts yourself (R093). Phase 2 — form a proposed fix plan, then the **5 core reviewers (Senior Engineer + AI Architect + Project Director + Bug-Hunter + System Counselor) review it** before it reaches Antonio — it CLEARS when no core reviewer returns a cited blocker (SE + Bug-Hunter are approval-incapable, contributing findings not a vote; the System Counselor returns MISMATCH-or-aligned, which is a premise check and not an approval; Architect/Director may approve/improve); any cited blocker → revise. Only the internally-approved plan is shown to Antonio. (See PROTOCOL.md "Bug / investigation flow".) **Precedence:** a genuinely trivial one-line fix skips the council entirely (size gate). Once convened, **Phase-2 approval is always the 5 core regardless of tier** — the tier only scales Phase-1 specialist breadth.
   - **Consult the System Counselor EARLY — and "early" is MECHANICAL, not a wish.** Two cases, pick by whether the plan already exists:
     - **The plan is not yet written** (a feature to design, a bug to investigate, a migration to scope): spawn the System Counselor **ALONE as wave 1** (plus the Bug-Hunter if it is a bug — it leads the hunt). Wait for it. Only when it returns ALIGNED — or after you have re-grounded on a MISMATCH — do you spawn the rest. This is the case its seat exists for: a wrong premise caught here saves the whole pass.
     - **The plan/diff already exists and you are reviewing it** (this is most `/council` calls): it rides the same parallel wave as the others, and a MISMATCH from it **outranks the other findings** — you re-ground and re-form before weighing anything else, even if the others returned clean.
     Feed it the task, the plan text, and the real diff; it reads `SYSTEM-KNOWLEDGE.md` plus the authoritative sources for what the task touches.
2. **Spawn the tier's reviewers in parallel**, one message, multiple Agent calls:
   - light = `senior-engineer` + `project-director` + `bug-hunter` + `system-counselor`; standard/full/deep = the 5 core (`senior-engineer`, `ai-architect`, `project-director`, `bug-hunter`, `system-counselor`), plus topic specialists for full/deep.
   - **If a core reviewer's subagent type is not available** — agent files DO hot-reload within a session (verified 2026-08-02 against the Claude Code docs: the watcher picks up a new or edited `.claude/agents/*.md` within seconds), with two exceptions: creating the FIRST agent file in an `agents` directory that did not exist at session start, and sessions started with slash-commands disabled. Also note a reviewer whose `tools:` list names an MCP server that is not connected on this machine may fail to spawn. In any of those cases, do NOT silently run a short bench: run that reviewer INLINE this turn by spawning a `general-purpose` subagent whose prompt is the body of its `.claude/agents/<name>.md` file, exactly as specialists are run. Say plainly in the synthesis that it ran inline. Never log "5 core" while only 4 actually ran.
   - Give each the exact scope. **Auto-feed the real change** — pass the actual `git diff` (or the plan text) into each reviewer's prompt rather than a hand-summarized scope, so they reason on ground truth. Require file+line citations.
   - **After the pass, log the verdict AND its token cost** to the active dev-tracker job via `dev_task_update` as a progress entry (R112): reviewers + tier + GO/FIX-FIRST + any blockers, plus the pass's **total token cost** — sum the `subagent_tokens` the harness reports in each reviewer's Agent-tool result metadata (NOT the reviewer's prose). If that metadata isn't available, record "tokens: unavailable" — never guess a number (R093). This keeps the review trail AND makes the cost/value of each council pass visible over time.
3. **Collect the structured outputs.** Each reviewer returns a defect/concern list or an enumerated "none found".
4. **Escalate disjunctively.** If ANY reviewer returns a concrete, cited blocker → the plan is "fix first". No vote counting, no unanimity. The valuable signal is "did anyone find a blocker", not "did everyone bless it".
   - **A cited MISMATCH from the System Counselor STOPS AND REDIRECTS the pass.** It is not one finding among many to be weighed at the end: the premise is wrong, so re-ground first (open the source it cites), re-form the plan or the investigation, and only then continue. Conditions: it must be cited to a source read this run, that source must be **date-checked and not superseded** (a stop resting on a stale doc is a false stop — the most expensive error this seat can make), and it must name the redirect (where to look / what to use instead); an uncited or hedged concern is an orientation note, not a stop. **The stop is overridable by fresher evidence:** if you can show a more recent source — or the code itself — contradicting the citation, the stop is void, you proceed, and you fix `SYSTEM-KNOWLEDGE.md` in the same change. Say plainly when you override. Unlike the other reviewers it can check the live system itself, so treat "I could not verify that" from it as a real signal — it means the thing genuinely is not queryable, not that it lacked access. A stop never authorizes anything and never overrides Antonio.
5. **If the core reviewers disagree significantly, pull in ONE tiebreaker specialist** (per PROTOCOL.md) — chosen for the domain of the disagreement — to review the contested point with fresh evidence BEFORE the final recommendation. Capped at one extra reviewer. Do not smooth a real split over silently.
6. **The Project Director writes the plain-English synthesis** for Antonio: bottom line, any disagreement between reviewers (and how the tiebreaker resolved it), the single most important finding, and go / fix-first / stop.
7. **Escape hatch.** The main session may override a "no findings" result and proceed, or discard a reviewer's noise — the Council advises, it does not block obviously-correct work. Say so plainly when you override.

## Topic → specialist routing table
Match on meaning, not exact keywords — the phrases are cues, not a whitelist. Pull in every row the task plausibly touches (a change can hit several).

| If the task involves… | Pull in these specialists (beyond the 5 core — Bug-Hunter and System Counselor are already core) |
|---|---|
| **a BUG / issue / defect / investigation / audit** (from you or a dev-tracker job) | (Bug-Hunter + System Counselor are already core, always in) + the routed specialists below → run the two-phase bug flow (investigate → 5-core internal approval) |
| **"how does this actually work here?" / "does this already exist?" / business-flow or convention correctness / a plan resting on how the system or business behaves** | (System Counselor is core — already answering this on every task); add Business-Analyst when the question is about workflow fit or requirements rather than fact |
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
| hard-to-find bugs, edge cases, race conditions, boundary/off-by-one, failure modes, "what could break in production" | (Bug-Hunter is core — already hunting on every task); add QA-Tester for high-stakes coverage/regression |
| external / third-party integrations (Tesla, banking APIs, other vendor APIs) | Security, Performance-Optimizer (and flag a dedicated integration specialist if the work is deep) |
| cross-border tax, foreign-country tax exposure, VAT/permanent establishment abroad, foreign tax residency, client relocation, dividends + moving countries, visa status | Foreign-Tax-Treaty-Reviewer, Immigration-Visa-Reviewer (and CPA-IRS if the US side is also touched) |

If the task's domain is NOT covered by any specialist above, that is a **gap** — see "No good match → propose an expert BEFORE final advice".

## Adding a specialist
Specialists are **content templates**, not registered agents (a new agent file only wakes up next session). To use one **now**:
1. Read the matching template in `.claude/skills/council/specialists/`.
2. Spawn a `general-purpose` subagent with that template's text as its prompt, filling in the task scope. It runs this turn — no reload needed.

**Commands the user may say:**
- `/council with CPA` (or "add a CPA") → convene the 5 core + run the CPA-IRS template inline this turn.
- `@add-specialist <Name>` → create a new reusable template file in `specialists/` from `_TEMPLATE.md` (a plain content file, usable immediately by reading it) AND offer to register a permanent subagent for next session.

## No good match → propose an expert BEFORE final advice (self-memory rule)
Before running the Council on a plan, check the routing table. If no specialist cleanly covers the task's domain, you must — BEFORE the final recommendation — **propose an expert and say so in one plain line with the exact command**, e.g.:
> "No specialist covers <domain>. I can pull one in NOW for this task with `/council with <Name>` (temporary, this session) or make it permanent with `@add-specialist <Name>`."
Then either pull in the proposed temporary expert for the review, or explicitly flag the gap — never deliver final advice on an uncovered domain as if it were covered, and never silently skip it. Keep specialists **modular and easy to extend** (one template per lens). The only thing forbidden: silently auto-persisting a *permanent* specialist file without Antonio's nod. Proposing (temporary or permanent) is required; surface the gap and let Antonio choose whether to make it permanent.

## Reviewer contract (enforced)
Every reviewer is read-only and must return a concrete cited finding OR an enumerated "checked X/Y/Z, none found". Four of them read the repo only (Read/Grep/Glob); the **System Counselor also holds live READ tools** — production database (reads only), CRM, knowledge base, SOPs, catalog, offers, service deliveries, deadlines, documents, Drive, dev board, code search — because its questions are about live reality, not about the diff. It holds no write, send, or DDL tool, and a PreToolUse guard (which fires inside subagents too) blocks schema changes and gates SQL writes regardless. "Looks good" is banned. The Senior Engineer specifically CANNOT approve — it only reports defects or none-found. Divergence lives in **different evidence + disjoint checklists**, not job titles.

**The five core lenses are deliberately disjoint** — if two reviewers are saying the same thing, one of them is off its lane:
- `senior-engineer` — is the code correct and safe?
- `ai-architect` — is the design the right shape, and is there a simpler one?
- `project-director` — what is the operational/business risk, and in what order should this ship? (writes the synthesis)
- `bug-hunter` — how do I break this in production, for a real TD client?
- `system-counselor` — **is any of this even true about our system and our business?** Does it already exist, is it looking in the right place, does it contradict how things actually work today or a decision already taken? It reviews PREMISES, not craft, and it settles business questions by **querying the live system** rather than quoting a document. Its knowledge file (`SYSTEM-KNOWLEDGE.md`) is an index to those sources, never evidence; it states which environment every fact came from (its tools read production).

See `PROTOCOL.md` in this folder for the standing rules the session should reload each session, and `SYSTEM-KNOWLEDGE.md` for the System Counselor's living 360° map (system + business + what changed + where to look). **Keep `SYSTEM-KNOWLEDGE.md` current:** if a change makes a line in it wrong, fix it in the same change — and when the Counselor reports drift in a review, apply the correction then.
