# Council Protocol — standing rules (reload each session)

This is the operating memory for the Council of Reviewers. The SessionStart roster hook prints the current specialist list every session; this file holds the rules that must not drift.

## The five load-bearing rules
1. **Antonio's "go" is the only authorization gate.** The Council shapes plans; it never approves action. No build/edit/run/ship/send without Antonio's explicit yes this turn.
2. **Size-gate every convening.** Trivial edits and casual chat get NO Council. Real plans, money, client-facing, irreversible, tax/legal, or sandbox-vs-prod changes get the Council.
3. **Disjunctive escalation, never voting.** Any one reviewer's concrete, cited blocker → "fix first". No unanimity, no tally. Same-model reviewers can't produce a legitimate unanimous vote anyway; the signal we want is "did anyone find a break".
4. **Divergence by evidence, not titles.** Each reviewer gets a disjoint lens + must cite file:line + must return a falsifiable finding or an enumerated "none found". The Senior Engineer cannot approve.
5. **Surface gaps, don't auto-fill them.** If no specialist covers the task's domain, tell Antonio in one line with the exact add-command; never invent a specialist unprompted, never silently skip a domain.

## Disagreement → tiebreaker (mandatory)
If the three core reviewers **disagree significantly** — e.g. one returns a concrete blocker while another says GO, or they split on whether something is a real defect — do NOT just average them. Before writing the final recommendation, **pull in exactly ONE extra specialist** chosen for the domain of the disagreement (the routing table picks it; if none fits, flag the gap and add one). That specialist reviews the specific contested point with fresh, independent evidence and its finding breaks the tie. Then the Project Director writes the synthesis, naming the original disagreement and how the tiebreaker resolved it. This keeps a real split from being silently smoothed over, and it's the one case where the Council widens itself automatically — capped at one extra reviewer so it can't spiral.

## What is deferred / must NOT be built without a fresh review
- A spawned "coordinator/meta" subagent that picks or invents experts (routing is done inline by the main session off the table).
- Unattended, automatic creation of new specialists.
- Agent Teams experimental mode (no session resume, stalls, higher cost) — revisit only if it leaves experimental.

## Reviewers (core, real subagents)
- `senior-engineer` — correctness & safety of the code; approval-incapable.
- `ai-architect` — design integrity, data-loss/state hazards, simpler alternatives.
- `project-director` — money/irreversible/client-facing/sandbox-vs-prod/compliance checklist + plain-English synthesis; the lead.

## Specialists (content templates, run inline)
Live in `.claude/skills/council/specialists/`. Add with `@add-specialist <Name>` (from `_TEMPLATE.md`). Use now with `/council with <Name>`.

## Cost note
A full Council pass is several parallel Opus subagents, each cold-loading context — real tokens. Fire it for decisions that matter, not routine work. Report the token cost after heavy runs so the value/cost tradeoff stays visible.

## Session-start reflex
At the start of a session that will do plan-level work, and before presenting any significant plan: reload this protocol and the printed roster, and confirm the convened set covers the task's domains (flag any gap per rule 5). Skip this reflex for trivial turns.
