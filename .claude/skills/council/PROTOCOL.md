# Council Protocol — standing rules (reload each session)

This is the operating memory for the Council of Reviewers. The SessionStart roster hook prints the current specialist list every session; this file holds the rules that must not drift.

## The five load-bearing rules
1. **Antonio's "go" is the only authorization gate.** The Council shapes plans; it never approves action. No build/edit/run/ship/send without Antonio's explicit yes this turn.
2. **Size-gate every convening.** Trivial edits and casual chat get NO Council. Real plans, money, client-facing, irreversible, tax/legal, or sandbox-vs-prod changes get the Council.
3. **Disjunctive escalation, never voting.** Any one reviewer's concrete, cited blocker → "fix first". No unanimity, no tally. Same-model reviewers can't produce a legitimate unanimous vote anyway; the signal we want is "did anyone find a break".
4. **Divergence by evidence, not titles.** Each reviewer gets a disjoint lens + must cite file:line + must return a falsifiable finding or an enumerated "none found". The Senior Engineer AND the Bug-Hunter cannot approve (both are destruction-only).
5. **No good match → PROPOSE an expert before final advice (never skip, never silently auto-create).** When a task doesn't cleanly match an existing specialist, the Council must — BEFORE giving its final recommendation — propose either a **temporary** expert (an inline `general-purpose` reviewer built from the closest template / a fresh domain brief, usable this turn) or a **new permanent** specialist (`@add-specialist <Name>` from `_TEMPLATE.md`), and say so to Antonio in one plain line with the exact command. Do NOT deliver final advice on an uncovered domain without either pulling in a proposed temporary expert or explicitly flagging the gap and its command. Keep specialists **modular and easy to extend** — one template file per lens, no bespoke wiring. The one thing still forbidden: silently manufacturing a *permanent* file, or skipping the domain as if it were covered. Proposing (temporary or permanent) is required; auto-persisting a permanent file without Antonio's nod is not.

## Disagreement → tiebreaker (mandatory)
If the core reviewers **disagree significantly** — e.g. one returns a concrete blocker while another says GO, or they split on whether something is a real defect — do NOT just average them. Before writing the final recommendation, **pull in exactly ONE extra specialist** chosen for the domain of the disagreement (the routing table picks it; if none fits, flag the gap and add one). That specialist reviews the specific contested point with fresh, independent evidence and its finding breaks the tie. Then the Project Director writes the synthesis, naming the original disagreement and how the tiebreaker resolved it. This keeps a real split from being silently smoothed over, and it's the one case where the Council widens itself automatically — capped at one extra reviewer so it can't spiral.

