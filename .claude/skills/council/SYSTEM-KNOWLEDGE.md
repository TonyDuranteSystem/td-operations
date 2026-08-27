# SYSTEM-KNOWLEDGE — the System Counselor's index to the live business and system
_Last verified: 2026-08-25 — Claude (added the What's New vs Notification Center playbook row — a gap the System Counselor flagged twice in the same council review, dev job fb527ac8, before it was ever written down; new doc [whats-new.md](../../../docs/systems/whats-new.md) is the deep reference). Prior: 2026-08-14b — Claude (the payment-plan+referrer/partner era marker below is now LIVE ON PRODUCTION (PR #293, merge `86897a86`) — strike "sandbox only" from it; the same-day older-tools plan-settlement guard shipped in the same merge. Prior 2026-08-14: REVERSED the payment-plan+referrer/partner era marker: a plan may now carry a referrer/partner, released via one manual account-page action once the whole plan is paid in real cash; full history in session-context's top entry. Prior 2026-08-11: added the original payment-plan/tranche era marker — WS-C, dev job c0a61e44. Prior 2026-08-07b: added the portal-chat send-scope era marker — the Conversion Monsters leak fix, dev job 4bad3094. Prior same-day note: added the inbox email-state playbook row — reads from our own index, writes through Gmail — the missing pointer the Counselor flagged on the 2026-08-07 inbox council pass. Prior note: rebuilt 2026-08-02 after Antonio's correction: the Counselor has live read access to the production database, CRM, knowledge base, SOPs, catalog and code, so this file is the INDEX to the live system, never a copy of it.)_

## Read this first

This file **does not hold business facts. On purpose.**

The System Counselor can query the live system — the production database, the CRM, the knowledge base, the SOPs, the catalog, offers, service deliveries, deadlines, documents, the code. So a written copy of a price, a rule, a status list or a count would only ever be a slower, staler version of something one query away. Copies rot; the query cannot.

What lives here instead:
1. **The live-answer playbook** — for each kind of question, the exact live source that settles it (§2).
2. **Invariants and vocabulary** — the things that are structurally true and are not a row in a table (§3).
3. **Era markers** — what changed, was retired, or was reversed, so a plan is not built on a dead thing (§4).
4. **Wrong turns** — the specific ways sessions get this system wrong (§5).
5. **How this file and the wider knowledge stay honest** (§6).

**The standing rule:** if a question can be answered by a live query, answer it with a live query. Quoting this file instead of checking is the exact failure this seat exists to prevent.

> **⚠️ DEGRADED MODE — check this before you use anything below.** If your runtime tool list is only `Read`, `Grep`, `Glob`, then the live tools did not load (a stale session registry, or the production connector is not configured on this machine). **The playbook in §2 does not apply to you.** Say so in one line, answer only what repo files can honestly answer, mark everything else "cannot verify — no live access", and do NOT substitute a file read for a live lookup. A Counselor that quietly falls back to files while the room believes it checked the live system is worse than no Counselor at all. *(This is not hypothetical: the first two spawns after the live tools were granted ran in exactly this state, because a session's agent registry is fixed at session start.)*

---

## 1. Source-of-truth order

1. **The live production database and the CRM** — what is actually true right now about a client, a payment, a service, a deadline.
2. **The live knowledge base and SOPs** — the canonical business rules (Master Rules wins on conflict, R060) and the step-by-step procedure per service.
3. **The live code** — how the system actually behaves. Where a doc and the code disagree, the **code wins**.
4. **`docs/systems/<subsystem>.md`** — orientation and history. Each carries a *Last verified against code* date; **read the date before trusting it**.
5. **CLAUDE.md R-rules** — the operating/guardrail layer for how work is done.
6. **Dev board** — what is in flight, just decided, or blocked.
7. **Claude-authored history** (Supabase sysdocs, checkpoints, progress logs, memory) — **HINTS ONLY**, never citable as current state.

**The system atlas is now generated and gated (2026-08-02), so its INVENTORIES are usable — with a limit you must respect.** Its appendices are rebuilt from live code by a script and a pre-push gate blocks a push that leaves them behind. **Safe to quote:** the active tool-group list, the hook inventory, the R-rule list, the table count, and the subsystem-doc index. **Do NOT treat as final:** the per-doc "verified" dates and the wired/not-wired labels — both were provably wrong on the generator's first run and are derived by pattern-matching, so confirm either one against the doc or the settings file before you rest a finding on it. Its **narrative** sections are still hand-curated and lag. And the standing rule is unchanged: a generated count is still a written number — where a live query can settle it, run the query.

---

## 2. The live-answer playbook — which source settles which question

| The question | Settle it with | Never settle it with |
|---|---|---|
| What is this client's price / what did they buy? | **their offer** (its cost summary is the contractual truth for that client) | typical pricing, entity type, any figure in a doc |
| What is the business rule for X? | **the knowledge base** — search Master Rules, then the service's SOP | a rule quoted in a Claude-written doc or this file |
| What is this client's real state? | the CRM client summary **plus** their offer, payments, service deliveries, portal tier — all of them | one table alone; a status word that means something else |
| Has this been paid / is it overdue? | the payments records | an invoice's own copy of "amount paid" (known to disagree) |
| What services do we actually sell? | the **live catalog** (service vocabulary is data, not code) | a hardcoded list anywhere, including §3 below |
| Where is this service delivery stuck? | the service-delivery pipeline + its stage | the client's own description |
| What is due, and when? | the deadlines records + the compliance docs | remembered state rules — they are per-state |
| Does this code/tool/feature already exist? | code search + the tool registration route + the catalog | assuming; this is the #1 duplicate-build cause |
| How does subsystem X work? | its system doc (check the date), then the code | the atlas's counts; the sysdocs (history) |
| What did we decide, and when? | the dev board card, then the subsystem doc's dated header | memory, checkpoints, session summaries |
| Why didn't this fire? | the workflow catalog row + the task's pinned snapshot, then the dispatcher | the code alone — behaviour is catalog data |
| Why can't the client see this? | the portal tier + the tier sync helper + the portal query | the CRM view; staff and client surfaces differ by design |
| Is this money right? | the four money worlds — know which one owns the number | assuming one invoice concept |
| Is this safe to run? | the hooks/guardrails doc — which layer actually covers this path | assuming a guard covers MCP calls; it does not |
| How does outgoing email get its identity/signature? | `lib/email/signature.ts` (the ONE definition since 2026-08-05) + the "Outgoing email signatures" section of the inbox system doc | `lib/gmail.ts` (transport only, no MIME builder); any of the old hand-rolled shells — they are gone |
| Where does the CRM inbox's email state live? | READS come from our own `email_index` (browse/search/Archived, since 2026-08-07 kept fresh by write-through + the cursor-disciplined sync); WRITES (archive/star/read/snooze) go to Gmail first, Gmail stays source of truth | assuming the inbox reads live Gmail (it stopped 2026-08-02); patching index labels directly (one writer: `indexThread`) |
| Will staff see a client action ("client submitted X")? | check BOTH, separately — What's New (`lib/portal/chat-events.ts`, per-client `portal_messages` marker feed) and the Notification Center board (`lib/notifications/act-event.ts`, cross-client `message_actions` cards) are independent systems that fire independently and sometimes share a literal event-name string by coincidence | assuming one implies the other; assuming a catalog row existing means it's actually called from anywhere (dev job fb527ac8: `banking_wizard_submitted` sat seeded and unused for 3 months) |

**Always say which environment a fact came from.** The Counselor's tools read **production**. Sandbox state is a different question and goes back to the coordinator.

---

## 3. Invariants — structurally true, not a row in a table

**Two products, one codebase.** An internal CRM dashboard (staff only; also Antonio's phone app) and a client portal (clients log in). "Portal" always means the client one; "dashboard"/"CRM" always the internal one. Four domains point at the same deployment, one of them internal-only and never sent to clients; client-facing URLs come from the config helper, never hardcoded.

**Two environments.** Production and sandbox are separate Supabase and Vercel projects. Sandbox is the only development environment, enforced structurally. **The MCP tools are the exception** — they are wired to production regardless of local settings, which is precisely why the Counselor can read live business truth, and precisely why nobody should use them to check sandbox state.

**Supabase is the single source of truth**; Google Drive is document storage (Drive first, portal mirrors key documents).

**The engines to know before building anything:**
- **The catalog framework** — service types, workflows, stage sets and other vocabularies are DATA. Adding one is a row, not a code change.
- **The workflow engine** — triggers, actions, SLA, escalation and follow-ups live in catalog metadata; a task's workflow snapshot is pinned when the task is created, so editing the catalog never changes work already in flight.
- **Service deliveries** — the unit of work, one per service per account. The annual renewal is a *billing cycle*, not a service delivery.
- **The safe-send pattern** — any tool that sends and then updates a status must check idempotency, send first, update after.
- **E-sign** — our own in-house engine, no external provider. Staff send and **clients do sign, in the portal**. What is *not* built is the resale product where a client sends documents to their own third parties. Do not read "TD-first" as "clients never see it".

**The shape of the business** (the categories are stable; the live list is catalog data):
recurring annual services · one-time setup services · one-time-with-renewal (ITIN) · exit services · ad-hoc post-paid services. TD acts as an **IRS Certifying Acceptance Agent** for ITIN work — it prepares and submits the application, certifies passport copies, and its CAA identity address on the form is a regulated identity block, deliberately kept separate from the address clients post documents to.

**The client lifecycle order, which is never skipped:** a lead signs → becomes a contact (the person) → after payment and formation, one or more accounts (companies). One person can own several companies, and individual services can exist on a person with no company at all.

**Four separate money worlds**, and confusing them is the single biggest source of billing bugs: TD's receivables · the client's own sales invoices (TD systems never write there) · client expenses · TD's own operating expenses. *(Note the trap: CLAUDE.md's heading still says "3 separate domains" while listing four+ tables under it — the heading is the stale one.)*

**Known rule-vs-implementation tension, not for a session to resolve:** the canonical rule says invoices are receipts issued after payment, never payment requests — yet the system creates an unpaid invoice at signature and chases it through dunning, and the invoice email sends the client to the portal to pay. Both are true of different things. Which governs a given case is Antonio's call. Read the live rule and the billing doc; do not infer.

**Language:** the system operates in English; only the portal is bilingual, and a client's language is a value on their record — look it up, never ask.

---

## 4. Era markers — what changed, so a plan is not built on a dead thing

- **Portal-first.** Data collection happens in portal wizards; the standalone emailed forms are the fallback, not the default.
- **QuickBooks is DEAD** (R097). Tools removed, kill switch off, sync functions inert. Never build on it, never "finish" it.
- **Vocabulary moved into the catalog** (R106) — hardcoded service strings are a defect.
- **Sandbox-only development**, structurally enforced (R104), with the MCP-routing exception (R096).
- **All schema changes go through migration files** (R105).
- **A lead marked "Converted" means PAID, not signed** (R094) — the most common misreading of client state.
- **The worker/agent action rail is OFF and abandoned** (R108/R111, amended 2026-07-10): assistants research and report; they do not queue actions or ship code.
- **Slack is gone** (surface removed 2026-07-29); Team Workspace replaced it. Two things went with it: Slack was the *staff* surface, **and** it carried client-sourced conversation threads that were archived into our own database. Client conversations now start in Team Chat, which writes the internal-thread tables — **not** the older client-threads list, which has no writer left and is a frozen archive. **Live trap:** the shared worker engine still carries `slack-*` filenames and a `SLACK_WORKER_*` prompt constant, and they are ALIVE — the prompt drives Team Chat with a built-in "you are not in Slack" correction. Deleting by the keyword "slack" breaks working surfaces. A rule that names the "Slack worker" is naming a live thing badly, not pointing at a dead one.
- **Soft-delete for anything a client has already seen** (R100); **server errors must be surfaced, not swallowed** (R099).
- **The "SS-4 is internal, never share it with the client" rule is REVERSED** (Antonio, 2026-08-04: *"the SS4 visible to the client is ok"*). Several system docs still carry the old reasoning as history — do not re-derive the rule from them. The worker no longer warns when an SS-4 is attached to an email; the client PORTAL's own visibility is unchanged and is a separate decision.
- **Portal-chat staff sends are scope-guarded** (2026-08-07, dev job `4bad3094` — the Conversion Monsters cross-company leak). Era history in one line: chat was re-scoped per-company for clients (2026-06-24), "one message, one staff thread" fixed staff-side grouping (2026-07-08), and the send side was only closed 2026-08-07 — before that, person-thread staff replies were silently stamped with the contact's first open company, which is how one member read two months of another company's private formation talk. NOW: person-addressed staff sends stay personal unless company scope is explicitly declared AND the person is verified to be in that company (`lib/portal/admin-send-scope.ts`, wired into every staff send surface). **Wrong-turn guard:** the 2026-07-08c portal.md entry claimed person-thread replies "stay personal" a month before it was true — a doc's claim about send scoping is only as current as this fix.

- **A setup fee can be sold in PARTS — the payment-plan/tranche engine exists** (WS-C, merged 2026-08; `docs/systems/offers.md` + `billing-invoicing.md`). What a session must not get wrong: the plan lives ON THE OFFER; each part is its OWN invoice with tranche lineage and category `setup_tranche` — **NEVER `installment_1/2`**, because paying an instalment fires the accountant hand-off gate and the June cron, which a split setup fee must not touch. Client wording is "Partial Payment", **English only** (Antonio, 2026-08-11, superseding an earlier Italian approval — "instalment"/"rata" belong to the RENEWAL contract and are banned by a word-boundary test). Nothing fires on a schedule: later parts are raised BY HAND, and the trigger-event registry is deliberately EMPTY (an event name in data is a promise something dispatches it). Domenico's real 2026-08 deal was executed BY HAND and is NOT on the engine — his rows validate the arithmetic only; the first end-to-end proof is the next client sold on a plan.
- **⛔ REVERSED 2026-08-14, LIVE ON PRODUCTION (PR #293, merge `86897a86`) — a plan MAY now carry a referrer or managed partner.** Supersedes the line that used to sit here ("a plan cannot share an offer with a referrer or a managed partner at authoring/update; commission is suppressed to a staff hand-settlement card"). That refusal and that card are DELETED, not just superseded — do not describe either as current. Commission/payout now releases via ONE manual action on the account page ("Release commission"), once every part of the plan is Paid AND the real cash is actually received — never per-part, never automatic. Built and adversarially reviewed across 4 rounds the same day (3 code-level/live-E2E passes + a 7-reviewer full-tier council) plus a same-day follow-up closing the four OLDER referral-payment paths that didn't know the new gate existed — full history in `session-context`'s top entry as of 2026-08-14. Historically, as of shipping: 0 of 249 offers, ever, had combined a plan with a referrer/partner — this shipped ahead of the first live case, not in response to one; genuine production use is still unproven at volume. Job `a5e61a46` (the originally-planned per-part-accrual correction this refusal was standing in for) is SUPERSEDED by the simpler manual-release design and stays open only as the place to build true incremental per-part crediting if Antonio wants it later — do not treat it as still blocking, and do not treat its four-part accrual design as what shipped.

- **`members.is_signer` / `resolveAccountSigner` is now the canonical single-signer-document resolver — reused, not duplicated, across lease AND Operating Agreement identity.** First built 2026-08-10 for SS-4 (`decideSs4Signer`, `lib/operations/ss4-signer.ts`), extended 2026-08-18 to leases and 2026-08-19 to every OA-creation site (`lib/members/resolve-signer.ts`, dev job `9ad76300-6181-4250-a1de-c77f37933f82` — Prowave LLC's signed lease named the wrong person; the OA extension closed the same defect class at 9 separate `oa_agreements` insert sites, 2 of which had NO multi-member roster-building logic at all before this). The rule: for a Multi-Member LLC, signing authority is the `members.is_signer` flag, DECOUPLED from ownership %; a company member signs through its representative. A caller building a member roster (vs. treating an account as single-owner) must classify via `isMultiMemberEntity()` (`lib/portal/entity-type.ts` — checks BOTH `entity_type` text and `member_structure`), not its own text-only check — 3 sites drifted from the resolver's own classification before this was made the one shared test. If a future session needs "who signs for this company" for a new document type, reuse `resolveAccountSigner`/`decideSs4Signer` — do not hand-roll another copy of this rule.

**Resolving "which offer belongs to this account" must prefer the account's own linked offer, and fall back only to a genuinely UNLINKED one (`account_id IS NULL`) by contact email — never a different, populated account's offer** (2026-08-27, dev job `bb48eba1` — Estro LLC's diagnostic panel showed Oaris LLC's offer because a shared contact with no `is_primary` flag got picked as "the" contact and matched by email across the whole table; confirmed live on 8 real accounts, purely a display bug, no downstream write ever consumed the wrong offer). This logic lives inline in `diagnose-account`'s offer lookup, not as an extracted shared helper — if another surface resolves "the offer for this account" later, point it at this rule rather than re-deriving it. **`assertServiceTypeNotDeprecated` (`lib/services/index.ts`) is now the by-hand check every `service_deliveries`-creating call site must call** (same job — the catalog marks "Annual Renewal" deprecated since 2026-05-09, but nothing enforced it; a panel's "Create missing service" button would have created one anyway). There is still no single choke-point function every insert goes through — `createSD`, `createBackfilledSD`, and the CRM chat quick-create route all call it explicitly today; a new insert path must add the call by hand, the same caveat as `resolveAccountSigner` above.

**For the rest of a subsystem's history:** read the dated header block of its system doc, then the git log for those paths, then the dev board card. Do not guess.

---

## 5. Wrong turns this seat exists to catch

1. Answering a business question from this file, a memory, or a written doc **when a live query was available**.
2. Hardcoding a price, a service type, or a status literal instead of reading the offer / catalog / constants.
3. Writing a field directly when it has a single canonical write path (portal tier is the classic).
4. Treating a Claude-written document, checkpoint, or memory as fact without reconciling it against a live source.
5. Building on a retired subsystem, or on a rule that was later amended or reversed.
6. Investigating the wrong surface: CRM instead of portal, standalone form instead of portal wizard, sandbox state via a production-only tool.
7. Reading one table and declaring a client's state — it is spread across offer, payment, service delivery, tier and documents.
8. Adding a second way to do something that already has a canonical helper.
9. Assuming a guard exists because the repo is heavily guarded — check which layer actually covers your path.
10. Quoting a dated snapshot's counts as current.
11. Citing a rule that has since been amended, or a doc since superseded — a citation is only as current as its source.
12. Calling something "done" when it is only code pushed: not verified, not documented, board card not closed.

---

## 6. How the knowledge stays honest

**The design does most of the work.** This file holds no prices, no counts, no schemas, no client facts — so the things that change fastest cannot rot here. What remains is structure, and structure changes rarely and visibly.

**Three mechanisms keep the rest current:**

1. **Continuous correction, every call.** The Counselor verifies against live sources on every review and reports anything this file gets wrong, omits, or points at badly, in a dedicated drift field. The coordinator applies the fix in that same change. The file gets *fresher with use*.
2. **The existing decision-propagation chain, extended by one step.** TD already has a mandatory rule for propagating a decision (business rule → the knowledge base first, then the SOP, then the connector instructions, then the session context, then CLAUDE.md). **This file is now the last stop in that chain** — but only for the narrow set of changes that affect it: a new or retired subsystem, a reversed decision, a changed investigation path, a new engine, or a structural change to how the business is organised. A price change or a new SOP version does **not** touch this file, by design, because this file never held them.
3. **Same-change updates.** Whoever makes a change that would make a line here wrong fixes it in that change and bumps the date at the top.

**Honest limitation, stated plainly:** there is no machine gate on this file. The pre-push freshness check is a plain doc-to-code-path map and could technically take a line for it, but any path narrow enough to be meaningful would miss most of what invalidates it, and one wide enough would block every push and turn the fix into a reflex date-bump — a rot generator with a green light. It stays true because the Counselor checks it against live sources every time it sits down, and because nobody is allowed to cite it as evidence.

**Standing warning, earned on day one:** the first version of this file shipped with four wrong lines in it (it said three money worlds instead of four, mis-described the Slack removal, told reviewers to quote a two-month-old inventory instead of counting live, and stated a payment rule flatly where rule and implementation actually disagree) — and two reviewers *also* raised a false alarm against a line that was correct. That is why this version holds an index instead of answers. **Cite the live source, not the map.**
