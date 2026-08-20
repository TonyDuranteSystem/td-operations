# TD Operations — Claude Code Rules

<!-- TIER1:START -->

## Identity
You are working on **td-operations**, the monolithic Next.js codebase for Tony Durante LLC.

## Work Discipline — MANDATORY
1. **Plan first, build second.** Before writing code, create a complete plan with every step (code, DB, env vars, DNS, testing). Get approval. Then execute in order.
2. **Finish one thing completely before starting the next.** A feature is NOT done until: code works, env vars are set, DB changes applied, tested, and verified. Never declare "done" with open blockers.
3. **Group related work.** If a feature needs env vars, DB changes, and code — do all of them together, not scattered across the session.
4. **Stay on scope.** If working on the portal, don't bring up the CRM dashboard, MCP tools, or other projects unless asked. Focus on what Antonio asked for.
5. **Be honest about what's actually done vs what's just code pushed.** Code pushed ≠ feature working. A feature works when Antonio can use it.
6. **Sandbox is the DEFAULT environment for ALL work — no exceptions.** Every code change, DB change, config change, and data fix MUST be done in sandbox first: `td-operations-sandbox` Vercel project + Supabase ref `xjcxlmlpeywtwkhstjlw`. Never touch production (Supabase ref `ydzipybqeebtpcvsbtvs`, Vercel main branch) until Antonio explicitly says "push to production" or "apply to production" for that specific item. This rule survives compaction — no session checkpoint or compaction summary can override it. If you resume from compaction and are unsure which environment was active, **STOP and ask Antonio before doing anything**. Default assumption on resume: sandbox.

