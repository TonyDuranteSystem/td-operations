# TD Books (My Finances — the owner's company books)
_Last verified against code: 2026-07-29 — Claude (Phase 1a: dedicated `td_books_transactions` table, sandbox-applied; prod pending Antonio's DDL run)_

## What it is
Antonio's own company books — Tony Durante LLC's money, kept separate from the client-facing Finance section. Finance holds ONLY client invoice payments (Antonio's binding rule, 2026-07-27); everything else — Stripe payouts, transfers between TD's own accounts, bank rewards, vendor spending — flows into **My Finances** (`/owner`, admin-only). This ledger is the foundation for the S-corp books project (dev job `81fb5a05`): P&L, balance sheet, equity roll-forward matching the filed 1120-S.

## Business rules
- **Privacy:** staff who work invoices in Finance must never see the owner's business activity. `/owner` is gated by `isAdmin` (`ADMIN_EMAILS`), and the Finance page filters `outgoing`/`owner_ledger`/`td_expenses` server-side for non-admins.
- **Invoice-first routing (Antonio, verbatim):** *"a system that will recognize the payments that are NOT from clients for invoices… if something is wrong or the system doesn't know, put it in My Finances, with a button 'this is for client' to put it back in Finance."* Unrecognised money lands here by default; both directions are one human click.
- **Nothing is auto-booked.** Every projected row starts `category='uncategorized'`; Antonio (or a bookkeeper flow) categorizes. The S-corp plan's vocabulary target is the CPA's Statement-3 expense categories from the filed 2024 1120-S.
- **Income for the books comes from the PAYMENTS ledger, not this table** (Phase 1b): 486 of 499 paid invoices have no bank-feed link, so bank rows can never be the revenue source. This table carries expenses, transfers, distributions, and the cash side.

## How it's built
- **Table: `td_books_transactions`** (migration `20260729-1500`, retirement of the old slice `20260729-1600`). Previously the books lived as a slice of the multi-tenant `bank_transactions` (client tax data + owner rows separated only by a sentinel account UUID) — named by three council reviews as the biggest corruption risk in the books plan. Now separated; `bank_transactions` is client-tax-only again.
- **`entity_id` from day one** (Antonio's multi-entity flexibility ask): today only Tony Durante LLC = `TD_ENTITY_ID` (`00000000-0000-0000-0000-000000000001`, exported from `lib/owner-finance.ts`; `OWNER_ACCOUNT_ID` is a deprecated alias). A second company's books are an INSERT away.
- **Identity = `UNIQUE (entity_id, transaction_ref)`** — deliberately NOT the old 4-column key (date+amount in the key turns an upstream amount correction into a duplicate row). Refs: `feed:<td_bank_feeds.id>` for projected rows; import refs for CSV rows.
- **Key files:** `lib/owner-finance.ts` (queries, categories, TD_ENTITY_ID), `lib/finance/owner-ledger-projection.ts` (the router + projection — see banking-bankfeed.md for the routing rule itself), `app/api/owner/transactions/` (+ `bulk`, `import`, `to-finance`), `app/(dashboard)/owner/` (UI).
- **Data flow:** bank feeds sync → `sweepFeedsToOwnerLedger` (Step 4b of `check-wire-payments`, every 6h) routes non-invoice money here via INSERT-ONCE upsert (`onConflict: entity_id,transaction_ref`, `ignoreDuplicates: true`) → Antonio categorizes in `/owner` → (Phase 1b+) books reports.
- **Category CHECK** includes `contribution` (S-corp equity roll-forward needs it; the client vocabulary already had it).

## Gotchas, invariants & past bugs
- **INSERT-ONCE, never update-on-conflict** (architect blocker): a books row is STATEFUL once categorized — a re-sweep that updated on conflict would silently wipe Antonio's categorization. `ignoreDuplicates: true` everywhere the projection writes.
- **"This is for a client →" DELETES the books copy BEFORE restoring the feed** — leaving it would count the money twice.
- **Signed amounts:** feeds store absolute values with direction in `status='outgoing'`; the projection signs them. A raw copy books an expense as income.
- **`bookkeeper_review_items.tx_id`** FK was re-pointed to `td_books_transactions` in `20260729-1600` — ids were preserved in the copy exactly so this repoint (and any future one) is trivial.
- **The old owner P&L numbers are NOT books** — flat-25%+SE tax is wrong for an S-corp (filed return: CASH method, officer comp, AAA roll-forward, Stripe Clearing asset). Do not present them as books until Phase 1b+ ships.
- **supabase-js returns errors, doesn't throw** — every write here must check `error`.

## How to verify current state
- Table + rows: `SELECT count(*), round(sum(amount),2) FROM td_books_transactions WHERE entity_id='00000000-0000-0000-0000-000000000001'` — compare against `/owner` totals.
- Old slice retired: `SELECT count(*) FROM bank_transactions WHERE account_id='00000000-0000-0000-0000-000000000001'` must be **0**.
- Category gate (the Phase 1a "every number identical" check): `SELECT tax_year, category, count(*), round(sum(amount),2) FROM td_books_transactions GROUP BY 1,2 ORDER BY 1,2`.
- Round-trip: plant a `STRIPE - TRANSFER` feed row in sandbox, run the sweep, confirm the row lands with ref `feed:<id>`, then `sendOwnerLedgerRowToFinance` — copy gone, feed back to `unmatched`.
