# What's New (client-action chat-event feed)
_Last verified against code: 2026-09-01c — Claude (**Round 7, same incident: the timestamp re-stamp risk flagged (not fixed) at the end of round 6 is now closed, on Antonio's explicit request.** `lib/jobs/handlers/formation-setup.ts`'s form-reviewed UPDATE previously ran unconditionally on every pass through that step, re-stamping `reviewed_at`/`completed_at` to "now" — including a job-queue retry of an already-succeeded attempt, or a genuine resubmit that the wizard-submit route deliberately keeps at `status='reviewed'` (`preserveReviewedStatus`, dev job `ca788354`) rather than resetting to `'completed'`. Either case re-triggered the identical "Pasztor 17-days-adrift" defect that route-side fix was built to prevent — it was only ever half-closed. Fixed with a TOCTOU guard mirroring the pattern CLAUDE.md already mandates elsewhere in this codebase (banking-review.ts, tax-review.ts, closure-review.ts): the UPDATE now also filters `.eq("status","completed")` and reads back the affected row count via `.select("id")` — it only ever transitions completed→reviewed once, and is a provable no-op (0 rows, timestamps untouched) on any repeat pass, whatever caused it. The staff alert (round 5/6) still fires on a repeat pass regardless, since it's gated on the notification's own dedup, not on this write succeeding. Unit tests: `tests/unit/formation-setup-resubmit.test.ts` (+3: first pass stamps, repeat pass is a no-op, alert still fires on a repeat pass).)_
_Prior: 2026-09-01b — Claude (**Round 6, same incident: a 4th Bug Hunter pass — asked to sweep the whole area one more time after round 5 shipped — found round 5's own retire-then-refire logic could itself misfire, and it's now fixed.** `lib/jobs/handlers/formation-setup.ts`'s round-5 code retired the existing "wizard submitted" note and refired it with "resubmitted" wording whenever `formation_submissions.status` was already non-`completed` — but that status is written by THIS SAME job a few lines earlier in the same pass, and 4 later `updateJobProgress` calls in the handler are unguarded (`throw` on any transient write error). A crash after the status flip but before the job finishes puts the job back in the retry queue; on retry, the handler reads its OWN prior (successful) write as if it were a genuine client resubmission — deleting the correct, already-emitted note and replacing it with a false "Client resubmitted..." one. Fixed by removing the preemptive retire: the code now always just calls `emitFormationWizardSubmittedEvent`, relying on the marker-based dedup already inside `emitClientChatEvent` to make a retry a safe no-op (`reason: "already_emitted"`) instead of a mislabel. Traded away: a GENUINE resubmission (client corrects data and resubmits) no longer gets a fresh note or "resubmitted" wording — `formation_submissions` has no content-hash column (unlike `closure_submissions.last_processed_hash`, added by the same Aug-27 migration) to distinguish "genuine resubmit" from "this job's own retry," so there's currently no safe way to support both. Flagged, not fixed: the SAME job also unconditionally re-stamps `reviewed_at`/`completed_at` on every pass through this step (pre-existing behavior, predates today) — a retry after this step succeeds would re-stamp those columns too, the identical "Pasztor 17-days-adrift" defect class from dev job `ca788354`, just via a different trigger (infra retry, not a real re-submit). Not fixed in this pass — flagged for its own dedicated look, since it touches the same sensitive timestamp-integrity logic that incident was about. Unit tests: `tests/unit/formation-setup-resubmit.test.ts` (updated the round-5 resubmission test to assert retire is NEVER called).)_
_Prior: 2026-09-01 — Claude (**New kind `formation_wizard_submitted` — Company Formation had NO dedicated ChatEventKind at all until now, the root gap behind the Francesco Lussignoli incident (dev job 9a9c5cf5, round 5).** Formation's only existing staff alert was the one-time `workflow_spawned` note fired when the service delivery is created at PAYMENT time — before the client has even opened the wizard. Once staff read/dismissed that note (the normal case — it's usually the first thing they see), submitting the actual wizard produced no alert at all; staff were left with only the unconditional "Formation Form Completed" email, which is why the incident looked like "we get an email instead of What's New." Antonio's explicit ruling on discovering this: every client action that hands the ball back to staff must produce a fresh, unread alert — not just the first one in a multi-step flow. Added `emitFormationWizardSubmittedEvent` / `retireFormationWizardSubmittedNote` (mirrors `emitBankingWizardSubmittedEvent` exactly) + an `EVENT_KEY_LABELS` entry ("Formation"), wired into `lib/jobs/handlers/formation-setup.ts`'s form-reviewed step — gated on `decision.allow.formStatusWrite` so a refused/ambiguous re-submit (dev job ca788354, deliberately silent-to-client-and-staff-except-email by Antonio's ruling) never fires it. Resubmission-aware: the row's PRIOR status is read before this pass's own write so a genuine correction-and-resubmit retires the old note and gets a fresh one, same pattern as tax/banking. **Audited the rest of the formation pipeline for the same gap before considering this closed** (Antonio's rule is "every client action," not just this one): payment (fires correctly, verified via code path + live data), the LLC name approve/reject decision (already correct — routes through the generic, already-working `decision_responded` event, untouched here), and SS-4 signing (already correct, `emitSs4SignedEvent` wired since earlier). Formation's wizard submission was the ONLY gap. Unit tests: `tests/unit/formation-setup-resubmit.test.ts` (+3: first-submission fires, resubmission retires+refires, refused re-submit stays silent).)_
_Prior: 2026-08-28 — Claude (dev job c3efa6cb: a full audit of every ChatEventKind's call site, prompted by a real incident — BRIXEL LLC submitted a Relay banking application and staff got no alert at all, not even the existing `banking_wizard_submitted` kind added 2026-08-25. Root cause was upstream of this file: the notification code (`app/api/portal/wizard-submit/route.ts`) depends on a `banking_submissions` row normally pre-seeded when a company's EIN is recorded, but the Formation Workspace screen staff actually use for 100% of real EIN entries this quarter never re-triggered that seeding — a different, unused screen does. At least 2 more distinct causes (direct data edits bypassing both screens) produced the identical gap on other real accounts; 9 real, already-submitted applications across 6 companies had been silently missed, one for over a month. Fixed by: patching the live EIN screen; extracting the previously-duplicated row-creation logic (a background job and an MCP tool each hand-rolled their own insert) into one shared `lib/operations/banking-submission.ts::getOrCreateBankingSubmission`, now ALSO used as a self-healing fallback inside the notification code itself so it can never silently no-op again regardless of the upstream cause; and adding a real database unique index on `(account_id, provider)` (migration `20260828-1200-banking-submissions-unique-account-provider.sql`) closing a genuine double-submit race a council review (bug-hunter, senior-engineer, ai-architect, project-director) found before this shipped. The 9 real, already-affected pairs were backfilled with their real submitted data and a backdated catch-up note via a one-off route (`app/api/crm/admin-actions/backfill-banking-c3efa6cb/route.ts`). Separately, this same audit found signing the lease had NO ChatEventKind at all — a real, ongoing gap (10 lease signings in the trailing 90 days, zero staff alerts), same class of event as `ss4_signed`. Added `lease_signed` + `emitLeaseSignedEvent` + an `EVENT_KEY_LABELS` entry ("Lease"), wired into `app/api/lease-signed/route.ts`. Operating Agreement signing has the identical gap but was explicitly excluded from this pass on Antonio's instruction — do not add it without asking again. Three other kinds (`offer_signed`, `aged_credit_applied`, `plan_referrer_ready_to_release`) share the same "depends on a lookup that can come back empty" shape as banking did, confirmed via live production checks to have zero real occurrences so far — flagged as lower-priority hardening, not fixed in this pass.)_
_Prior: 2026-08-27 — Claude (dev job fbbf4abe follow-up. Antonio pushed back that the previous day's "full audit" wasn't actually complete — it had missed real gaps. Re-audited every `ChatEventKind` AND every active `workflow_spawned` workflow slug against production, not just the ones touched recently. Found and fixed four items: (1) `plan_referrer_ready_to_release` and `recurring_invoice_generated` are live `ChatEventKind`s with real emit call sites and an active, visible `whats_new_events` catalog row each, but had no `EVENT_KEY_LABELS` entry — added "Referral" and "Invoice". (2) the `itin_data_collection` workflow slug (the very first ITIN step — "send the client the wizard link") is `sd_created`-triggered with `auto_topic` set, so it DOES fire a real `workflow_spawned` note keyed on that slug, but had no label — added "ITIN". Traced every other active workflow slug's reachability (`triggered_by.source` + `auto_topic`) to confirm no others are silently affected: the 4 remaining ITIN sub-stage slugs are chain-only (`chain.spawn_next_workflow` never calls the chat-event emitter — confirmed by reading `chain-spawn-next-workflow.ts` and the task-action route) so they can never surface regardless of label, and 2 other slugs have `auto_topic: null` (deliberately opted out). (3) **The real bug**: the generic `wizard_submitted` event (used only by the tax wizard, source table `tax_return_submissions`) has the same "dedup is permanent" exposure already fixed for banking — `tax_return_submissions` upserts on `token`, so a client's genuine correction within the same calendar year lands on the SAME row id, and `emitClientChatEvent`'s marker dedup silently swallows the second note. PROVEN live with a real production row (id `e6fdfd9b-e0af-4a73-ae62-25c8747e28de`): corrected 11 days after its first submission, exactly one staff note exists, dated the first submission — the correction produced nothing. Fixed with `retireWizardSubmittedNote` in `lib/portal/chat-events.ts`, called from both `lib/jobs/handlers/tax-form-setup.ts` and the older `app/api/tax-form-completed/route.ts` link-based flow, gated on the row's `review_status` having already been non-null before this pass (same shape as banking's `bankingSubmissionWasAlreadyCompleted` check).)_
_Prior: 2026-08-26 — Claude (full audit of the What's New + To-Do board catalogs, prompted by Antonio's push to check the WHOLE event setup rather than one recent change. Found and fixed two gaps: (1) `aged_credit_applied` and `financials_confirm_unlocked` are both live `ChatEventKind`s with real call sites but had no `EVENT_KEY_LABELS` entry — added both. (2) Two catalog rows had a correctly-written seed migration sitting in the repo that was never actually promoted to production: `whats_new_events`/`plan_referrer_ready_to_release` (cosmetic — the event still showed via its own topic fallback "Referral", just without the intended label/toggle) and, more seriously, the sibling To-Do board's `action_events`/`itin_renewal_upcoming` (a real functional gap — without this row `emitActionNeeded()` silently creates no card at all; not yet a proven missed real-world case since the owning cron only runs in January and the feature was built after January 2026 already passed, but it would have silently failed on its next scheduled run). Both rows promoted to production directly, using sandbox's actual current content (which had drifted from the original migration file text on the ITIN row) rather than replaying stale file text. This audit turned out to be incomplete — see the 2026-08-27 entry above, which found three more gaps this pass missed. See todo-board.md for the ActEvent side of this same audit.)_
_Prior: 2026-08-26 — Claude (dev job 9b7892d6: a client confirming their P&L/Balance Sheet had no marked note at all — added `financials_attested` to `ChatEventKind`, `emitFinancialsAttestedEvent`/`retireFinancialsAttestedNote` in `lib/portal/chat-events.ts`, and an `EVENT_KEY_LABELS` entry ("Financials"). Placed the emit call in the ATTEST ROUTE's own awaited path — right after the confirmation write succeeds — not inside the pre-existing fire-and-forget handoff, so it can't be silently skipped the way that handoff already can be. Gated on the route's own before-value `confirmation_accepted` flag so a duplicate/re-entrant call never fires a spurious note; a genuine re-attestation (the flag gets reset to false by 9 separate correction paths in `lib/tax/attestation.ts` and re-confirmed later) retires the stale note first, same retire-and-re-emit shape as banking's resubmission handling.)_
_Prior: 2026-08-25 — Claude (dev job fb527ac8: banking wizard submissions via the portal wizard never produced a marked note, so they never surfaced here — a plain migration gap, not a deliberate exclusion. Added `banking_wizard_submitted` to `ChatEventKind`, a matching `emitBankingWizardSubmittedEvent`/`retireBankingWizardSubmittedNote` pair in `lib/portal/chat-events.ts`, and a `banking_wizard_submitted` entry in `EVENT_KEY_LABELS` so the panel shows "Banking" instead of the raw key. This doc did not exist before this change — seeded now per R107, since a Council review needed two full passes to rediscover facts that belong here.)_

## What it is
A per-account/contact feed of system-authored notes inside a client's portal-chat
thread, surfaced to staff as a red-dot "What's New" panel — "what did this specific
client just do that needs our attention." It is the **passive, per-client** signal:
you have to already be looking at that client to see it. It is **NOT** the same
system as the Notification Center / "TO DO — FROM CHATS" board (see
[todo-board.md](todo-board.md)) — that is a **cross-client, push** board of assigned
action cards. The two are commonly confused because they are built and emitted in
the same call sites and sometimes share event-name strings by coincidence (e.g. both
now have something literally called `banking_wizard_submitted` — one is a
`ChatEventKind` here, the other is a dormant, unrelated `ActEvent` catalog slug in
`lib/notifications/act-event.ts` — they do not fire each other).

## Business rules
- Antonio, 2026-05-18: "every different submission or thing that the client does and
  need our attention for the next step" must produce a topic in the client's
  portal-chat thread with a red unread badge.
- Staff-only. A client must NEVER see one of these notes — see Gotchas.
- **R103 exclusion:** these are system messages, not conversation — they never
  trigger the client-email notification cron (`notifyClientOfAdminMessage`).

## How it's built
- **Tables / columns:** `portal_messages` rows with `sender_type='system'` whose
  `message` body ends in an HTML-comment marker: `<!-- chat-event: kind=<kind>
  src=<table>:<id> -->`. No dedicated table — the marker IS the event.
- **Key files:**
  - `lib/portal/chat-events.ts` — the ONLY place allowed to write this marker.
    `emitClientChatEvent()` is the primitive (idempotent insert + dedup pre-check);
    one small `emitXxxEvent()` wrapper per event source (payments, documents,
    SS-4, offers, decisions, the tax/banking wizards, etc.) formats that source's
    message and calls it. **New event source → add a wrapper here, no other code
    change** (the file's own stated contract).
  - `app/api/crm/admin-actions/whats-new/route.ts` — the reader. `?counts=true`
    drives the purple per-thread dot; `?notes=true&account_id|contact_id` returns
    the feed for one client. Both filter `portal_messages` for the marker via
    `ilike '%<!-- chat-event:%'`.
  - `components/portal-chats/thread-whats-new-panel.tsx` — the UI. `EVENT_KEY_LABELS`
    maps an event_key to a friendly badge (falls back to the raw key string if
    missing — a real, visible gap, not a graceful default); `deepLinkFor()` maps a
    source table to an "Open" button destination (several recent event kinds have
    neither — an accepted, low-priority pattern, not unique to any one of them).
  - `app/api/portal/chat/route.ts:108-133` — the ONE place deciding client vs staff
    visibility. **Any message containing the marker is unconditionally hidden from
    client reads** (`.not('message', 'ilike', '%<!-- chat-event:%')`); staff reads
    additionally hide only `kind=payment_received` specifically (a past-complaint
    fix, 2026-07-02 — "duplicated it in the wrong place"), so every other event kind
    still renders inline in the staff conversation view AND in the What's New panel.
- **Config / catalog:** `catalog_entries` where `catalog_id='whats_new_events'` —
  per-event `visible` toggle + `suggested_step` override (Board Settings). An
  event_key with **no row here defaults to VISIBLE** — most kinds, including
  `wizard_submitted`, `banking_wizard_submitted`, and `lease_signed`, have no
  row at all today.
  `lib/notifications/whats-new-defaults.ts` (`WHATS_NEW_DEFAULT_STEPS`) is the
  code-side fallback "what to do" text when no catalog override exists.
- **Data flow (typical):** client action → route/handler calls the matching
  `emitXxxEvent()` → `emitClientChatEvent()` dedup-checks the marker → inserts →
  panel/dot pick it up on next poll/realtime refresh.

## Gotchas, invariants & past bugs
- **Dedup is permanent, not resolve-aware.** `emitClientChatEvent`'s idempotency key
  is `(source.table, source.id, event_kind)`, checked against `deleted_at IS NULL`
  only — there is no "has staff acted on this yet" reset. A source row that gets
  updated in place (not re-inserted) and fires the SAME event kind again — e.g. a
  client resubmitting a wizard for the same stable database row — produces **no
  second note, ever**, unless something explicitly retires the old one first
  (`retirePaymentReceivedNote`, `retireBankingWizardSubmittedNote` are the two
  existing retire-and-re-emit helpers; most event sources have none). Verified
  2026-08-25: this is not theoretical for banking — 7 real accounts in production
  have submitted the same provider 2-5 times, several separated by hours-to-weeks,
  before the retire helper existed. Check for a similar gap before adding any new
  wizard-style event source whose underlying row can be updated more than once.
- **A new `ChatEventKind` needs a friendly label or it renders as a raw string.**
  `EVENT_KEY_LABELS` in `thread-whats-new-panel.tsx` is not automatically kept in
  sync with the `ChatEventKind` union in `chat-events.ts` — add both in the same
  change.
- **The two-writes-per-event pattern exists on purpose for the banking wizard.**
  The client-visible confirmation for a banking submission was written BEFORE this
  primitive existed (commit `5500f263`, six weeks before `chat-events.ts` was
  created) and is a plain, unmarked `portal_messages` insert. Converting it into a
  marked note (instead of adding a second, separate marked note alongside it) would
  silently remove the client's own confirmation from their chat view — confirmed by
  reading `app/api/portal/chat/route.ts`'s client-side filter directly. Any future
  event source that ALREADY has a pre-existing client-visible chat note must follow
  the same two-write pattern, not replace it.
- **Two different "Notification Center"-sounding systems.** This doc (What's New,
  `portal_messages` markers) and [todo-board.md](todo-board.md) (`message_actions`
  cards via `emitActionNeeded`) are built independently and share literal event-name
  strings for several wizards (`tax_wizard_submitted`, `itin_wizard_submitted`,
  `formation_wizard_submitted`, `onboarding_wizard_submitted`, and now
  `banking_wizard_submitted`) purely by naming coincidence — firing one never fires
  the other. A session touching one must not assume it also covers the other.

## How to verify current state
- **A client's current What's New feed (staff view):**
  `GET /api/crm/admin-actions/whats-new?notes=true&account_id=<id>` (staff session).
- **Raw marker rows for one account:**
  `SELECT id, message, created_at, handled_at FROM portal_messages WHERE sender_type='system' AND account_id='<id>' AND message ILIKE '%<!-- chat-event:%' ORDER BY created_at DESC;`
- **Per-event visibility config:**
  `SELECT slug, metadata FROM catalog_entries WHERE catalog_id='whats_new_events' AND status='active';`
- Note (R096): use the **sandbox** MCP / `psql` for sandbox; `execute_sql` on the
  production MCP connection hits production.
