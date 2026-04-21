# Tax Pause + Billing/Services Refactor — Master Plan
_Last updated: 2026-04-20 evening (session handoff — new machine resumption)_

## HOW TO RESUME ON A DIFFERENT MACHINE (READ FIRST)

1. `git pull origin main` — pull the latest scripts in `scripts/sandbox-seed/`.
2. Sandbox access (if this machine doesn't have it):
   - `npm install -g vercel`
   - `vercel login` (browser approval, one-time)
   - `mkdir -p /tmp/td-sandbox-link && cd /tmp/td-sandbox-link`
   - `vercel link --project td-operations-sandbox --scope tony-durantes-projects --yes`
   - `vercel env pull ~/Developer/td-operations/.env.sandbox --environment=preview --yes`
   - `rm -rf /tmp/td-sandbox-link`
   - Then `cd ~/Developer/td-operations && npm install` to ensure `pg` is available.
3. Verify: `node scripts/sandbox-seed/_probe-state.js` should print sandbox enum + column snapshot from `xjcxlmlpeywtwkhstjlw`.
4. Plan is tracked in this file + `sysdoc tax-pause-billing-refactor-plan`. Resume at the "**CURRENT EXECUTION STATUS**" section below.

---

## CURRENT EXECUTION STATUS — 2026-04-20 evening

### Phase 0 — Tax Pause — COMPLETE IN SANDBOX
- 16 extension-ID updates applied (script `11-apply-extension-updates.js`).
- 3 remaining sandbox-placeholder IDs: Vairon Marketing LLC, Alma Accelerator LLC, Invictus Equity Group LLC.
- Bulk-park applied (`12-apply-bulk-park.js`): 64 tax-return SDs flipped active → on_hold.
- `tax_season_paused = true` in sandbox `app_settings`.
- Sandbox URL: `https://td-operations-sandbox.vercel.app`; admin `admin@sandbox.tonydurante.us`.

### Finance foundation — DEFERRED TO BANK-FEED-RECONCILIATION-MASTER PLAN
- 92 duplicate payment rows deleted (raw-insert bypass of `createTDInvoice()`).
- 1 truly new row kept: INV-002135 WM International LLC.
- 5 bank-feed reconciliations applied on pre-existing rows (Ambition Holding, Unique Commerce, Maria Augusta, Horus+UGC Italia combined, SDM revert).
- Finance work from here deferred to dev_task `d469604f-f556-4040-8687-4373bc53eda5`.

### Phase 1 — Additive Schema — COMPLETE IN SANDBOX
Script: `20-phase1-schema.js`. New enums (subject_type_enum, payment_type_enum). billing_type expanded 2→7. New columns on offers/contracts/account_contacts/accounts. Unique partial indexes. Transitional CHECK on payments.installment. Role casing normalized. service_catalog.contract_type backfilled on 12 null rows. offers.subject_type backfilled (172 account, 18 contact, 13 null). Phase 1 code tweaks (enum expansion in offer_create, decideInvoiceAtSigning, cron dedup) ROLLED INTO PHASE 3.

### Phase 2 — Data Backfill — IN PROGRESS

**Area 1 — Contracts backfill — DONE.** Script `22-phase2a-contracts-apply.js`. 5 renewal→formation retags (Adriano Graziosi/AG Group, Ricardo Midali/MDL Advisory, James Drury/Outriders, Mark Eke/PTBT Holding, Manuel Burdo/Stay Legit). Valerio Sicari annual_fee `'200010001000'`→`'2000'`. 44 contracts backfilled. Ahmed Sayed/UC Marketing pinned to Feb-23 contact. 13 duplicate-token contracts skipped.

**Area 2 — Primary contact flag — DONE.** Script `24-phase2b-primary-contact-apply.js`. Filter `account_type='Client' AND status NOT IN ('Cancelled','Closed')`. 229 writes: 210 single-contact auto + 19 multi-contact. 2 accounts with 0 contacts left uncovered: JAG RE Holdings LLC, UCCIO LLC.

**Area 3 — Accounts pricing backfill — NEXT (in_progress).** Populate `accounts.setup_fee_amount`, `setup_fee_paid_date`, `services_bundle_detail` from signed formation/onboarding contracts.

**Area 4 — Payments installment mapping — pending.** 195 NULL rows + normalize "One-time"→"One-Time".

**Area 5 — Service_deliveries billing_type mapping — pending.** 734 NULL rows + migrate 0 Standalone→One-Time Service.

**Area 6 — Duplicate contracts + wrong-owner cleanup — pending.** 6 duplicate tokens (13 rows), wrong-owner links (Magic Scale/Vladimir, Rise Communications/Ahmed, SD Studio/Daniele, Stepwell/Mohamed E., Terra Prime/Dirk), JAG RE Holdings + UCCIO missing contacts, Ahmed Sayed orphan contact (`38091b2a-5934-423f-ab2d-33928564c478`), 3 sandbox placeholder extension IDs, Nicola Bartolini annual_fee bug.

**Non-Client primary-contact pass — pending.** 28 active One-Time + 2 Partner accounts (excluded from area 2).

### Phase 3 — Switch logic — PENDING
`onFirstInstallmentPaid` reads selected_services; `activate-service` stamps billing_type + creates tax_returns row; 4 contract-signing pages expand routing; portal wizard expands routing; CRM dialog subject picker; pause/reactivation filters on billing_type='Installments'; closure-cascade DB trigger; return_type CHECK constraint; Nicola string-concat bug fix; **+ 3 deferred Phase 1 code tweaks.**

### Phase 4 — UI — PENDING
Client Journey on contact page; Contracts & Pricing on account page; offer subject picker.

### Production cut-over — PENDING
Coordinated rollout after sandbox QA: Phase 0 migrations, Phase 1 DDL, Phase 2 CSV-approved deltas, Phase 3+4 code merge.

---

## Key Antonio decisions (2026-04-20 — do NOT re-ask)

- **Currency** USD for foundation sync; **paid-date placeholder** 2026-02-15; **overdue due-date** 2026-01-31; **invoice numbering** QB format INV-######; **leave-alone rule** for rows with real payment evidence (Stripe/Whop/payment_method/paid_by_name). QB invoice_id ALONE is NOT payment evidence.
- **Combined-payment families**: Rodrigo Di Lauro (Partner Alliance + Morgan & Taylor, combined $2000); Marco Barbiero (Horus + UGC Italia, combined $2000 on 2026-01-07).
- **Mis-labeled renewals — all formation**: AG Group, MDL Advisory, Outriders, PTBT Holding, Stay Legit.
- **SMLLCs with wrong co-owner links**: Magic Scale (Vladimir is collaborator), Rise Communications (Ahmed doesn't belong, real owner Aly), SD Studio (Daniele is Selene's husband), Stepwell (Mohamed Essameldeen doesn't belong), Terra Prime (Dirk doesn't belong).
- **Not accounts but Partners**: Francesco Valentini (Portuguese NHR tax consultant), Fresh Legal Group LLC (not a client).
- **One-Time customers**: Full Throttle Media, Nexo Agency, PlayLover International, Simple Holdings USA.
- **Mohamed Mohamed Hassan Mahmoud Kosba** — doubled first name is CORRECT (not a data error).
- **Real co-members**: Nebroo (Giovanni + Silvia), PTBT Holding (Mark + Bernát).
- **Umberto Moretti account** — already Cancelled, no action needed.
- **Sese Marketing LLC** — sandbox shows Closed but Antonio says NOT closed — sandbox data drift.
- **YBR Consulting LLC** — Offboarding, excluded from foundation sync.
- **Deferred to Phase 3** (needs Setup Fee / One-Time Service vocabulary): Invictus Equity (Setup Fee $2000 new onboarding), Oh My Creatives ($3950 formation+ITIN for Damiano Mocellin MMLLC).

---

## Scripts inventory in `scripts/sandbox-seed/`

| Script | Purpose | Status |
|---|---|---|
| 01–10 | Pre-existing seed/clone/audit/bank-referral scripts | prior |
| `11-apply-extension-updates.js` | 16 extension-ID updates | APPLIED 2026-04-20 |
| `12-apply-bulk-park.js` | Bulk-park 64 TR SDs | APPLIED 2026-04-20 |
| `13-apply-finance-foundation.js` | Foundation sync — 92 duplicates rolled back | deleted after |
| `14-bank-feed-reconcile-batch1.js` | 5 bank-feed reconciliations | APPLIED 2026-04-20 |
| `20-phase1-schema.js` | Phase 1 additive schema | APPLIED 2026-04-20 |
| `21-phase2a-contracts-backfill-audit.js` + `21-phase2a-contracts-to-excel.py` | Read-only audit + Excel | one-shot |
| `22-phase2a-contracts-apply.js` | Phase 2 area 1 apply | APPLIED 2026-04-20 |
| `23-phase2b-primary-contact-audit.py` | Read-only Excel audit | one-shot |
| `24-phase2b-primary-contact-apply.js` | Phase 2 area 2 apply | APPLIED 2026-04-20 |
| `_probe-state.js`, `_probe-admin.js`, `_extension-diff.js`, `_read-account-official.py`, `_audit-account-official.py`, `_finance-match.{py,js}`, `_finance-match-fuzzy.js` | Utilities | one-shot |

---

## Process guardrails (enforce strictly)

- **R093 — NO ASSUMPTIONS.** Verify every column/table/enum by fresh tool call.
- **R095 — Plain English always.** No UUIDs / column names / backticks in user-facing replies.
- **R096 — Sandbox-first for DDL.** MCP `execute_sql` hits prod; sandbox uses `.env.sandbox` pg.
- **Read `accounts.notes` + `contacts.notes` BEFORE any proposal.**
- **Filter `account_type='Client'`** for client-specific work.
- **Never bypass `lib/portal/td-invoice.ts` or `lib/operations/payment.ts`** for writes to `payments`.
- **Dry-run before apply** for every data write.
- **Save `session_checkpoint`** after every significant action.

---

## Authoritative sources
- **This refactor plan:** `docs/tax-pause-billing-refactor-plan.md` (this file) + `sysdoc tax-pause-billing-refactor-plan`.
- **Deferred bank-feed reconciliation:** `sysdoc plan-bank-feed-reconciliation-master` + `dev_task d469604f`.
- **Antonio's authoritative client list:** `~/Library/CloudStorage/.../Luca/Account_Official_Enriched_v7_2.numbers` (updated 2026-04-20 12:41).
- **India's extension list:** `.../TD Clients/India Team/Extension 2025/Extension_List_2025_ALL_updated (1).xlsx`.
- **Sandbox Postgres:** ref `xjcxlmlpeywtwkhstjlw` via `.env.sandbox` SUPABASE_DB_URL (Preview + Development).
- **Canonical helpers:** `lib/portal/td-invoice.ts`, `lib/portal/unified-invoice.ts`, `lib/operations/payment.ts`, `lib/bank-feed-matcher.ts`.

---

## Core model (payment types, billing types, subject routing, contract types, invoice-at-signing, contact de-dup, formation vs onboarding) and the 6 legacy bugs — unchanged from original plan. Canonical definitions live in `sysdoc tax-pause-billing-refactor-plan`.
