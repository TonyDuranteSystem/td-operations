# Tax Pause + Billing/Services Refactor — Master Plan

_Last updated: 2026-04-19. Active. Resume here next session._

## Current status

- Phase 0 sandbox dry-run **DONE** — 22 audit rows applied with placeholder extension IDs.
- Blocked on: Antonio to (a) provide real extension IDs tomorrow, (b) log in to sandbox and review, (c) confirm Phase 0.1 code fix.
- Next executable step: Phase 0.1 code fix (pause exemption for One-Time TR SDs) once diff is approved.

---

## What started this

- Original ask: pause 2026 tax season, park 185 active Tax Return SDs at `on_hold`, show "extension filed" banner until 2nd installment paid.
- Investigation uncovered 6 legacy bugs + fundamental gap in billing/services vocabulary. Scope expanded.

---

## Core model (agreed with Antonio)

### Payment types (6-value enum on `payments.installment`)
1. **Setup Fee** — one-time at start of Client relationship (year 1).
2. **Installment 1 (Jan)** — first half of split annual renewal.
3. **Installment 2 (Jun)** — second half of split annual renewal.
4. **Annual Payment** — single yearly payment for a one-service renewal (e.g. CMRA-only).
5. **One-Time Service** — single payment for a non-recurring service (notary, shipping, ITIN, standalone TR, etc.). Can be bought by either a Contact or an Account.
6. **Custom** — ad-hoc / manual / anything else. No downstream pipeline enforced. Invoice whenever without following the normal chain.

### Billing types (6-value enum on `service_deliveries.billing_type`)
1. **Setup Fee** — funded by Setup Fee payment.
2. **Installments** — funded by 2-part annual renewal (only this billing_type triggers the 2nd-installment gate).
3. **Annual Payment** — funded by single yearly payment.
4. **One-Time Service** — funded by One-Time Service payment.
5. **Included** — $0 line bundled into another payment, no direct charge.
6. **Custom** — ad-hoc, no automated pipeline behavior.

### Subject routing
Every offer has a subject declared at creation:
- **Contact** — individual sale (formation, onboarding, notary, shipping, standalone ITIN/TR, consulting, closure for individuals, CMRA-only renewal for an individual, custom). Account may be created later (formation, onboarding) or never.
- **Account** — for existing company (renewal, extras for active clients, closure).

CRM entry points: offer creation on Contact page pre-fills subject=contact; on Account page pre-fills subject=account; top nav asks. MCP `offer_create` takes `subject_type` + `subject_id` (contact or account).

**Signer rule**: subject=Contact → the contact signs. subject=Account → the **primary contact** of that account signs (`account_contacts.is_primary=true`). For Formation/Onboarding where account doesn't exist yet, the contact themselves signs.

### Contract type
Driven by `service_catalog.contract_type` — not a hardcoded code-level enum. Any active catalog row's contract_type is allowed. `'custom'` is the escape hatch. Antonio can add services freely; the offer flow picks them up automatically. "Inclusa" / "Included" is an Italian-only label on the offer page representing `price='$0'` (bundled into Setup Fee or Annual Fee); downstream DB + code is always English.