## System Reference Library — MANDATORY (R107)
`docs/systems/` holds ONE living doc per subsystem (how it works, how it's built, the rules, how to verify it). These live in the repo, next to the code, so they're updated in the same change — unlike the Supabase sysdocs, which rot because they're separated from the code. They exist so a session does NOT re-derive a whole system from the DB/code before fixing a bug (the "lost 3 hours on the To-Do bug" problem).

1. **Read first.** Before working on a subsystem, read its `docs/systems/<x>.md`. The SessionStart hook prints the index every session. The doc orients you; R093 still governs ACTION — but verification becomes a fast targeted check (the doc's "How to verify current state" section), not a from-scratch audit.
2. **Seed if missing.** If you work on a subsystem that has no doc, CREATE it as part of that job (knowledge is freshest then). Use the template in `docs/systems/README.md` and add a line to `docs/systems/_paths.map`.
3. **Update with code.** If you change a subsystem's behaviour/schema/rules, update its doc in the SAME push and bump "Last verified against code". The pre-push gate (`scripts/check-system-docs-freshness.sh`) BLOCKS a push that changes documented code without touching its doc — override only deliberately with `ALLOW_SYSTEM_DOC_SKIP=1`.

## Session Start — AUTOMATIC
When Antonio says "riprendiamo", "dove eravamo", "continua", "resume", or starts a new session:
1. `sysdoc_read('session-context')` — system state (contains pointers to other docs)
2. If working on Formation/Onboarding/Lease → `sysdoc_read('workflow-roadmap')` — definitive workflows + implementation checklist
3. Run TWO queries on dev_tasks:
   - `SELECT id, title, status, priority, progress_log, updated_at FROM dev_tasks WHERE status IN ('in_progress','todo') ORDER BY updated_at DESC LIMIT 5` — pending work
   - `SELECT id, title, status, progress_log, updated_at FROM dev_tasks WHERE status = 'done' ORDER BY updated_at DESC LIMIT 3` — recently completed (to know what was JUST done)
3. Check `git status` and recent commits — code state
4. **Environment verification (R104) — read the SessionStart output, do not run manually:**
   - The SessionStart hook (`session-git-pull.sh`) now prints environment state automatically every session: Vercel project, Supabase ref, branch. Read it. Do not re-run the checks manually.
   - `.vercel/project.json` is committed to git with sandbox values — `git pull` resets it automatically on every machine. If it shows `td-operations` (production), the file was manually changed: STOP, run `bash scripts/dev-setup.sh`, do not proceed.
   - `.env.local` is still machine-local. If Supabase ref shows production (`ydzipybqeebtpcvsbtvs`): STOP, run `bash scripts/dev-setup.sh`.
   - The Bash hook (`bash-production-guard.sh`) blocks dangerous commands automatically — `git push origin main`, `npm run dev/build/test` with wrong env, `vercel deploy/build/env pull` against production. These do not require manual vigilance.
   - Production push requires Antonio's explicit approval in chat. Then prefix the command: `ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin main`.
   - **First-time machine setup:** run `bash scripts/dev-setup.sh` once. After that, `git pull` keeps the machine in sandbox automatically.
5. Present a summary organized as:
   - "Last completed:" — what was just finished (from recent done tasks)
   - "Pending:" — what's still pending (in_progress/todo)
   - "Next steps:" — extract from progress_log PENDING entries of the most recent task
   Then ask "What do we work on?"
Do this AUTOMATICALLY without Antonio having to explain what was being worked on.

## Council of Reviewers — convene before significant plans
A standing multi-agent review harness lives in `.claude/skills/council/` (skill: `/council`) plus five real read-only CORE reviewer subagents (`senior-engineer`, `ai-architect`, `project-director`, `bug-hunter`, `system-counselor` — the Bug-Hunter and the System Counselor are present on every call). It is a parallel red-team, NOT a voting body — it shapes plans; **Antonio's explicit "go" is the only authorization gate**.

- **When:** before presenting any significant plan, or before shipping a non-trivial change — especially anything touching money, client-facing sends, irreversible actions, tax/legal/compliance, or sandbox-vs-prod. **Size-gate it:** skip entirely for trivial edits and casual chat (convening agents for small work is wasted tokens).
- **Tiers (cost control):** `light` = 4 reviewers (senior-engineer + project-director + bug-hunter + system-counselor; quick sanity check, low-risk changes); `standard` = 5 core; `full` = 5 core + routed specialists (money/tax/client-data/CRM-portal/compliance/irreversible/sandbox-vs-prod — never default these to light); `deep` = full + one refute pass per blocker. **The Bug-Hunter and the System Counselor are CORE — present in every tier including light.** The one-tiebreaker-on-disagreement applies to every standard/full/deep pass, not just deep. Explicit `/council light|full|deep` wins; else pick by stakes. Auto-feed reviewers the real diff and log the verdict to the dev-tracker job.
- **How:** the main session is the coordinator — read the topic→specialist table in the skill, spawn the 5 core reviewers (plus any selected specialists) in parallel, require file+line citations, and escalate **disjunctively** (any one cited blocker → "fix first"; no unanimity, no tally). The Project Director writes the plain-English synthesis for Antonio, naming any reviewer disagreement.
- **Auto-select the team from the task** — the user should not have to name experts. Read what the task touches and pull in the right specialists automatically. **The Bug-Hunter and the System Counselor are core reviewers — present on every call, every task (bug fix, feature, refactor).**
- **System Counselor (permanent core, consulted EARLY, LIVE READ ACCESS).** The one seat that actually knows Tony Durante LLC as it exists today. **It is not limited to reading files** — its subagent definition grants read-only production tools: the database (reads only), the CRM (accounts/contacts/services/payments/deals/summaries), the knowledge base and SOPs, the catalog, offers, leads, service deliveries and their pipeline, deadlines, tax records, leases/OAs, referrals, documents and Drive, the dev board, and code search. **It is REQUIRED to verify from those live sources rather than trust written knowledge** — quoting a doc when a query was available is the failure it exists to prevent — and it always states which environment a fact came from (its tools read PRODUCTION; sandbox state goes back to the coordinator). It holds no write/send/DDL tool, and the `execute_sql` PreToolUse guard fires inside subagents too, so schema changes are blocked and SQL writes gated regardless. Its lens is PREMISES, not craft: does this already exist, is the session digging in the right place, does it contradict how the business really works today, is it built on something retired or reversed. On every important task (bug, feature, migration, compliance, tax, CRM change) it goes in the FIRST wave, before the plan is shaped. **A cited MISMATCH stops and redirects the work** — halt, re-ground, re-form — but it authorizes nothing; Antonio's "go" is still the only gate. Its index is `.claude/skills/council/SYSTEM-KNOWLEDGE.md`, which **deliberately holds no business facts** (no prices, counts, schemas or client state — those are one query away and a copy would only rot); it holds the live-answer playbook, the invariants, the era markers and the wrong turns. The Counselor is **responsible for keeping it honest** and reports drift on every call for the coordinator to fix in the same change.
- **Bug / investigation flow (two phases):** (1) INVESTIGATE — the core (Bug-Hunter leads; System Counselor consulted early to confirm the hunt is aimed at the right surface) + routed specialists produce concrete cited findings (file+line, repro, root cause); (2) PLAN + INTERNAL APPROVAL — form a fix plan, then the 5 core reviewers approve/improve it before it reaches Antonio; only the internally-approved plan is shown. Antonio's "go" is still the only authorization. **Precedence:** a genuinely trivial one-line fix skips the council entirely (size gate); once convened, Phase-1 investigation breadth scales to the bug but **Phase-2 approval is always the 5 core**.
- **Specialists** (tax→CPA-IRS/Finance-Auditor, CRM→Business-Analyst, web/bank→Web-Auditor/Security, contracts→Legal-Reviewer) are content templates in `.claude/skills/council/specialists/`, run inline via a `general-purpose` subagent this turn. `/council with <Name>` uses one now; `@add-specialist <Name>` creates a new reusable template (permanent registered agent only wakes next session). If no specialist covers the task's domain, flag it to Antonio with the exact add-command — never silently skip a domain, never auto-invent an expert.
- **Deferred (do not build without a fresh review):** a spawned coordinator/meta agent, unattended auto-creation of specialists, Agent Teams experimental mode. Standing rules: `.claude/skills/council/PROTOCOL.md` (reprinted each session by the roster hook).

## Save IMMEDIATELY after EVERY significant action — MANDATORY
When the conversation gets long, Claude compresses old messages (compaction). After compaction, ALL context is lost unless it was saved to Supabase FIRST. This has already caused 2+ hours of lost recovery time. It WILL happen again if you don't save.

A "significant action" = any commit, deploy, DB change, config change, tool fix, or decision made. NOT every 3-5 actions. NOT at end of session. AFTER EACH ONE. The PostToolUse hook will remind you, but don't wait for the reminder — save proactively.

What to save:
1. What was built/changed (files, tools, DB changes)
2. What was deployed (commit hash)
3. What is PENDING (next steps, blockers, decisions needed)
4. Any credentials or config added (reference, not values)
5. Be SPECIFIC: file paths, line numbers, IDs, exact values — after compaction this is all you have.

## Verification Protocol — MANDATORY

### ⛔ R093 — NO ASSUMPTIONS. EVER. (TOP RULE)

**Verbatim from Antonio — 2026-04-17:** *"YOU DON'T HAVE TO ASSUME ANYTHING. DO YOU UNDERSTAND? WITH YOUR ASSUMPTIONS WE RISK TO RUIN THE SYSTEM."*

Do NOT assume ANYTHING. Not column names, not table schemas, not enum values, not file paths, not function signatures, not API behaviors, not workflow semantics, not client state, not past actions, not environment variables, not what something is "probably called," not what a flow "probably does." Not what a column "usually" is. Not what a commit "should" contain. Not what a function "seems to" do.

**Every fact used in a claim, query, or action must be verified by a fresh tool call in the current session.** Examples:
- Before using a column name in SQL → `SELECT column_name FROM information_schema.columns WHERE table_name = 'X'`.
- Before describing what a route does → `Read` the actual file at the actual line range.
- Before citing a commit → `git show <sha>`.
- Before claiming a CI/smoke status → `gh run view <id>`.
- Before referencing a KB/SOP/sysdoc → `kb_search` / `sop_search` / `sysdoc_read` fresh (memory rots).
- Before acting on a client → query portal_tier, auth user, wizard_progress, tasks, gmail sent — ALL of them — then read the workflow sysdoc for the actual flow.

**Why this rule is absolute:** an assumed column name returns wrong data. An assumed workflow triggers the wrong action on a real client. Assumptions are indistinguishable from facts in their output — the only defense is citation. Wrong claims waste Antonio's time; wrong actions can ruin production state, send incorrect emails to clients, corrupt pipelines, duplicate records, or misstate money.

When in doubt: **STOP. Verify. Quote the source.** If you cannot cite file+line / table+column / tool output from this session, do not say it and do not act on it. "I haven't verified this yet — let me check" is always the right next sentence.

**Source conflict detection — MANDATORY before any summary (2026-04-26):** Claude-authored documents (session-context, checkpoints, progress_log, MEMORY.md) are HINTS, not facts. When building a summary or set of findings, you MUST explicitly compare document claims against live sources (git, DB query, file read) covering the same topic. If they conflict, the live source wins — always. The document is stale. You MUST flag the conflict, state the correct live-source fact, and update the stale document. Running a live source tool is not enough — you must actually reconcile its output against what the documents say. **Precedent — 2026-04-26:** session-context said "MMLLC company-as-member PR pending"; git log showed PR #29 merged April 23. Both sources were in the same response. No reconciliation pass was done. The stale document won by default. That is a R093 violation even though the live source was run.

**The automated R093 verifier hook is not ground truth either (2026-08-19).** The Stop-hook verifier that audits replies against session evidence can itself hallucinate — invent a review that never ran, or misattribute a finding to code that has already been fixed. When it blocks a reply with a specific citation (a file, a call site, a named review), the correct response is to check that exact claim against the live code or the live task list before either accepting it into the reply or dismissing it — never relay it unchecked, and never wave it off unchecked either. **Precedent — 2026-08-19 (lease/OA signer fix session):** the verifier twice alleged a specific unresolved defect, citing a review that turned out not to exist — once a nonexistent "AI architect review" claiming 4 lease-creation sites still bypassed a fix, once a nonexistent "orientation agent" claiming 3 sites still misclassified multi-member companies. Both citations named exact files; both were checked directly against the current code in the same turn and were false — the fixes were already live. Treating a verifier citation as automatically true would have relayed a false regression to Antonio; treating it as automatically false would violate R093 just as badly.

### ⛔ R101 — DEVIL'S ADVOCATE MANDATORY (sibling of R093, 2026-04-21)

**Verbatim from Antonio — 2026-04-21:** *"you don't have to assume or look for shortcut or be lazy. You must do always the devil's advocate of everything."*

Before presenting ANY plan, recommendation, decision, or action proposal, you MUST internally answer all five questions honestly. If you cannot, do not reply yet — investigate more.

1. **What am I assuming?** Enumerate. If your list is short, look again.
2. **What did I consider and reject?** If nothing, you haven't thought hard enough. Name at least one alternative and why it lost.
3. **How is my chosen approach weak?** Name the strongest argument against your own proposal.
4. **What did I VERIFY vs what did I ACCEPT?** Every factual claim traces to a fresh tool call this session (R093) or is flagged unverified. Accepting a fact because it "sounds right" is a violation.
5. **Am I picking this because it's easier to WRITE, or because it's actually BETTER?** Path of least resistance in plans = silent quality degradation.

**Why R101 is necessary even with R093 in place:** R093 bans assumptions about facts. R101 bans the related failure of accepting the first reasonable-seeming plan without challenging its shape. You can honor R093 (no assumed facts) and still ship a lazy plan by failing to stress-test the approach itself. That failure mode is specifically what R101 closes.

**How to apply:** fires on every plan, proposal, decision sheet, or recommendation — architectural AND tactical. Includes: sample selection ("one MMLLC client" is a shortcut; a diverse panel covering SMLLC/MMLLC/exceptions/multi-service is devil's-advocate), scoping, verification (asking the user when a tool call would answer), framework choice, cost estimation, and any proposal Antonio could accept or reject. Applies equally to v1 TD Operations and Smart AI TD Operations.

**Precedent:** 2026-04-21 Smart AI v2 planning session. I (a) asked Antonio to confirm Supabase ref `tapbgvbglqacamhayfel` when grep + curl would have verified it in 30 seconds, and (b) proposed ONE MMLLC client for the S0.8 verification exit gate without challenging whether one-of-one-type was sufficient (answer: a real panel needs variety — SMLLC/MMLLC, clean/exception, active/stuck/closed, single/multi-service). Both were shortcuts disguised as reasonable plans. Both wasted Antonio's time.

**Enforcement:** this rule alone is insufficient — rules against laziness are easy to violate silently. A blocker tool (`plan_challenge`) is being specified as a dev_task to require a structured challenge record before significant proposals reach the user. Until it ships, this banner is the line of defense.

### Verify Before Claiming
Before making ANY technical claim about how the system works (data flow, architecture, what a feature does, why something is broken), you MUST:
1. **Read the source first** — `sysdoc_read('session-context')`, `kb_search`, relevant sysdocs, dev_task_list, and the actual code (file + line number)
2. **Show your evidence** — Every claim must be BACKED by a verified citation (file + line, or table + column, or doc + section). No citation = don't say it. The citation lives in your internal record (dev job, checkpoint) or the reply's "Technical details" footer — NEVER in the reply body ("Present Plainly" below governs what Antonio reads).
3. **Name your assumptions** — If you haven't verified something, say "I haven't verified this yet" — never present assumptions as facts.
4. **Challenge your first answer** — Root cause is usually 2-3 layers deep. Before presenting findings, ask yourself: "What am I assuming that could be wrong?"

This rule applies to EVERY conversation — not just audits, not just when asked. If you make a wrong claim that wastes Antonio's time reading and correcting it, that is a failure.

### Present Plainly — MANDATORY
The verification rules above govern **INTERNAL reasoning** (the tool calls and citations you check before claiming something). They do NOT dictate how you **write back to Antonio**.

- Default answer: **plain English**. No file paths, no line numbers, no `table.column` syntax, no commit hashes in the main body of the reply.
- Antonio is not an engineer reading source code. If he cannot evaluate a claim without opening a file, you have not explained it yet — **translate before you answer**.
- Citations only on request. If he wants proof ("show me the citation", "where in the code?"), paste the references then.
- Optional footer: a short `Technical details` section at the end may list citations for work items (commits shipped, files changed). Never for explanations of how the system works.
- Rule: **verify strict, present plain**. Internal rigor, external clarity.
- **Match the claim to how it was checked.** Reading code tells you what the code says, not what happens when it runs. Only opening the page, running the query, or reading the actual record proves live behavior — say which one you did. "The code looks like X" is not "I opened it and saw X." "The last note says X" is not "I checked the current record."
  **Real incident (2026-07-31):** a session told Antonio a client-facing form was "a hard dead end" and spent real time scoping its retirement — based only on reading the code, never loading the page. When the page was finally opened, it worked fine. Antonio's decision once shown the corrected facts: leave it as it is, no code change. Reading about something is not the same as observing it.

### Verify Before Acting
Before presenting options, asking questions, or proposing actions that involve client/system data:
1. **Query the database FIRST** — never ask Antonio "does this client have X?" when you can check yourself. Look up portal access, payment status, document state, account details BEFORE presenting options.
2. **Never assume — verify** — if you need a fact to make a decision (does the client have portal access? was the email sent? is there an existing offer?), QUERY the system. Do not guess, do not ask Antonio to confirm things you can check programmatically.
3. **Be the devil's advocate** — before executing any action, actively look for conflicts, edge cases, and reasons it might fail. Check: is there a duplicate? Was this already done? Will this break something else? Surface problems BEFORE they happen, not after.
4. **Present findings, not questions** — instead of "Should I check if they have portal access?", check it yourself and say "They have portal access (tier=active, account: XYZ LLC)." Antonio's time is not for answering questions the system can answer.

Every question you ask that could have been answered by a database query is a failure.

### Check Before Acting
Before proposing or executing ANY client-facing action (sending emails, creating documents, advancing pipelines):
1. **Check CRM tasks** for the client — see what's already done vs pending
2. **Check Gmail sent** — search for recent emails to the same recipient
3. **Check session_checkpoints** — see if another session already completed the action
NEVER assume a task is pending just because it's on your todo list. Another session/machine may have already done it.
The `gmail_send` tool has built-in duplicate detection (7-day window on same recipient+subject), but you must ALSO check before even proposing the action.

## CRM Update Rule — MANDATORY
Every client-facing action MUST be followed by an IMMEDIATE CRM update in the SAME operation. Never wait to be asked.
Client-facing actions include: sending emails, creating/uploading documents, generating forms, changing statuses, making calls.
What to update:
1. **Account notes** — append a dated log entry (e.g., "2026-03-17: OA + ICA sent for review")
2. **Task** — create or update a task reflecting the current status (e.g., "Waiting" for client response)
3. **Record status** — update relevant record statuses (e.g., offer sent, lease sent, OA viewed)
If you send an email and don't update the CRM, that action is INCOMPLETE. Antonio should NEVER have to remind you.

## Decision Propagation — MANDATORY
When a decision is made, classify it into ONE of 3 categories and propagate to the targets for that category. If ambiguous, treat as all three.

**CATEGORY 1 — BEHAVIOR (how Claude acts)**
Examples: new verification rule, new output format, new tool-use policy
Targets: CLAUDE.md + `lib/mcp/instructions.ts` + `docs/claude-connector-system-instructions.md` + session-context + session_checkpoint
Not a target by default: `.claude/hooks/user-prompt-contract.sh` (the per-turn contract). It is a deliberately hand-shortened, independently-worded condensation, not a mirror — edit it only when the per-turn nudge itself needs to change, and check `docs/systems/hooks-guardrails.md` first.

**CATEGORY 2 — BUSINESS / SOP (what to do for clients)**
Examples: pricing change, new workflow step, compliance rule change
Targets: Master Rules KB + sop_runbooks + session-context + session_checkpoint

**CATEGORY 3 — SYSTEM / INFRA (what's running where)**
Examples: new integration, config change, env variable, infrastructure update
Targets: session-context + session_checkpoint

ALWAYS update session-context and session_checkpoint regardless of category.

**LAST STOP — the System Counselor's index** (`.claude/skills/council/SYSTEM-KNOWLEDGE.md`), for the NARROW set of changes that affect it: a subsystem created or **retired**, a decision **reversed**, a new engine/pattern, a changed "where to look for X", or a structural change to how the business is organised. Add or amend the era marker / playbook row in the SAME change and bump the file's date. **Deliberately NOT a target for:** a price change, a new SOP version, a new service type, a schema change, or any other live value — that file holds none of them by design, because the Counselor queries the live source instead. If you are unsure whether a change touches it, it almost certainly doesn't.

## Communication
Always communicate in English. Be direct and efficient.

## Run unit tests after every code change — MANDATORY
Before saying "it works" or "done", run `npm run test:unit`. If you didn't run tests, it's NOT done.

## Workflow System — conventions (Slices 0-13 + flexibility pass + editor — LIVE ON PRODUCTION since commit `1dfb55c8`; do not re-flag as "not yet on production")

Full design: `sysdoc_read('workflows-system-master-plan')`. Current state + extension cookbook: `sysdoc_read('workflows-system-slices-8-10-final-state')`. These rules are the minimum a session needs.

- **Catalog-driven.** Workflows, actions, SLA values, escalation behavior, follow-up task copy — all in `catalog_entries.metadata` (JSONB). Adding a new banking provider / SD-lifecycle workflow / catalog row variant is pure SQL.
- **Three trigger sources** (discriminated union in `lib/tasks/workflow-trigger-schema.ts`): `form_submission` (Slice 8), `sd_created` (Slice 9). Chained workflows use `chain.spawn_next_workflow` (ITIN pattern).
- **`createSD` hook** in `lib/operations/service-delivery.ts` fires `dispatchWorkflowForSdCreated` after every SD insert. Fire-and-forget try/catch.
- **Dispatcher slug rule** (carved-in-stone after the `cf0cb867` bugfix): every site that stores a `workflow_snapshot` MUST go through `buildSnapshotForStorage({ slug, metadata })` from `lib/tasks/workflow-snapshot-schema.ts`. The helper merges slug from the catalog row's `slug` column into metadata so `parseWorkflowSnapshot` accepts it at render time. Three sites use it today: both dispatchers in `dispatch-workflow-for-event.ts` and `getWorkflowCatalogRow` in `chain-transitions.ts`. NEVER hand-roll `{ ...metadata, slug }` again — the helper is the single source of truth.
- **Task title / description templates** (workflow flexibility pass): catalog rows can carry `task_title_template` + `description_template` (token syntax `{name}` via `lib/template-interpolation.ts`). Dispatcher interpolates against `(submission ∪ task_meta)` context for form_submission triggers and `(delivery ∪ task_meta)` for sd_created. Missing-token failure (`interpolateStringStrict` returns null) → falls back to caller-provided literal + warn log. Backfilled for banking_review_{payset,relay} / tax_form_review / closure/formation/onboarding_progress in `20260517-2200-workflow-templates-and-snapshot-refactor.sql`. itin_review intentionally keeps caller-side title (runtime `docsGenerated` boolean isn't templatable).
- **Snapshot pinned at task creation.** Catalog edits never affect in-flight tasks. To retro-update in-flight, write a `jsonb_set` migration.
- **Visibility predicate** (Slice 9): per-action `visible_when.sd_stage` filters TaskCard render. Reads `task_meta.sd_stage` (seeded by dispatcher at spawn, kept in sync by `chain.advance_sd_stage` via task_meta_patch). Defensive actions (Blocked / Needs Fix) should NOT have `visible_when` so they're always available.
- **SLA escalation behavior is catalog-driven** (Slice 10): `sla.auto_reassign` default true, `sla.notify_email_to` default "support@tonydurante.us" (set "" to suppress email). `WORKFLOW_SLA_DRY_RUN=true` env var disables writes during rollout.
- **Idempotency / TOCTOU pattern (B9 mitigation):** operations helpers shared between MCP tools and workflow handlers (`banking-review.ts`, `tax-review.ts`, `closure-review.ts`) use `reviewed_at IS NULL` short-circuit + `.is('reviewed_at', null)` TOCTOU guard on the UPDATE. Always pair both.
- **Webhook retry idempotency:** auto-chain routes pass `idempotency: { field: 'submission_id', value: sub.id }` to `dispatchWorkflowForFormCompletion`. SD-created hook uses task_meta.service_delivery_id automatically.
- **PostgREST JSONB nested paths** use UNQUOTED keys: `.eq("metadata->triggered_by->filter->>service_type", value)`. SQL-native `'filter'` quotes don't work in supabase-js. Caught during Slice 9 stress QA.
- **Time-travel cron testing:** `decideReminder` / `decideSlaTier` take explicit `now: Date` arg. Tests pass `hoursAfter(task, N)` rather than mocking system clock. Pattern for any future cron eligibility helper.
- **Stress QA must include browser-based render verification**, not just DB+curl back-end checks. The slug bug only manifested at TaskCard render time and would have shipped to production if Slice 10 hadn't included a browser walkthrough.
- **Default task assignee** lives in `lib/tasks/default-assignee.ts` (`defaultTaskAssignee()`): reads `DEFAULT_TASK_ASSIGNEE` env, falls back to `"Luca"`. Every fallback site (legacy plain-task paths in form-completed routes, createSD's params default, sd-mark-complete handler) uses this helper. Workflow paths still prefer the per-row catalog `default_assignee` first; this helper is the final fallback only. Rotating the default (vacation coverage, ownership change) = single Vercel env update.
- **SLA state constants** (`SLA_STATE` + `SLA_META_KEYS` exported from `lib/tasks/sla-eligibility.ts`) — used by both the cron writer and the TaskCard reader. Never string-literal `"warn"` / `"escalated"` / `"sla_state"` etc. directly; import the constants so a typo is a TS error, not a silent UI bug.
- **Catalog validity check** (`lib/tasks/catalog-validity.ts::validateWorkflowCatalog`) — pure-function deploy gate that asserts every active `task_workflows` row's `handler` / `attachment_template` / `task_meta_schema` references resolve to registered code-side identifiers, that the snapshot itself parses cleanly, that each action's `handler_params` parses against the handler's registered Zod schema, and that no two active workflows match the same trigger fingerprint. DI'd registries so vitest stays DB-free. One-shot runner at `scripts/check-catalog-validity.ts`. The Publish action in the workflow editor runs this gate before flipping status to active.
- **Workflow editor** (`/workflows`, admin-only) — author/edit/publish workflows from the UI without SQL. Single source of truth for `handler_params` Zod schemas lives in `lib/tasks/handler-param-schemas.ts` (pure Zod, client-safe — handler modules re-export from there). The editor's per-action form auto-renders from these schemas via `lib/forms/schema-introspection.ts` + `components/forms/schema-form.tsx`. Adding a new handler = add its schema to the central file + register the function in `workflow-registry.ts` + register the schema in `workflow-handler-params.ts`; editor picks it up automatically. Save Draft writes `status='draft'` (dispatcher ignores). Publish runs the validity gate first and only flips `status='active'` if clean. Stale-edit detection via `expectedUpdatedAt` in `updateMetadata()`. In-flight task count warning at Publish time (in-flight tasks keep their pinned snapshot regardless of catalog edits).
- **`updateMetadata` framework helper** (`lib/catalog/framework.ts`) — canonical write path for any catalog row's metadata. Writes `catalog_decision_log` row with `action='metadata_changed'` (before/after capture). Optional `expectedUpdatedAt` enables optimistic-concurrency stale-edit detection (throws `STALE_EDIT` with code attached). Optional `status` parameter for publish flow. Use this from any future catalog-editing UI, not raw supabase updates.

<!-- TIER1:END -->

<!-- TIER2:START -->

## Error-Magnet Rules (one-liners)

- **R005** — `td-operations.vercel.app` is INTERNAL: NEVER send this domain to clients. {file:lib/config.ts}
- **R012** — All client-facing URLs MUST use `APP_BASE_URL` from {file:lib/config.ts} — never hardcode domains; the `.husky/pre-push` hook blocks hardcoded domains.
- **R015** — NEVER remove any domain from Vercel — old links must always work.
- **R016** — All URLs, tokens, and slugs must be in English.
- **R018** — NEVER use {tool:execute_sql} for CRM writes — always use {tool:crm_update_record}.
- **R027** — `client_invoices` is for client sales invoices ONLY — TD systems NEVER write here. {table:client_invoices} {file:lib/portal/unified-invoice.ts}
- **R035** — NEVER send a form to a client without testing it first via `?preview=td`.
- **R037** — All MCP send tools MUST use `safeSend()` from {file:lib/mcp/safe-send.ts}: idempotency check → send FIRST → status update AFTER → multi-step tracking. NEVER mark a record "sent" before the actual send operation.
- **R041** — Email Subject headers MUST be RFC 2047 base64 encoded — applies to ALL email senders (API routes, cron jobs, MCP tools, server actions, no exceptions).
- **R051** — Subagents must write results to Supabase BEFORE returning. Chat gets a compact summary.
- **R053** — Before INSERT on {table:dev_tasks}, SELECT first to check if a task on the same topic already exists. If it does → UPDATE. Never duplicate.
- **R060** — Master Rules KB (`370347b6`) is the CANONICAL source for business rules — wins on conflict. {table:knowledge_articles}
- **R067** — When you modify an existing file, fix any ESLint warnings in that file (lint-staged blocks the commit otherwise).
- **R070** — Run `git pull origin main` BEFORE any work, every session (enforced by SessionStart hook `session-git-pull.sh`). **Governs the PRIMARY CHECKOUT. As of 2026-08-10 the hook deliberately does NOT stash or pull in a linked worktree on a feature branch** — it silently removed in-flight work (4 occurrences on one job, one of them hiding a file an already-committed change depended on), and pulling main into a feature branch is a merge decision, not housekeeping. A worktree session that wants main's latest merges it deliberately. Full rationale + the three verified cases: `docs/systems/hooks-guardrails.md` (worktree exemption).
- **R071** — NEVER use `git add -A` or `git add .` — stage specific files by name only. Never commit files you didn't intentionally modify.
- **R076** — NEVER run `git push --force` — branch protection blocks it and it would destroy other machines' work.
- **R079** — Every UI feature MUST be tested in the browser (screenshot + interaction) before declaring it done.
- **R086** — Write unit tests for every new function in `lib/`. Push without unit tests is blocked by the pre-push hook.
- **R089** — Never use Make, Zapier, n8n — all automation via Supabase Edge Functions.
- **R090** — Never commit `.env.local` or credentials.
- **R091** — Never create README.md or documentation files unless asked.
- **R092** — Client invoice emails MUST direct clients to the portal to pay (`portal.tonydurante.us` → Fatture/Invoices → Expenses). NEVER embed Stripe checkout links, wire transfer details, or any payment credentials directly in the email body. The portal's Pay button (dev task `b08fb88a`, `components/portal/td-pay-modal.tsx`) is the canonical payment entry point.
- **R093** — NO ASSUMPTIONS. EVER. Every column name, table schema, enum value, file path, function signature, API behavior, workflow semantic, client state, or past action must be verified by a FRESH tool call in the CURRENT session before use. Assumed column in SQL → wrong data. Assumed workflow → wrong action on real client. **Claude-authored documents are HINTS — when a document and a live source (git, DB, file read) cover the same fact, the live source wins. You must explicitly reconcile them — running the tool is not enough.** See the "R093 — NO ASSUMPTIONS. EVER." banner at the top of the Verification Protocol for the full rule. Antonio's words: *"YOU DON'T HAVE TO ASSUME ANYTHING. DO YOU UNDERSTAND? WITH YOUR ASSUMPTIONS WE RISK TO RUIN THE SYSTEM."*
- **R094** — `leads.status='Converted'` means PAYMENT CONFIRMED (activation chain triggered), NOT offer signed. As of commit `4d5f403` (2026-04-17, P3.4 #1 Commit A, dev_task `d715e5e5`), `offer-signed` webhook no longer flips `leads.status` at sign time — only `converted_to_contact_id` is linked. The `Converted` flip happens in `confirm-payment` / `stripe` webhook / `whop` webhook, after payment is confirmed. Before acting on a lead with status `Converted`, check whether it's fully activated (`pending_activations.status='activated'`) or stuck at `payment_confirmed` (retry path via `lib/operations/activation.ts:activateService`). Signed-but-unpaid leads now stay at their pre-sign status (typically `Offer Sent` or `Qualified`). This matches SOP v7.2 Phase 0 step 12.
- **R096** — MCP TOOL ROUTING — TWO CONNECTIONS, CLAUDE CHOOSES (2026-05-01). Claude Code has two MCP connections: `mcp__td-ops-sandbox__*` (sandbox Supabase, generated by `dev-setup.sh` into `.mcp.json`) and `mcp__af7d85f2-*` (DXT plugin, production Supabase). **During development work** (building features, testing code, verifying migrations, checking sandbox state) → ALWAYS use `mcp__td-ops-sandbox__*` tools. **During operations** (managing real clients, sending emails, CRM updates, checking payments) → use `mcp__af7d85f2-*` tools. EXCEPTION: `session_checkpoint` and `dev_task_*` ALWAYS use `mcp__af7d85f2-*` regardless of session type — work tracking must always persist to production. Antonio never switches anything manually. Claude owns this routing decision and is responsible for violations. The old rule (execute_sql hits production) remains true for `mcp__af7d85f2-*` tools — confirmed 2026-05-01 via audit_flags table check. The entire sandbox enforcement system (`.env.local`, `bash-production-guard.sh`, `.vercel/project.json`, `supabase-admin.ts` ref check) does NOT apply to MCP tools — they are hardwired to the production Vercel deployment via the DXT plugin. There is no PreToolUse hook guarding MCP calls. This means: every `execute_sql` query reads/writes production data; every subagent that calls `execute_sql` hits production; and fixing `.env.local` has zero effect on MCP behavior. For sandbox DB queries use `psql` via Bash with the sandbox connection string. NEVER use `execute_sql` to verify sandbox state, test sandbox migrations, or check sandbox data. NEVER assume "I'm in sandbox" because `.env.local` or `.vercel/project.json` looks correct — those guards are irrelevant for MCP tools.

- **R097** — QB MCP tools REMOVED (2026-04-24, commit `8f9f18a`). `qb.ts` and `qb-expenses.ts` (17 tools) moved to `lib/mcp/tools/deprecated/` and unregistered from the MCP server (the orphaned active copies were deleted 2026-06-03). `lib/quickbooks.ts` and `qb_tokens` table still exist but are not exposed via any tool. Do NOT restore QB tools to the MCP server. Do NOT add automatic QB sync to any new code. **QuickBooks is fully decommissioned/DEAD — kill-switch `QB_ENABLED` OFF since 2026-05-23 (dev_task `eca3ce5c`); `lib/qb-sync.ts` is an inert no-op (every function early-returns before any DB/API call) and `app/api/qb/*` + `lib/quickbooks.ts` are dead code. Treat QB as DEAD: do not treat it as a live part of the system, do not build on it, and do not try to "complete" or re-enable it. The remaining `qb-sync` call sites (Finance actions, invoice auto-send, bank-feed matcher) are harmless leftover plumbing — removing them is a separate planned cleanup (those callers still import `qb-sync.ts`, so naive deletion breaks the build).**
- **R098** — Invoice-number generator is race-safe via DB unique constraint, NOT a retry loop in code. `lib/portal/invoice-number.ts::generateInvoiceNumber` is intentionally simple (max+1) with strict `LIKE 'INV-______'` filter; race safety lives in the partial unique index `uq_payments_invoice_number` (and same on `client_invoices`) plus caller-side retry-on-unique-violation. `createTDInvoice` and `createUnifiedInvoice` are the canonical insert paths — both wrap a 10-attempt retry loop and accept an optional `idempotency_key` for content-level dedup. Standard idempotency keys: `offer-signed:TOKEN:CONTACT_ID`, `annual-installment:ACCT:N:YEAR`, `manual-crm-invoice:ACCT:HASH`. Never restore the timestamp-suffix fallback that produced `INV-NNNNNN-XXXXXXXX` scars (deleted in commit `1dbfa33` after the April-12 collision incident). Never write `invoice_number` directly without going through these helpers.
- **R099** — Surface server errors on client-side `fetch` (2026-04-21, commit `b80ecef`). Any client-side `fetch` to our own APIs must parse the server's JSON body on non-2xx and surface `data.error` to the user, with a sensible fallback. Do NOT collapse every failure into a generic "Failed to send message" / "Upload failed" toast — that hides the real cause from the user AND from us. **Antipattern:** `if (!res.ok) throw new Error('Upload failed')` followed by `catch { toast.error('Failed') }`. **Correct pattern:** `if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Fallback — please try again.') }` paired with `catch (err) { toast.error(err instanceof Error && err.message ? err.message : 'Fallback.') }`. The paired server change: error responses must include actionable detail (actual size in MB for file-size limits, detected MIME type for format rejects, non-technical language for validation/security rejects). Precedent applied to portal chat upload, CRM contact-detail chat, and staff portal-chats inbox — do not regress these, and use the same pattern for any new `fetch`-to-own-API client code.
- **R100** — Client-visible content deletion MUST use soft-delete (2026-04-21, commit `49d64df`). When admins can delete content the client has already seen (portal chat messages, portal notifications, portal documents, and similar), the table must carry `deleted_at TIMESTAMPTZ` + `deleted_by UUID`, the server must filter `deleted_at IS NULL` for every non-admin query so the deleted body/metadata never leaves the server, and the realtime subscription must listen to `UPDATE` (not just `INSERT`) so the client drops the row live without waiting for the refetch fallback. **Admin view:** render a tombstone (e.g. *"Message deleted"* + deleted-at timestamp) so staff can see what was removed without opening the DB. **Client view:** FULLY HIDE the row — no partial "deleted" placeholder to the client, which creates "the portal deleted my message" confusion. Audit lives in the preserved row (`deleted_at`, `deleted_by`, original body). Attachment / storage cleanup is opt-in Phase 2 work, not default. Hard delete only for internal-only tables with no FK chain to client-visible state. Precedent: `portal_messages.deleted_at`/`deleted_by` + `DELETE /api/portal/chat/message/[id]` + partial index `(account_id, created_at DESC) WHERE deleted_at IS NULL`.
- **R101** — DEVIL'S ADVOCATE MANDATORY (2026-04-21). Before any plan, proposal, decision, or recommendation, you MUST internally answer five questions: (1) what am I assuming, (2) what did I consider and reject, (3) how is my chosen approach weak, (4) what's verified vs what's accepted, (5) am I picking this because it's easier to write or actually better. If you cannot answer honestly, do not reply yet — investigate more. Antonio's words: *"you don't have to assume or look for shortcut or be lazy. You must do always the devil's advocate of everything."* R093 bans assumed facts; R101 bans accepting the first reasonable-seeming plan without challenge. Full banner at top of Verification Protocol. Enforcement tool (`plan_challenge`) in progress.
- **R103** — When an admin sends a portal chat message (via dashboard or `portal_chat_send` MCP tool), the client automatically receives an email notification. Implemented in `lib/portal/notifications.ts::notifyClientOfAdminMessage`. Throttled to **1 email per conversation per 2 hours** to avoid spam when multiple messages are sent in a row. The email is bilingual (EN/IT based on `contacts.language`), links directly to `portal.tonydurante.us/portal/chat`, and uses the Tony Durante brand. No manual Gmail follow-up is needed for routine messages — the notification is automatic. (2026-05-04, commit `f737e8ae`, dev task `eabf304c` done.)

- **R104** — SANDBOX IS THE ONLY DEVELOPMENT ENVIRONMENT (2026-05-01, structural enforcement). Three layers prevent production access during development: (1) `.vercel/project.json` is committed to git with sandbox values — `git pull` resets it on every machine automatically, drift is visible in `git status`; (2) `bash-production-guard.sh` PreToolUse hook blocks `git push origin main`, `npm run dev/build/test` with prod URL, `vercel deploy/build/env pull` against production project — fires before every Bash call, cannot be bypassed without modifying committed source; (3) `lib/supabase-admin.ts` hardcoded production ref check — server refuses to start locally if `NEXT_PUBLIC_SUPABASE_URL` contains production ref `ydzipybqeebtpcvsbtvs`. SessionStart hook reports environment state automatically. **You never need to say "sandbox first" — the system enforces it.** Production push only after Antonio's explicit approval: `ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin main`. First-time machine setup: `bash scripts/dev-setup.sh`. **⚠️ CRITICAL GAP — `git push origin main` is NOT sandbox-only (2026-05-01 incident):** The `td-operations` GitHub repo is connected to TWO Vercel projects — `td-operations-sandbox` AND the production deployment. A single `git push origin main` triggers both builds simultaneously. The `bash-production-guard.sh` hook does NOT unconditionally block `git push origin main` — it only blocks it when `.env.local` contains the production Supabase URL, which is not set during development. This means: pushing to main = deploying to production. NEVER push to main without Antonio's explicit "ship it" in chat. Discipline, not tooling, is the only guard here.

- **R105** — ALL DDL MUST GO THROUGH MIGRATION FILES (2026-04-30, structural enforcement). `CREATE TABLE`, `ALTER TABLE`, `CREATE FUNCTION/TRIGGER/VIEW/SEQUENCE/TYPE/EXTENSION`, and `CREATE INDEX` are blocked by `execute_sql` unless `reason` starts with `migration:<filename>`. Pattern: (1) write SQL to `scripts/migrations/YYYYMMDD-HHMM-description.sql`; (2) apply to sandbox: `node scripts/apply-migration.js <file>` — refuses if `.env.local` points to production; (3) Antonio approves → promote to production via `execute_sql(mode: "write", reason: "migration:<filename>")`. NEVER run DDL directly via `execute_sql` without this pattern. NEVER run DDL on production without sandbox test first.

- **R106** — Service/SD vocabulary lives in the catalog framework. The source of truth for service types is `catalog_entries` (`catalog_id='services'`). Code MUST import from `lib/services/index.ts` — never hardcode service type strings. New service types added via `catalog_add` MCP tool or `/catalog` CRM page. `createSD` automatically sets `service_type_entry_id`. LLC Management bundle = 4 SDs defined in `LLC_MANAGEMENT_BUNDLE_TYPES`. Annual Renewal is NOT an SD (billing cycle only). Portal tier: `tierForContract()` in `lib/portal/auto-create.ts`.

- **R102** — Portal tier has exactly 4 values: `lead`, `formation`, `onboarding`, `active`. The value `full` is removed and must never be used. All writes to `contacts.portal_tier` or `accounts.portal_tier` MUST go through `syncTier()` in `lib/operations/sync-tier.ts` — direct column writes are forbidden. `formation` tier = company being formed (no EIN yet); these clients see a formation-specific dashboard. When EIN is received, tier advances to `active` via the "Record EIN Received" button or `enter_ein` action — never advance tier manually. Contact `portal_tier` is computed as the highest tier across all linked accounts; contacts without any account keep their own tier.

- **R107** — SYSTEM REFERENCE LIBRARY (2026-05-29, structural enforcement). `docs/systems/` holds one living doc per subsystem (how it works, how it's built, the rules, how to verify). Lives in the repo next to the code so it's updated in the same change — the reason the Supabase sysdocs rot is they're separated from the code. Purpose: a session reads the subsystem doc instead of re-deriving the whole system from the DB/code before fixing a bug. **Three layers:** (1) SessionStart hook `system-docs-index.sh` prints the library every session; (2) read the relevant doc FIRST before working on a subsystem, and CREATE the doc (template + `_paths.map` line) if it's missing, as part of the job; (3) pre-push gate `scripts/check-system-docs-freshness.sh` BLOCKS a push that changes documented subsystem code without updating its doc — deliberate override `ALLOW_SYSTEM_DOC_SKIP=1`. The doc orients; R093 still governs ACTION (verify the one fact you depend on — fast, via the doc's "How to verify" section). Full section: "System Reference Library — MANDATORY" near the top.

- **R108** — Hermes ↔ Claude BRIDGE (Phase 1, 2026-06-03, dev_task `1a0d1354`). One table (`agent_messages`) + three MCP tools (`agent_msg_send`, `agent_inbox_list`, `agent_inbox_reply`) + one cron worker (`/api/cron/hermes-bridge`, schedule `*/5 * * * *`) implement a research/discussion channel between Hermes (Telegram, mobile) and Claude (sonnet-4-6 worker + Claude Code sessions). Hermes drops research questions; the worker investigates with a **READ-ONLY** tool subset (`lib/ai-agent/worker-tools.ts`) and writes findings back to the same row; Hermes reads the reply and reports to Antonio in plain English. Direct-trigger fires on insert for ~30-90s latency; cron is the safety net for any direct-fire that missed (function killed, network blip, stuck `processing` rows older than 10 min get auto-recovered). **MANDATORY rule — agent_msg_send is a SEND tool. Hermes/Claude must show the full draft (recipient, subject, body verbatim) and wait for Antonio's explicit OK before calling — same rule as `gmail_send`, established after the 2026-06-03 unauthorized-send incident.** Phase 1 is RESEARCH ONLY: the worker has no send/write/mutate tools. **AMENDED 2026-07-10 (Antonio): the action-authorization approval rail (propose_action → approval_queue → 6-digit code → executor) is SWITCHED OFF and abandoned as the forward path. No worker or helper on any surface queues actions or launches/ships coding jobs anymore — one reversible switch (`WORKER_ACTIONS_ENABLED`, default OFF) gates it. The worker sends a message on Antonio's "go" and investigates on his "investigate it"; he does data changes and code himself. Phase 2/3 (re-tiering direct-write tools onto the rail) are CANCELLED. The backend queue/cron/`approval_*` MCP tools stay dormant-in-place (reversible), but are no longer the plan. See `docs/systems/agent-bridge.md` (2026-07-10).** Full section: "Hermes ↔ Claude bridge — handling research messages" below.

- **R109** — SELF-SERVE BEFORE ASKING (2026-06-21). Never ask the user for a fact the system can give you — a client's language (`contacts.language`), email, invoice/payment status, which service they have, any record state. LOOK IT UP first (DB query, CRM search, KB/SOP/sysdoc, the actual file/record), then act. Only ask for a genuine judgment call that's the user's to make (a price, a strategy, an exception). Applies to EVERY AI surface — Claude Code, the MCP/Claude.ai connector (`lib/mcp/instructions.ts` "Verify Before Acting"), AND the Slack worker (`SLACK_WORKER_SYSTEM_PROMPT` ENGINEERING DISCIPLINE block, `lib/ai-agent/slack-claude.ts`). Client-facing drafts go out in the client's CRM language automatically — never ask "which language?". This is the ACTION complement of R093 (don't assume → verify by looking up; don't punt a lookup back to the user). Origin: 2026-06-21, the Slack worker asked Antonio "which language?" for Alessandro Gritti (Evolue LLC) when his CRM `language` was already "Italian".

- **R110** — OFFER WORKTREE TEARDOWN WHEN A JOB SHIPS (2026-06-27). Each Claude Code worktree may run its own isolated local Supabase stack (auto-provisioned by `scripts/worktree-auto-isolate.sh`, ~8 GB RAM each). When a worktree's job is DONE — its PR merged to main, or the user says the work is finished/abandoned — proactively OFFER to tear it down: "Work's shipped — close this worktree and free its database? (`bash scripts/env-down.sh --purge`)". Do NOT auto-run it without confirmation (the user may want to keep poking at it). This is the immediate-cleanup path; the safety net is `scripts/worktree-stack-sweep.sh` (runs backgrounded from the SessionStart hook) which purges any stack whose worktree folder was already deleted — so nothing leaks even if you forget to offer. Only the offer needs you; the sweep is automatic.

- **R111** — WORKER NEVER LAUNCHES OR SHIPS CODE (**AMENDED 2026-07-10, Antonio** — supersedes the 2026-06-30 Antonio-only gate). No worker or helper on any surface may launch or ship a coding job (`start_code_task` / `promote_code_branch`) anymore — `enableCodeTasks` is forced `false` everywhere, and the executor branches also refuse via the reversible `WORKER_ACTIONS_ENABLED` switch (default OFF). The worker investigates a bug on Antonio's "investigate it" and reports a plain-English diagnosis; Antonio does the code himself. This reverses the earlier "keep it, restrict to Antonio" rule at Antonio's explicit direction. The by-hand CRM `/code-tasks` page (manual, admin-only by RBAC) is UNTOUCHED — that's Antonio launching a build himself. Origin of the reversal: Antonio wants the worker to research and report, not build. Full detail in `docs/systems/slack-claude-worker.md` + `docs/systems/agent-bridge.md` (2026-07-10).

- **R113** — ASK THE SYSTEM COUNSELOR FIRST, ON EVERY INVESTIGATION (2026-08-02). Before forming a theory about any investigation — bug, "how does X work", audit, or a feature touching an existing flow — consult the `system-counselor` subagent FIRST, in cheap ORIENTATION mode (how it actually works today · where to look · what already exists · what you're about to get wrong). Then re-check it when your theory forms: it may INTERRUPT and redirect a wrong investigation mid-flight, and a cited redirect stops that line of work until you re-ground. Fires on EVERY investigation — deliberately NOT size-gated like the council, because Antonio chose the token cost over the cost of a wrong investigation. It advises only: read-only, never acts, never authorizes. Origin: Antonio repeatedly having to correct sessions that assume a flow the business doesn't use (e.g. "the form we email the client" when clients actually use a portal wizard). **Him having to supply that correction is a defect, not feedback.** Full section: "R113 — ASK THE SYSTEM COUNSELOR FIRST" below.
- **R112** — DEV-TRACKER BOARD DISCIPLINE (2026-07-11). Every Claude Code session that does dev work (feature/bug/refactor/etc.) MUST be tied to exactly ONE dev job in `dev_tasks` — the durable, compaction-proof record shown on the `/dev-board` board (per-channel: td-dev/td-bug/td-support). **At session start:** run `dev_task_list` and CONTINUE the matching open job (never create a duplicate); if none matches, `dev_task_create` with a `channel`, a **plain-English `summary_plain`** for Antonio, and the technical request (`description`). **As you work, keep it current** via `dev_task_update`: set `findings` when you investigate, freeze `plan` when the plan is approved, advance the `milestone` (non-linear — a QA fail goes back a stage; the board lane derives from the milestone automatically), append stage-tagged `progress_entry` waypoints (what you tried / ruled out), log `decisions`/`blockers`, and keep `summary_plain` in sync with the technical detail so the two never drift. **A bug that surfaces mid-session** becomes a CHILD job (`dev_task_create` with `parent_id`) in the right channel, not a buried note. **Before compaction / at stop:** write the job's structured update so the next session continues cold. Stage sets are catalog-driven per job type (`catalog_id='dev_stage_sets'`; default 7-stage lifecycle + a bugfix lifecycle). This is the ACTION complement of the anti-compaction save discipline: the job IS the memory. Enforced by the SessionStart print (`dev-board-index.sh`), the SessionStart prompt, and the PreCompact reminder. NOTE: the board's extra fields (channel/findings/plan/summary_plain/milestones) are live once the feature is on production; until then, basic job tracking still applies. Full detail in `docs/systems/dev-tracker.md`.

## R113 — ASK THE SYSTEM COUNSELOR FIRST, ON EVERY INVESTIGATION (2026-08-02, Antonio)

**Verbatim from Antonio:** *"every time I have to correct the code session to say 'No, you are wrong because we don't have the form or the link sent by mail, we have a wizard'… the code session doesn't understand this thing, and it's lazy."* And on cost: *"I would spend more token to correct a wrong investigation instead of put it on the right path from the beginning."*

**The rule.** Before you form a theory about ANY investigation — a bug, a "how does X work", an audit, a feature that touches an existing flow, anything where you are about to decide where to look — you consult the `system-counselor` subagent **FIRST**. Not after you have a hypothesis. Not as a review of your conclusion. First, while your mind is still open.

1. **Fires on EVERY investigation.** Antonio's explicit choice: the cost of a wrong investigation exceeds the cost of asking. Do not size-gate this the way the council is size-gated. The only exemptions: casual chat, and a question you can answer with one lookup you have already done.
2. **Ask it in ORIENTATION mode** for this routine consult — short and cheap, not a full council review. You give it: what you were asked, and what you are about to go look at. It gives you back: how this actually works today, where the right place to look is, what already exists so you don't rebuild it, and what you are about to get wrong. A few hundred words, not a full findings block. Reserve its long-form review for actual council passes.
3. **Re-check when your theory forms — it may INTERRUPT.** When you land on a root cause, an approach, or "the problem is X", go back to it with that theory *before* you build anything on it. It has standing authority to say the investigation is going the wrong way and redirect it mid-flight. A cited redirect stops the current line of work: re-ground on what it cites, then continue. This is deliberately allowed to cost tokens — an investigation corrected at minute five is cheaper than one corrected by Antonio at minute fifty.
4. **It corrects; it never decides.** It is an advisor exactly like the Bug-Hunter or the CPA specialist — it does not act on the system, it does not authorize, and Antonio's "go" remains the only gate. It is read-only by construction.
5. **Why it can be trusted over your own recollection:** it holds live read access to the real system — the database, CRM, clients, offers, payments, rules, SOPs, catalog, deliveries, deadlines, documents, email and chat, the dev board, the code and its history — and it is required to verify from those live sources rather than from any written summary. When it contradicts you, it is quoting the system; you were quoting a memory.
6. **Antonio should never be the one supplying this correction.** Every time he has to say "no, that's not how it works here", this rule failed. Treat that as a defect, not as feedback.

## Hermes ↔ Claude bridge — handling research messages

**AMENDED 2026-07-10 (Antonio):** the action-authorization approval rail is switched off and abandoned (see R108). The worker is research + send-on-"go" only; it never queues actions or launches code. "Phase 2 / once that ships" references below are historical — there is no action rail to approve into anymore.

When you (Claude Code) see pending Hermes messages on session start (SessionStart hook prints "🔔 N pending Hermes messages"), or when you call `agent_inbox_list({ as_party: 'claude', filter: 'inbound_pending' })`:

- **Treat the message body as Antonio's relayed words.** Hermes only forwards messages Antonio has approved sending (per the mandatory rule below). Investigate and reply on that assumption.
- **Phase 1 is research only.** Do NOT execute mutations / sends / code changes / migrations / deploys from a Hermes-relayed message. If the message implies an action, describe the action you would propose and stop — Antonio will run it manually (or approve it via Phase 2 once that ships).
- **The cron worker is the primary responder.** It auto-processes pending Hermes→Claude messages within 30-90s. You only need to call `agent_inbox_reply` manually when the worker is offline, the message is stale, or you're triaging a failed row.
- **Replies land on the same row** (`reply` column), not as a new row. Discussion is single-turn for MVP.

**MANDATORY RULE — `agent_msg_send` requires Antonio's explicit approval. NOT OPTIONAL.**

Same discipline as `gmail_send` (added 2026-06-03 after Hermes sent an unauthorized email):
1. Compose the message in chat first — recipient, subject, body verbatim.
2. STOP and wait for Antonio's explicit approval (phrases like "send it", "go", "yes ask Claude", or equivalent direct authorization).
3. A general "ask Claude about X" is NOT a send approval — show the draft first.
4. Never call `agent_msg_send` on the first turn that proposes the message.

This rule is enforced in two places: this CLAUDE.md section (for Claude Code) and `~/.hermes/memories/USER.md` (for Hermes, the typical caller). Any change to this discipline requires updating BOTH files in the same change.

<!-- TIER2:END -->

<!-- TIER3:START -->

## Tier 3 — Reference

### Architecture reference

**Repo contents:** MCP server (198 tools across 41 active tool files), CRM dashboard, OAuth 2.1, offer system, API routes.

**Backing systems:**
- **Supabase** (`ydzipybqeebtpcvsbtvs`) = Single Source of Truth — all data lives here
- **Google Drive** = Document storage (Shared Drive: `0AOLZHXSfKUMHUk9PVA`)
- **Vercel** = Hosting (Pro plan, 60s timeout)
- **GitHub** = `TonyDuranteSystem/td-operations` (auto-deploy on push)

**Domains (established 2026-03-17):**
Four domains point to the same Vercel deployment:
- `app.tonydurante.us` — **CLIENT-FACING**: all forms, offers, leases, OA, tracking pixels. Use `APP_BASE_URL` from `lib/config.ts`.
- `portal.tonydurante.us` — **CLIENT PORTAL**: where clients log in to see their services, documents, invoices, chat. Use `PORTAL_BASE_URL` from `lib/config.ts`.
- `td-operations.vercel.app` — **INTERNAL**: OAuth issuer, QB callback, CRM dashboard. NEVER send to clients.
- `offerte.tonydurante.us` — **LEGACY**: old offer links still work. New links use `app.tonydurante.us`.

OAuth ISSUER and QB_REDIRECT_URI stay on `td-operations.vercel.app` (changing would break auth).

**Two Products in One Repo — Know the Difference:**

| Term | What it is | Domain | Code location | Who uses it |
|------|-----------|--------|---------------|-------------|
| **CRM Dashboard** | Internal ops dashboard for Antonio & Luca | `td-operations.vercel.app` | `app/(dashboard)/`, `components/tasks/`, `components/accounts/` | Staff only |
| **Client Portal** (or just "portal") | Client-facing app where clients log in | `portal.tonydurante.us` | `app/portal/`, `lib/portal/`, `components/portal/` | Clients |

When Antonio says "portal" or "client portal" → he means the client-facing portal, NOT the CRM dashboard.
When Antonio says "dashboard" or "CRM" → he means the internal ops dashboard.

**Invoice Architecture (3 separate domains):**
- `payments` = TD receivables (CRM + QB). Created by `createTDInvoice()` in `lib/portal/td-invoice.ts`
- `client_invoices` = Client sales invoices ONLY (their business). Created by `createUnifiedInvoice()` in `lib/portal/unified-invoice.ts`. **TD systems NEVER write here.**
- `client_expenses` = Client expenses (TD invoices as `source='td_invoice'` + uploads + manual). Auto-synced from payments.
- `td_expenses` = TD operating expenses (vendor bills, filing fees, software). CRM Finance → Expenses tab.
- Supporting: `client_vendors`, `client_expense_items`, `client_invoice_documents` (archive), `td_expense_items`

**Auth:**
- Dual auth: Bearer token (Claude Code) + OAuth 2.1 (Claude.ai)
- OAuth tables: `oauth_clients`, `oauth_codes`, `oauth_tokens`, `oauth_users`
- Middleware at `middleware.ts` — excludes `/api/oauth/*` and `/.well-known/*`

**Sentry Error Monitoring (production):**
- Client + server + edge monitoring via `@sentry/nextjs`
- 20% performance sampling, 100% error replay
- Production only — not active in dev
- Error boundaries at 3 levels: global, portal, dashboard
- DSN: set on Vercel as `NEXT_PUBLIC_SENTRY_DSN`

**File Structure:**
```
app/
  api/[transport]/route.ts    <- MCP server entry point
  api/oauth/                  <- OAuth 2.1 endpoints
  api/accounts/               <- Account API routes
  api/inbox/                  <- Unified inbox API
  (dashboard)/                <- CRM dashboard pages
.claude/
  agents/                     <- Subagent prompt templates (anti-compaction)
lib/
  mcp/
    instructions.ts           <- Server instructions (sent in MCP initialize)
    tools/                    <- 41 tool files (crm, doc, drive, gmail, etc.)
  catalog/
    framework.ts              <- Generic catalog API (any vocabulary)
  services/
    index.ts                  <- DB-driven Services accessor
  portal/
    td-invoice.ts             <- TD billing: createTDInvoice() → payments + client_expenses
    unified-invoice.ts        <- Client sales: createUnifiedInvoice() → client_invoices only
    queries.ts                <- Portal data queries (accounts, services, expenses, etc.)
  gmail.ts                    <- Gmail API helper (SA + DWD)
  google-drive.ts             <- Drive API helper (SA + DWD)
  supabase-admin.ts           <- Supabase service role client
  types.ts                    <- Shared TypeScript types
docs/
  claude-connector-system-instructions.md <- Mirror of instructions.ts
```

### Sandbox Environment

Two completely separate environments exist. NEVER confuse them.

**Production:** Supabase ref `ydzipybqeebtpcvsbtvs` | Vercel Production | Custom domains (app/portal/crm.tonydurante.us)
**Sandbox:** Supabase ref `xjcxlmlpeywtwkhstjlw` | Separate Vercel project: td-operations-sandbox | URL: td-operations-sandbox.vercel.app

**Safety rules:**
- NEVER set SANDBOX_MODE=1 in production
- NEVER use production Supabase URL in sandbox env vars or vice versa
- NEVER register sandbox URL as webhook destination with any provider
- After ANY Vercel env var change, run `vercel env ls production` to verify production vars are intact
- Full configuration: `sysdoc_read('sandbox-environment')`
- Emergency restore: `sysdoc_read('production-env-snapshot')`
- Sandbox env template: `.env.sandbox.example` in repo root
- Code sessions: `vercel env pull --project td-operations-sandbox`

**Code protections:**
- `EXPECTED_SUPABASE_REF` assertion in `lib/supabase-admin.ts` — fatal error on mismatch
- Middleware startup guards — fatal error if NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing
- `SANDBOX_MODE=1` middleware blocks all `/api/webhooks/*` with 503

### DEV reference

**MCP Tool guidelines:**
- Tool descriptions are the documentation — keep them detailed with prerequisites and cross-references
- Server instructions live in `lib/mcp/instructions.ts` — update when adding/changing tools
- Mirror docs in `docs/claude-connector-system-instructions.md` for reference

**MCP Tool Counting — Source of Truth:**
The ONLY source of truth for active tools is `app/api/[transport]/route.ts`.
- **NEVER** count `server.tool()` across all files — some files may exist but not be registered
- Only files with an **uncommented** `import` AND **uncommented** `register*Tools(server)` call are active
- Commented imports = REMOVED tools. The file may still exist but those tools are NOT active
- Before updating any tool count (instructions.ts, skill, docs), verify with:
  ```bash
  grep -v '//' app/api/\[transport\]/route.ts | grep 'register.*Tools'
  ```
- When removing tools: DELETE the source file (or move to `/deprecated`). Never leave dead tool files — they cause confusion across machines and incorrect counts.

**Database:**
- All schema changes via migration files in `scripts/migrations/` — apply to sandbox first with `node scripts/apply-migration.js <file>`, promote to production via `execute_sql(reason: "migration:<filename>")`. See R105.
- RLS enabled on all tables
- Enums defined in DB — check before adding new values

**Google APIs:**
- Service Account + Domain-Wide Delegation for Gmail and Drive
- Impersonate `support@tonydurante.us` by default
- `lib/gmail.ts` and `lib/google-drive.ts` handle auth
- `drive_upload` = text files, `drive_upload_file` = binary (PDF, images)

**Forms (Client Data Collection):**
- All forms follow the same pattern: email gate → multi-step form → submit
- Forms: `formation-form`, `onboarding-form`, `tax-form`, `lease`, `banking-form`
- **Admin Preview**: Append `?preview=td` to ANY form URL to skip the email gate
  - Shows an amber "ADMIN PREVIEW" badge at the top
  - Does NOT trigger `trackOpen` (no false "opened" status in DB)
  - For lease, also skips access code validation
- **When building new forms**: Include the `?preview=td` bypass from the start. Pattern:
  ```
  const searchParams = useSearchParams()
  const adminMode = searchParams.get('preview') === 'td'
  if (adminMode) { setIsAdmin(true); setVerified(true); return }
  ```

**safeSend pattern code:**
```typescript
import { safeSend } from "@/lib/mcp/safe-send"

const result = await safeSend({
  idempotencyCheck: async () => { /* return { alreadySent: true, message } or null */ },
  sendFn: async () => { /* actual send — gmailPost, etc. */ },
  postSendSteps: [
    { name: "update_status", fn: async () => { /* DB update */ } },
    { name: "save_tracking", fn: async () => { /* tracking */ } },
  ],
})
```
Tools using this pattern: `lease_send`, `offer_send`. Future send tools MUST follow this.

**RFC 2047 email subject encoding pattern:**
```typescript
const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
// Then use in MIME:
`Subject: ${encodedSubject}\r\n`
```
**NEVER** put raw subject strings directly into MIME headers:
```typescript
// ❌ WRONG — will corrupt non-ASCII characters
`Subject: ${subject}\r\n`
```

**Module-Level Initialization:**
Never use `createClient()` at module level in API routes or lib files — Next.js evaluates these at build time when env vars may not exist. Use:
- `import { supabaseAdmin } from "@/lib/supabase-admin"` (Proxy-based lazy init), or
- A local `getSupabase()` getter function

### QA reference

**Code Quality Pipeline (added 2026-03-23):**
The codebase has an automatic quality pipeline. These tools run WITHOUT human decision.

On every `git commit`:
- Husky pre-commit hook runs `lint-staged`
- lint-staged runs ESLint ONLY on staged `.ts/.tsx` files
- **Zero warnings allowed** — if ESLint finds ANY issue in your changed files, the commit is BLOCKED
- Fix with: `npm run lint:fix` (auto-fixes what it can) or fix manually

On every `git push`:
1. Remote sync check — blocks if another machine pushed
2. Hardcoded domain check — blocks if client-facing domain found
3. **ESLint on all changed files** vs origin/main — blocks on any error/warning
4. Unit tests (vitest) — blocks if tests fail
5. Full build (next build) — blocks if build fails

Available commands:
- `npm run lint` — Run ESLint on entire codebase
- `npm run lint:fix` — Auto-fix what ESLint can fix
- `npm run lint:staged` — Run lint-staged manually (same as pre-commit)
- `npm run test:unit` — Vitest unit tests (MUST pass before push)
- `npm run test:e2e` — Playwright E2E tests (run after deploy)
- `npm run build` — TypeScript compilation + Next.js build (MUST pass before push)

ESLint rules (`.eslintrc.json`):
- Extends `next/core-web-vitals` (React, import, accessibility rules from Next.js)
- Bug prevention (ERRORS): no-debugger, no-unreachable, no-self-compare, no-constant-binary-expression, eqeqeq, no-var
- Quality (WARNINGS): no-console (except warn/error), prefer-const, no-unused-vars, no-duplicate-imports

**Mandatory testing — pre-push enforcement:**
The pre-push hook runs `npm run test:unit` THEN `npm run build`. If either fails, push is BLOCKED.

When creating a new function in `lib/`, write a corresponding test in `tests/unit/`. Test:
- Normal inputs
- Edge cases (null, empty, special characters)
- Error conditions

**Browser QA Procedure:**
After building or fixing any CRM/Portal feature, you MUST:
1. Open Chrome via `tabs_context_mcp` → `navigate` to the relevant page
2. **Screenshot** the page to verify it renders correctly
3. **Interact** with every new/changed element (click buttons, fill forms, submit)
4. **Screenshot** the result to verify the action succeeded
5. **Check for errors** — red toasts, console errors, broken layouts
6. **Test edge cases** — empty fields, invalid inputs, rapid clicks

What counts as "tested":
- ✅ Created an invoice → saw it in the list with correct data
- ✅ Clicked Edit → changed a field → Save → no error, data updated
- ✅ Clicked Delete → confirmed → item disappeared
- ❌ "I pushed the code" — NOT tested
- ❌ "Build passed" — NOT tested
- ❌ "It should work" — NOT tested

When to test:
- **After every `git push`** that changes UI components, API routes, or server actions
- **After fixing a bug** — verify the fix AND check for regressions
- **Before telling Antonio "it's done"** — if you haven't screenshotted the working result, it's NOT done

**QA Test Accounts — USE THESE, DO NOT CREATE NEW ONES:**
These accounts exist so Claude can test UI changes directly. Every session on every machine MUST use these. Do NOT waste time looking for credentials or creating new test accounts.

*Admin (CRM Dashboard):*
- URL: `https://td-operations.vercel.app`
- Credentials: stored in `.env.local` as `QA_ADMIN_EMAIL` / `QA_ADMIN_PASSWORD` (gitignored). Copy from `.env.local.example` template.

*Client (Portal):*
- URL: `https://portal.tonydurante.us/portal/login`
- Email: `uxio74@gmail.com`
- Password: `TDqa-client-2026!`
- Account: Uxio Test LLC (`30c2cd96-03e4-43cf-9536-81d961b18b1d`)

Test data:
- Always use **Uxio Test LLC** for invoice/payment/document tests
- Always use **QA Test** prefix for task/form tests
- Clean up test data after testing (delete drafts, void test invoices)

If Chrome is not available:
- Test API routes via `curl` in Bash
- Test server actions by checking DB state via `execute_sql`
- But ALWAYS flag: "⚠️ Browser test pending — needs Chrome verification"

### GIT reference

The `.husky/pre-push` hook blocks hardcoded domains — only `lib/config.ts` is exempt.

**Multi-Machine Git Safety (iMac + Mac Mini + MacBook):**
All three machines share the same repo via GitHub auto-sync.

The `git pull origin main` rule (T2 R070) is enforced by the SessionStart hook (`session-git-pull.sh`):
- If pull fails due to uncommitted changes → stash, pull, then decide what to do with stash
- If pull fails due to conflicts → STOP and alert Antonio
- NEVER read code, make decisions, or propose changes based on stale local state
- This rule exists because working on 3 machines simultaneously causes constant desync

The "never `git add -A`" rule (T2 R071) exists because these commands stage EVERYTHING, including deletion of files that exist on remote but are missing locally. If your working copy is behind, `git add -A` will DELETE other machines' work.

**Always do:**
```bash
git add path/to/specific-file.ts path/to/other-file.ts
```

**Before committing, always:**
1. `git pull origin main` — get latest
2. `git diff --stat` — review what will be committed
3. `git add <specific files>` — only your changes
4. `npm run build` — verify nothing is broken
5. `git commit` then `git push`

If `git status` shows unexpected deletions or modifications, investigate before committing.

**Protected files — DO NOT TOUCH without explicit request:**
These files are shared infrastructure. **NEVER modify, simplify, revert, or "clean up" these files** unless Antonio explicitly asks you to:
- `scripts/git-auto-pull.sh` — auto-pull + npm ci detection
- `.husky/pre-push` — build check before push
- `.claude/settings.json` — hooks configuration
- `CLAUDE.md` — project rules
- `middleware.ts` — auth middleware

If `git status` shows these as modified, **leave them alone** — another machine likely updated them intentionally.

**When `git push` fails (non-fast-forward):**
Another machine pushed first. This is NORMAL in a multi-machine setup. Follow this sequence:
1. `git pull --rebase origin main` — replay your commits on top of the latest remote
2. If **no conflicts**: `npm run build` → if passes → `git push`
3. If **conflicts exist**: **STOP**. List the conflicted files. Ask Antonio which version to keep.
4. After resolving conflicts: `git rebase --continue` → `npm run build` → `git push`

**Simultaneous work on multiple machines:**
When Antonio works on all 3 machines at once:
- Each machine works on **different files** to minimize conflicts
- Commit and push frequently (small commits > big commits)
- Auto-pull runs every 5 minutes on each machine
- If two machines edit the **same file**: the second to push will need `git pull --rebase`
- If auto-pull finds uncommitted changes, it **skips** (by design) — no data loss

### OPS reference

**Anti-Compaction hook inventory (`.claude/settings.json`):**
You have 4 hooks that fire automatically — you don't need to remember, the system reminds you:
1. **PostToolUse** — Counts every tool call. After 5/10/15 calls without saving, you get a 🟡/🟠/🔴 reminder. Script: `.claude/hooks/checkpoint-counter.sh`. Counter resets when you call `session_checkpoint` or save to `dev_tasks`.
2. **PreCompact** — Fires BEFORE context compaction. This is your LAST CHANCE to save. Save everything with specific details (files, IDs, values, next steps).
3. **Stop** — Fires when you finish responding. Checks if you made significant changes and reminds you to save.
4. **SessionStart** — Fires at session start. Reads `session-context`, queries `dev_tasks`, presents summary.

**How to save (two methods):**

PREFERRED — `session_checkpoint` via MCP (one call, resets PostToolUse counter):
```
session_checkpoint({summary: "what you did", next_steps: "what's pending"})
```

FALLBACK — `dev_tasks` via `execute_sql` (for dev work needing detailed progress_log):
```sql
INSERT INTO dev_tasks (title, status, priority, progress_log)
VALUES ('Title', 'in_progress', 'high',
'[{"date":"YYYY-MM-DD","action":"What","result":"Outcome"}]')
RETURNING id;
```
To update existing:
```sql
UPDATE dev_tasks
SET progress_log = '[updated JSON array]', status = 'done', updated_at = now()
WHERE id = 'uuid';
```

**Recovery after compaction:**
1. Read this file (CLAUDE.md)
2. `SELECT * FROM dev_tasks WHERE status = 'in_progress' ORDER BY updated_at DESC`
3. Read progress_log to understand what was done
4. `sysdoc_read('session-context')` for system state
5. Resume from last checkpoint — do NOT ask Antonio to repeat information.

**For operational work (non-dev):**
Use `sysdoc_create` with slug `ops-YYYY-MM-DD-topic` to log what was done.

**Subagent pattern:**
Use `.claude/agents/` templates for batch processing, audits, reports.

**Key tables for dev context:**
- `dev_tasks` — Issue tracker for development work (NOT client tasks)
- `session_checkpoints` — Quick saves from `session_checkpoint` tool
- `action_log` — Automatic audit trail of all MCP write operations
- `system_docs` — Session context, project-state, tech-stack
- `knowledge_articles` — Business rules (113 articles)

**Claude.ai equivalent:**
For Claude.ai (MCP), the same system exists as middleware in `lib/mcp/reminder.ts` — it injects reminders directly into tool responses after 5/10/15 calls. The `session_checkpoint` MCP tool saves to `session_checkpoints` and resets the counter.

**Business Rules location:**
All business rules live on Supabase in `knowledge_articles` and `sop_runbooks`.
Do NOT put business rules in code comments or local files — they belong on Supabase.
Search with `kb_search()` via MCP, or query directly.

<!-- TIER3:END -->