## Automatic expert selection (do this BEFORE any council analysis)
The coordinator (the main session, acting as Project Director) selects the team from the task — the user should not have to name experts:
1. **Read the task/context** (what it touches, which code/domain, whether it's a bug/plan/change).
2. **Route** via the SKILL.md topic table — pull in every specialist the task plausibly touches (money/tax→CPA+Finance; DB change/migration→Data-Migration-Reviewer; website/bank→Ecommerce-Bank-Auditor; compliance→Compliance-Deadlines-Auditor; etc.).
3. **The Bug-Hunter is a CORE reviewer — always present on every council call**, whatever the task (bug fix, feature, refactor, plan). So it is inherently included; you never need to "add" it. When the task is a **bug, issue, defect, investigation, or audit** (from the dev-tracker td-dev/td-bug/td-support or that Antonio describes as a problem to solve/investigate), you ALSO run the two-phase Bug flow below. **Precedence — the size gate wins:** a genuinely trivial, obvious one-line fix is exempt from the council entirely (skip it); the council (and therefore the Bug-Hunter) only convenes once a change is non-trivial enough to warrant it.
4. **Pick the tier by stakes** (size gate still applies — trivial one-liners skip the council entirely).
5. If no specialist fits, propose one before proceeding (rule 5).

## Bug / investigation flow (two phases — mandatory for bugs & investigations)
When Antonio shares a bug/issue to solve or asks for an investigation, run this ordered flow — do NOT jump straight to a recommendation:

**Phase 1 — INVESTIGATE (find the truth).** Convene the **core reviewers (the Bug-Hunter leads the hunt) + the routed specialists** (read-only). They produce **concrete, cited findings** — file+line where possible, a concrete repro, root cause. The main session ALSO verifies the key facts first-hand (R093). No fix is proposed yet.

**Phase 2 — PLAN + INTERNAL APPROVAL (before Antonio sees it).** From the findings, form a **proposed fix plan**. Then the **four core reviewers — Senior Engineer + AI Architect + Project Director + Bug-Hunter — must review the plan.** ("Approval" here is the **disjunctive** sense: the plan CLEARS when no core reviewer returns a cited blocker — the Senior Engineer and Bug-Hunter are approval-incapable and contribute findings/none-found, not a positive vote; the AI Architect and Project Director may approve or improve.) Any one concrete cited blocker → revise the plan and re-check. **Only a plan that clears this internal approval reaches Antonio**, presented in plain English with any reviewer disagreement named. Antonio's "go" remains the only authorization to actually change anything.

This is the ACTION complement of the operating contract: the council does the investigation + internal vetting so what reaches Antonio is already stress-tested, not a first draft. **Scale the INVESTIGATION (Phase 1) breadth to the bug** — a small bug convenes Bug-Hunter alone or with one routed specialist; a real production/money/client bug convenes Bug-Hunter + the full routed set. **Phase-2 internal approval is ALWAYS the 4 core reviewers** (Senior Engineer + AI Architect + Project Director + Bug-Hunter), regardless of how small the bug — that is the plan-quality gate and it does not scale down. (If the bug is so trivial it wouldn't survive the size gate, it never enters this flow at all — you just fix it.) So the tier vocabulary (`light`/`full`) governs Phase-1 specialist breadth here, not the fixed 4-core Phase-2 approval. **Note:** a bug reported at `light` tier still pulls all 4 core for Phase-2 (the AI Architect included, even though light's Phase-1 omits it); at that point treat it as a 4-core pass — the tiebreaker is available if the core split.

## What is deferred / must NOT be built without a fresh review
- A spawned "coordinator/meta" subagent that picks or invents experts (routing is done inline by the main session off the table).
- Unattended, automatic creation of new specialists.
- Agent Teams experimental mode (no session resume, stalls, higher cost) — revisit only if it leaves experimental.

## Reviewers (core, real subagents — 4, present on EVERY call)
- `senior-engineer` — correctness & safety of the code; approval-incapable.
- `ai-architect` — design integrity, data-loss/state hazards, simpler alternatives.
- `project-director` — money/irreversible/client-facing/sandbox-vs-prod/compliance checklist + plain-English synthesis; the lead.
- `bug-hunter` — aggressive adversarial failure-hunter (TD-specific hostile scenarios, cross-surface consistency, swallowed errors, multi-condition combos); approval-incapable. Present on every task (bug fix, feature, refactor), not just bugs. Stays distinct from the Senior Engineer (defers generic edge/TOCTOU to SE, flags overlap).

## Specialists (content templates, run inline)
Live in `.claude/skills/council/specialists/`. Add with `@add-specialist <Name>` (from `_TEMPLATE.md`). Use now with `/council with <Name>`.

## Cost note & tiers
A full Council pass is several parallel Opus subagents, each cold-loading context — real tokens (~300–400K). Fire it for decisions that matter, not routine work. **Log every pass's token cost** — sum the `subagent_tokens` the harness reports in each reviewer's Agent-tool result metadata (not the reviewer's prose); if unavailable, record "unavailable" rather than estimating (R093) — to the active dev-tracker job alongside its verdict, so the cost/value tradeoff is visible over time, not just reported once in chat.

**Tiers (see SKILL.md for the table):** `light` = 3 reviewers (senior-engineer + project-director + bug-hunter); `standard` = 4 core; `full` = 4 core + routed specialists; `deep` = full + one adversarial refute pass per blocker. **The Bug-Hunter is CORE — present in every tier including light.** Explicit modifier the user types wins; otherwise pick by stakes — trivial→none, low-risk→light, real plan→standard, money/tax/client-data/CRM-portal/compliance/irreversible→full (never default those down to light). The one-specialist tiebreaker (above) applies to every standard/full/deep pass on disagreement — it is NOT deep-exclusive. `deep`'s refute pass is a single independent refutation attempt per blocker (NOT vote-tallying — that would violate rule 3); it may downgrade a blocker only on concrete contradicting evidence, ambiguity keeps the blocker halting, and a refuted blocker is still surfaced to Antonio. Light mode (no AI Architect) may skip the tiebreaker — disjunctive escalation alone governs.

## Session-start reflex
At the start of a session that will do plan-level work, and before presenting any significant plan: reload this protocol and the printed roster, and confirm the convened set covers the task's domains (flag any gap per rule 5). Skip this reflex for trivial turns.