### Invoice at signing (applies to ALL offers)
Every offer signing creates an invoice (contact-only if account doesn't exist yet). **Renewal is no longer exempt** — signing in Feb/March/November all produces Installment 1 invoice immediately. Installment 2 is invoiced on June 1 (or at signing if signing happens after June). Bank transfer reference carries the INV number for wire matching. **Post-September Formation/Onboarding rule**: clients onboarded/formed from September onward skip the January Installment 1 next year; first invoice for them is June's Installment 2.

### Contact de-duplication
`offer-signed` webhook checks by email first. One contact, many journeys. An individual who buys notary today + forms an LLC 6 months later stays as ONE contact with 2+ contracts in their history.

### Formation vs Onboarding account-creation timing
- **Formation**: account created when Articles return from state (via `formation_confirm`). Partial info only at that moment: `company_name`, `state_of_formation`, `formation_date`, `filing_id`. EIN is NULL until IRS returns confirmation letter (separate SS-4 wizard flow).
- **Onboarding**: account created on wizard submit with FULL info (name, EIN, formation_date, filing_id, Articles uploaded, EIN letter uploaded, passport uploaded).
- Both: offer signed contact-first, account_id=null; account_id backfilled when account is created.

---

## The 6 legacy bugs

| # | Bug | Root cause | Fix phase |
|---|-----|-----------|-----------|
| 1 | SD stage "1st Installment Paid" misleading for non-Annual clients | Stage name not semantic; `pipeline_stages` has cleaner stage 0 "Paid - Awaiting Data" unused | Phase 3 (rename + route by billing_type) |
| 2 | `onFirstInstallmentPaid` creates TR SD unconditionally for every Client | No source of truth for "services included in client's contract" | Phase 3 (read from signed renewal contract's `selected_services`) |
| 3 | `is_test=true` on account doesn't propagate to SDs | `createSD` never reads `accounts.is_test` | Phase 0.3 (one-line fix + retroactive UPDATE) |
| 4 | `accounts.status='Closed'` set directly doesn't cascade-cancel SDs | Cascade only fires on Company Closure SD advance to "Closing" | Phase 3.6 (DB trigger, EXEMPT active Tax Return SDs so final TR can be filed) |
| 5 | `return_type='Smllc'` lowercase | Not a real DB bug — user input in Numbers file. No `Smllc` values in production data. | Phase 3.7 (CHECK constraint as guard against future drift) |
| 6 | Active TR SDs missing `tax_returns` rows | `activate-service` creates SD without tax_returns row; only `onFirstInstallmentPaid` + `tax_return_intake` populate it | Phase 3.2 (activate-service creates both atomically) |

---

## Additional known issues (beyond the 6 bugs)

### Double-submit contract duplicates (6 known cases)
6 production offer_tokens with 2+ `contracts` rows for the same signing:
- `alex-vitucci-2026` (2 rows, same `llc_type` + `annual_fee`, 21h apart — double-click)
- `nicola-bartolini-2026` (3 rows, `annual_fee=200010001000` — **string-concat parsing bug** in `app/offer/[token]/contract/page.tsx:492` — numbers are being joined as strings for some input shapes)
- `renewal-deeplink-solutions-llc-2026`, `renewal-elite-international-group-llc-2026`, `renewal-finaltouch-editors-llc-2026`, `test-demo-2026` (each 2 rows, seconds apart — double-click)

**Fix**: Phase 3 adds `unique (offer_token, contact_id, DATE(signed_at))` partial index + frontend button debounce. For Nicola specifically, investigate and fix the string-concat bug separately.

### `contracts.selected_services` column dead
Column exists on `contracts` table but never populated (NULL on all 57 rows). All 4 signing pages (`page.tsx`, `renewal-agreement.tsx`, `service-agreement.tsx`, `standalone-service-agreement.tsx`) must write it at signing → Phase 3.3.

### Accounts missing pricing columns populated
- `accounts.setup_fee_amount`: 0 of 313 accounts populated (dead column today)
- `accounts.installment_1_amount`: 236 of 313 populated
- `accounts.services_bundle`: 298 of 313 populated as comma-string (not JSONB)
- Phase 2 backfills all three from signed contracts.

### 13 Postgres views missing in sandbox
Non-blocking for Phase 0. Used by dashboards and `msg_inbox` MCP tool. Recreate later, not a blocker.

### 24 vs 22 extension-gap mismatch
My broader scan found 24 active/on_hold Tax Return SDs with missing extension data. Antonio's audit file had 22 rows. The 2 extras in my scan but not in his file need to be surfaced to him after Phase 0. Possibly newer SDs created after the audit was generated, or SDs I scanned with slightly different criteria.

---

## Gap in my Phase 0 pause code (shipped earlier, needs fix before go-live)

- `activate-service` and `installment-handler` park new Tax Return SDs at `on_hold` when `tax_season_paused=true`.
- But **One-Time Tax Return clients pay upfront** — no 2nd installment to reactivate on.
- My reactivation cron only matches Installment 2 payments → One-Time parked clients would be stuck forever.
- **Fix (Phase 0.1)**: both code paths check that the SD is Installments-funded before parking. Standalone/One-Time stays `active`. Small change.

---

## Phase plan

### Phase 0 — Tax pause unblock (days)

| Step | What | Status |
|------|------|--------|
| 0.1 | Code: pause exemption for One-Time TR in activate-service + installment-handler | Pending — ready to code on Antonio's go |
| 0.2 | Data: 22 audit row fixes | **DONE in sandbox** (placeholder IDs); prod run pending real IDs |
| 0.3 | is_test propagation: createSD fix + one-off UPDATE on existing rows | Pending, included in Phase 0 push |

After Phase 0: can flip `tax_season_paused=true` in production safely.

### Phase 1 — Additive schema (~1 week)

All additive, non-breaking. Existing code unaffected.

- `offers`: `subject_type` enum, `contact_id` FK
- `contracts`: `contact_id`, `account_id`, `invoice_id` FKs; `payment_type` enum; populate `selected_services`; unique partial index `(offer_token, contact_id, DATE(signed_at))` to block double-submit
- `payments`: CHECK constraint for 6-value enum (transitional — accepts old values too)
- `service_deliveries`: expand `billing_type` enum 2→6 values
- `account_contacts`: `is_primary` boolean + unique partial index; normalize `owner→Owner`, `member→Member` (leave descriptive free-text alone)
- `accounts`: populate existing `setup_fee_*` cols; add `services_bundle_detail` JSONB
- `service_catalog`: backfill `contract_type` for notary, shipping, closure, consulting, certificate_of_incumbency
- `offer_create` tool: `contract_type` validated against `service_catalog` (no hardcoded enum); add `subject_type` + `contact_id` params
- `decideInvoiceAtSigning`: remove `renewal` exception
- `annual-installments` cron: dedup against at-signing invoices

### Phase 2 — Data backfill (~3-4 days + Antonio review)

Sandbox first, review CSVs together, then prod.

- Contracts: `contact_id` (via offer→lead→converted_to_contact_id), `account_id` (via offer.account_id), `payment_type` (derived from contract_type), `selected_services` (from offers.services at signing moment — best-effort)
- Payments: map 195 NULL-installment rows to enum via description patterns
- SDs: map existing `billing_type` Included→Included, Standalone→One-Time Service; NULL resolved from heuristics
- Accounts: populate `setup_fee_amount`, `setup_fee_paid_date`, `services_bundle_detail` from signed contracts
- `account_contacts.is_primary`: SMLLC auto (1 contact per account); MMLLC via Formation/Onboarding contract signer lookup
- Duplicate contracts: review + delete the 6 known duplicates together with Antonio

Every script outputs "applied" vs "needs Antonio's decision" CSVs.

### Phase 3 — Switch logic (~1 week)

Code reads new vocabulary. Old fallbacks removed.

- `onFirstInstallmentPaid`: read renewal contract's `selected_services`; create SDs only for sold services (fixes Bug 2 — RelationBox/DigitalBox wouldn't get unwanted TR SDs)
- `activate-service`: stamp `billing_type` on every SD at creation; create `tax_returns` row alongside every Tax Return SD (fixes Bug 6)
- Contract-signing pages (4): populate `contact_id`, `account_id`, `invoice_id`, `selected_services`, `payment_type`; debounce submit; expand `standalone-service-agreement` routing in `page.tsx:778-794` beyond `tax_return`+`itin` to cover notary/shipping/closure
- CRM dialog: subject picker; `contract_type` dropdown from catalog
- Pause/reactivation code: filter on `billing_type='Installments'` only
- DB trigger on `accounts.status UPDATE → 'Closed'`: cascade-cancel SDs, **EXEMPT** Tax Return SDs that are still active/on_hold (forces closure workflow to handle final TR first)
- `return_type` CHECK constraint / trigger to prevent casing drift
- Fix Nicola Bartolini string-concat bug in `contract/page.tsx:492` (`installmentJan + installmentJun` behaves weirdly for certain inputs)

### Phase 4 — UI (~1 week, independent of Phase 3)

- Contact page "Client Journey" — chronological contracts + payments + SDs + accounts linked
- Account page "Contracts & Pricing" — per-contract view with setup fee, installments, included services
- Offer dialog: "Who is this for?" subject picker; filtered contract_type list

---

## Special cases

### Marvin Al Rivera (Pending Company placeholder)
- Pre-Workstream-B standalone business TR customer. Signed before 2026-04-12 code fix.
- **Phase 0.2 sandbox state**: SD migrated to `stage='Company Data Pending'`, `stage_order=-1`, `account_id=NULL`. Placeholder account renamed Suspended, ready for cleanup once real account is created.
- **Next**: when Marvin submits company_info wizard, `tax_return_intake` handler creates real account, SD gets linked. Manually attach real `extension_submission_id` on the `tax_returns` row the intake handler creates.
- **Why fix, not leave alone**: Antonio expects he may return next year as another One-Time customer. Clean shape now saves pain later.

### Financialot LLC (Closed account, final TR)
- `accounts.status='Closed'` set directly (not via closure pipeline).
- 2025 is the final tax year (Antonio confirmed).
- **Phase 0.2 state**: `tax_returns` row created for 2025, SMLLC, `extension_filed=true` + placeholder ID. SD stays `active` so India can file the final return. Account stays Closed.
- **Phase 3.6** closure cascade must EXEMPT active Tax Return SDs — otherwise future Closed accounts with final TRs pending would lose the SD.

### Uxio Test LLC (test account data leak)
- `accounts.is_test=true` but all SDs had `is_test=false`.
- **Phase 0.2 state**: all SDs marked `is_test=true`; Tax Return SD cancelled (test account, no real TR work).

### Alma Accelerator LLC (One-Time exemption test)
- One-Time customer, single payment upfront ($1000 for tax return package).
- No 2nd installment will ever come → must not be parked at `on_hold`.
- **Phase 0.2 state**: `tax_returns` row created 2025 SMLLC with `extension_filed=true` + placeholder. SD stays `active`.
- Serves as the sandbox test case for Phase 0.1 code fix: verify she's NOT parked when flag flips.

### MMLLC primary signer (DEFERRED)
- 44 MMLLC accounts, 19 with multiple contacts, `ownership_pct=NULL` on 18 of 19 → ownership heuristic useless.
- **Deferred** per Antonio: fix everything else first, test in sandbox, then tackle MMLLC separately.
- Planned approach: backfill `is_primary=true` from Formation/Onboarding contract signer. Ambiguous cases flagged for Antonio.
- Antonio's rule: "the primary owner who signed the SS-4 always signs."

---

## Sandbox state (2026-04-19 evening)

### Infrastructure
- Supabase project: `xjcxlmlpeywtwkhstjlw`
- Vercel preview: `td-operations-sandbox.vercel.app` (separate Vercel project from main prod)
- Schema: matches prod (13 views missing, non-blocking for Phase 0)
- Local env: `.env.sandbox` (gitignored)

### Seeded data (via `scripts/sandbox-seed/`)
- `service_catalog`: 17 rows
- `app_settings`: 2 rows (`tax_season_paused=false`)
- `pipeline_stages`: 56 rows
- 22 audit accounts + 23 contacts + 22 account_contacts
- 17 offers, 2 contracts, 2 pending_activations
- 142 SDs, 31 payments, 12 tax_returns, 40 tasks, 4 wizard_progress

### Auth users
- 23 test users, password `TDsandbox-2026!`
- Login: `https://td-operations-sandbox.vercel.app/portal/login`
- Example emails: `uxio74@gmail.com`, `almainvestllc@gmail.com`, `bfortunato@avorgate.com`, `rivera.marvinal@gmail.com`

### Scripts
- `scripts/sandbox-seed/01-seed-reference.js` — service_catalog + app_settings
- `scripts/sandbox-seed/02-seed-accounts.js` — 22 accounts + related rows (idempotent)
- `scripts/sandbox-seed/03-create-auth-users.js` — Supabase Auth users
- `scripts/sandbox-seed/04-phase0-data-fixes.js` — 22 decisions
- `scripts/sandbox-seed/04-diff-report.md` — generated diff

### Sandbox seeding gotchas hit (fixed)
- `tax_returns.deadline` is NOT NULL — seed must compute original IRS deadline (Mar 15 for MMLLC/S-Corp, Apr 15 for SMLLC/Corp) at insert time.
- `offers` doesn't have unique constraint on `token` in sandbox — use `id` as upsert conflict column.
- `documents` FK references `document_types` reference table (not cloned) — skipped in the seed. Revisit if document workflows need testing.
- `accounts` row can't be deleted if `payments.account_id` still references it → for Marvin, rename/suspend placeholder instead of delete.

---

## 22 audit decisions (sandbox-applied)

| Company | Action | tax_year | return_type |
|---------|--------|----------|-------------|
| Avorgate LLC | extension_filed + park | 2025 | Corp |
| Beril LLC | extension_filed + park | 2025 | Corp |
| Entregarse US LLC | extension_filed + park | 2025 | Corp |
| Flowiz Studio LLC | extension_filed + park | 2025 | SMLLC |
| Fulfil Partners LLC | extension_filed + park | 2025 | SMLLC |
| KG Wolf Consulting LLC | extension_filed + park | 2025 | SMLLC |
| Lida Consulting LLC | extension_filed + park | 2025 | SMLLC |
| Lucky Pama LLC | extension_filed + park | 2025 | Corp |
| Matsonic LLC | extension_filed + park | 2025 | SMLLC |
| Tube Marketing Ninja LLC | extension_filed + park | 2025 | SMLLC |
| Unique Commerce LLC | extension_filed + park | 2025 | SMLLC |
| Vairon Marketing LLC | extension_filed + park | 2025 | SMLLC |
| VSV210 LLC | extension_filed + park | 2025 | Corp |
| Invictus Equity Group LLC | extension_filed + park | 2025 | SMLLC |
| Kasabi Ocean Global LLC | extension_filed + park | 2025 | SMLLC |
| Alma Accelerator LLC | extension_filed, **NOT parked** (One-Time exemption) | 2025 | SMLLC |
| DigitalBox LLC | cancel TR SD (only RA + State Renewal sold) | — | — |
| RelationBox LLC | cancel TR SD (only RA + State Renewal sold) | — | — |
| Italiza LLC | cancel TR SD (no tax return sold) | — | — |
| Uxio Test LLC | cancel TR SD + mark all SDs is_test=true | — | — |
| Financialot LLC | extension_filed + **SD stays active** (final TR, account already Closed) | 2025 | SMLLC |
| Pending Company — Marvin Al Rivera | migrate to Workstream B (SD → Company Data Pending, account_id=NULL, placeholder Suspended) | 2025 | SMLLC |

Placeholder IDs: `EXT-SANDBOX-<company-slug>-2025`. Swap for real IDs before prod run.

Total: 15 park + 1 no-park (Alma) + 3 cancel (no sale) + 1 cancel (test) + 1 final-TR (Financialot) + 1 migrate (Marvin) = **22 ✓**.

---

## Decision log

### 2026-04-19
- Agreed 6-value `payment_type` + 6-value `billing_type` enums with `Custom` escape hatch.
- `Custom` contract_type = full flexibility, no pipeline/chain forced. Invoice any time.
- Removed `renewal` exception from invoice-at-signing policy. All offers produce an invoice at signing.
- Confirmed contact-first model. One contact, many contracts. Email-based dedup already in `offer-signed` webhook.
- `contract_type` must be extensible (data-driven from `service_catalog`, not hardcoded enum in code).
- Financialot: 2025 is final tax year.
- Marvin: migrate to Workstream B flow now (not leave alone).
- Sandbox PII: OK to clone real names/emails.
- Pre-signing renewals: always invoice Installment 1 at signing, regardless of calendar month. Post-September Formation/Onboarding rule preserved.
- Closure cascade exemption: raise exception if Tax Return SD is active/on_hold when setting `accounts.status='Closed'` directly.
- MMLLC primary signer: deferred after Phase 0 testing.
- MMLLC signer rule: "the primary owner who signed the SS-4 always signs."

---

## Open items for Antonio (tomorrow 2026-04-20)

1. Provide real `extension_submission_id` for 16 accounts (groups A + Financialot): Avorgate, Beril, Entregarse US, Flowiz Studio, Fulfil Partners, KG Wolf Consulting, Lida Consulting, Lucky Pama, Matsonic, Tube Marketing Ninja, Unique Commerce, Vairon Marketing, VSV210, Alma Accelerator, Invictus Equity Group, Kasabi Ocean Global, Financialot. (Marvin will get his attached when he completes the company_info wizard.)
2. Log in to sandbox portal, test a few accounts. Key cases: Alma (should see normal tax banner), Avorgate (after Phase 0.1 code + sandbox flag flip → should see pause banner with placeholder ID).
3. Review `scripts/sandbox-seed/04-diff-report.md`. Spot-check any 22 rows.
4. Confirm green light for Phase 0.1 code fix.
5. (Eventually) surface the 2 extras from the 24-vs-22 mismatch so he can decide on those too.

---

## Files created this session

### Code
- `scripts/sandbox-seed/01-seed-reference.js`
- `scripts/sandbox-seed/02-seed-accounts.js`
- `scripts/sandbox-seed/03-create-auth-users.js`
- `scripts/sandbox-seed/04-phase0-data-fixes.js`
- `scripts/sandbox-seed/04-diff-report.md` (generated)

### Config
- `.env.sandbox` (gitignored, added to `.gitignore`)

### Docs
- This plan: sysdoc `tax-pause-billing-refactor-plan` + mirror at `docs/tax-pause-billing-refactor-plan.md`

---

## Resume-next-session cheatsheet

1. `sysdoc_read('tax-pause-billing-refactor-plan')` — this doc.
2. Check if Antonio provided real extension IDs. If yes: swap placeholders in `scripts/sandbox-seed/04-phase0-data-fixes.js` and queue for prod run.
3. Phase 0.1 code fix status: look for branch `fix/tax-pause-one-time-exemption` or a commit on main.
4. Sandbox state check: `node -e "require('dotenv').config({path:'.env.sandbox'})..."` to query sandbox Supabase.
5. Pending Antonio actions (see "Open items" above).
