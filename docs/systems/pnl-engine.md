# P&L / Balance Sheet Engine
_Last verified against code: 2026-06-30 — Claude (ONE-ENGINE refactor + standalone /tools/pnl. Extracted the pure `buildPnlWorkbook` out of `generatePnlExcel` (lib/pnl-generator.ts) so the workbook logic has no DB dependency; deleted the ~256-line duplicated ExcelJS workbook inside `bank_statement_pnl` (lib/mcp/tools/bank-statements.ts) — it now delegates to `generatePnlExcel`. New staff tool `/tools/pnl` (existing-client + external/ad-hoc modes) + API routes, both routing through the same engine. New pure helper `lib/pnl-external.ts` maps uploaded CSVs to bank_transactions row shape in memory (no DB writes). Added `ParseOptions.disableAi` to lib/bank-statement-parser.ts so external mode never runs in-request AI.)_

## What it is
The single engine that turns a company's categorized bank transactions into the deliverable **5-sheet Excel** — P&L Statement, comparative Balance Sheet (IRS Form 1065 Schedule M-2 capital roll-forward), Income Detail, Expense Detail, Distributions — in USD (IRS yearly-average FX), with K-1 allocation per member. It is what the tax wizard produces automatically, what the `bank_statement_pnl` MCP tool produces on demand, and what the new `/tools/pnl` staff page produces for existing clients **or** for ad-hoc companies that are not in the CRM.

The design principle (Antonio, 2026-06-30): **exactly one engine, no duplicates.** The MMLLC tax-wizard engine is the one that has been hardened through real client issues (signed contra-expense, contributions-as-equity, real M-2 capital accounts, multi-currency). Everything routes through it so identical inputs always yield the identical document.

## Business rules
- **USD only** — all US returns are filed in USD; non-USD amounts convert at the **IRS yearly-average rate** (`irs_exchange_rates`), falling back to 1:1 when a rate is missing.
- **Contributions are equity, never revenue** (F3); **refunds/reversals are signed contra-expense, not `Math.abs`** (F4) — these live in `computePnlTotals` and are covered by `tests/unit/pnl-totals.test.ts`. Don't reintroduce `Math.abs` on expense/COGS totals.
- **K-1 allocation** is `netIncome × member.ownership_pct` per member. External mode requires member ownership to total **100% (±0.5)** — same tolerance as the tax wizard.
- **External mode is CSV-only (v1)** and writes **nothing** to the database — a company with no `accounts` row cannot be persisted (`bank_transactions.account_id` is FK-bound to `accounts`), and PDF→AI extraction is too slow for a synchronous request.
- **`/tools/pnl` existing-client mode never ingests statements** — it only reads already-processed `bank_transactions`. If none exist it returns a clear message pointing at `bank_statement_process` / the client's tax wizard (see the gotcha on the timeout outage).

## How it's built
- **Tables:** `bank_transactions` (source rows, per account+tax_year), `irs_exchange_rates` (read-only FX), `accounts` + `account_contacts` (company name + members/ownership for the CRM path). No new table.
- **Key files:**
  - `lib/pnl-generator.ts` — `buildPnlWorkbook(input)` (PURE, no DB — the engine), `generatePnlExcel(accountId, taxYear)` (fetches then delegates — the CRM path), `computePnlTotals` (pure totals math), `generatePnlCsv` (accountant CSV package), `getIrsRate` (exported).
  - `lib/pnl-external.ts` — `parseExternalStatements(files, memberNames, taxYear)`: parse uploaded CSVs in memory (deterministic only, `disableAi`), categorize, map to `bank_transactions` row shape, year-filter. **No persistence.**
  - `lib/mcp/tools/bank-statements.ts` — `bank_statement_pnl` MCP tool: delegates the workbook to `generatePnlExcel`; keeps its own lightweight fetch + `computePnlTotals` only for the rich text summary. (Statement ingestion `bank_statement_process` is documented in `banking-bankfeed.md`.)
  - `app/(dashboard)/tools/pnl/{page.tsx,pnl-form.tsx}` — staff UI (two-mode toggle), `isDashboardUser`-gated.
  - `app/api/tools/pnl/generate/route.ts` (existing-client) + `generate-external/route.ts` (ad-hoc). Multipart FormData, `maxDuration=60`, `action_log` on the client-mode Drive save.
- **Other callers of `generatePnlExcel` (all unchanged, all one engine):** `lib/jobs/handlers/tax-form-setup.ts`, `app/api/tax-form-completed/route.ts`, `app/api/portal/tax-financials/download/route.ts`, `lib/tax/attest-handoff.ts`.
- **Data flow — CRM path:** fetch account context + current & prior `bank_transactions` + IRS rates → `buildPnlWorkbook` → xlsx. **External path:** typed company/members + uploaded CSVs → `parseExternalStatements` (in-memory rows) → IRS rate read → `buildPnlWorkbook` → xlsx (download only).

## Gotchas, invariants & past bugs
- **Do NOT re-duplicate the workbook builder.** `bank_statement_pnl` used to hand-roll its own ExcelJS workbook; it had **drifted** to an old single-year balance sheet with an FX-adjustment plug while `generatePnlExcel` gained the comparative M-2 version — so the same client/year produced two different Balance Sheets depending on the path. Fixed 2026-06-30 by deleting the duplicate. Any new "generate a P&L" surface MUST call `generatePnlExcel` (CRM) or `buildPnlWorkbook` (in-memory), never a fresh workbook.
- **No synchronous statement ingestion in a request.** `docs/systems/tax-returns.md` records a real production outage where synchronous parse+categorize+insert+AI inside a request handler overran the serverless timeout (the portal upload route had to become an async job). `/tools/pnl` existing-client mode therefore refuses to ingest; external mode is CSV-only + `disableAi` (no AI network call in-request).
- **External mode writes zero DB rows** — this is the core safety property. The mapped rows (`lib/pnl-external.ts::toBankTxRow`) carry `account_id: null` and are never inserted. If you extend external mode, keep it in-memory.
- **`buildPnlWorkbook` throws on empty transactions** — callers must surface that as guidance, not a 500 (the CRM route maps it to a 422).

## How to verify current state
- Read `lib/pnl-generator.ts` — confirm `generatePnlExcel` delegates to `buildPnlWorkbook` and `bank_statement_pnl` (in `bank-statements.ts`) calls `generatePnlExcel`, i.e. one engine.
- `npm run test:unit` — `pnl-totals.test.ts` (totals math), `build-pnl-workbook.test.ts` (pure builder, 5 sheets), `pnl-external.test.ts` (in-memory mapping, no persistence).
- External mode writes nothing: generate an external P&L in sandbox, then `SELECT count(*) FROM bank_transactions WHERE account_id IS NULL;` — it must not increase (verify via the sandbox connection string / `psql`, not `execute_sql` which hits production — R096).
- A client's P&L via MCP: `bank_statement_pnl({account_id, tax_year})` on the sandbox connection → confirm the Balance Sheet sheet is the comparative (two-year) M-2 version.
