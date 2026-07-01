# P&L / Balance Sheet — Excel export engine
_Last verified against code: 2026-07-01 — Claude (Reframed. There are TWO P&L computations in the codebase and the tax-financials one is authoritative — see below. The earlier standalone `/tools/pnl` parallel build on `generatePnlExcel` was SCRAPPED and replaced by exposing the real tax-financials system to staff — that lives in **tax-returns.md**. This doc now covers only the Excel export layer.)_

## What it is
The code that turns computed financials into the downloadable **Excel workbook** (P&L + Balance Sheet + detail sheets). There are two builders, and knowing which is authoritative matters:

1. **`lib/tax/financials-excel.ts::buildFinancialsWorkbook`** — renders the Excel **from the tax-financials engine draft** (`buildFinancialDraft` via `getFinancialsView`): P&L totals, per-member M-2 capital roll-forward, and the **prior-return-aware** beginning balances — i.e. the SAME numbers the on-screen review shows. **This is what the tax-financials download route uses** (`app/api/portal/tax-financials/download`). Authoritative. Documented in **tax-returns.md**.

2. **`lib/pnl-generator.ts::generatePnlExcel`** (+ `buildPnlWorkbook`, `computePnlTotals`, `getIrsRate`) — the OLDER builder that re-derives everything from raw `bank_transactions` (transaction-based; beginning balances from statement-opening, NOT the prior return; no `defaultUncategorizedBySign`). Still used by: the tax-wizard auto-pipeline (`lib/jobs/handlers/tax-form-setup.ts`), `app/api/tax-form-completed/route.ts`, `lib/tax/attest-handoff.ts` (accountant hand-off), and the `bank_statement_pnl` MCP tool (`lib/mcp/tools/bank-statements.ts`, which delegates to it). **These can disagree with the tax-financials draft** — migrating them to the draft-based builder is a tracked follow-up (one caller at a time, with per-caller number checks).

## Business rules
- **USD only**; P&L amounts at the IRS **yearly-average** rate (`irs_exchange_rates`, `getIrsRate`). Balance-sheet year-end FX (spot vs average) is tracked refinement **R1** — it will improve the draft AND the Excel together.
- `computePnlTotals` (in `pnl-generator.ts`) is the shared signed-totals math (F1 refunds, F3 contributions-as-equity, F4 contra-expense) — pinned by `tests/unit/pnl-totals.test.ts`. Both builders use it (the draft via the engine).

## Gotchas
- **Screen vs file:** always prefer the draft-based builder for anything tied to the tax-financials review, so the downloaded file matches the screen. The transaction-based `generatePnlExcel` is prior-return-blind.
- **Don't re-duplicate a workbook builder.** Any new "download the P&L" surface should call `buildFinancialsWorkbook` (draft) or `generatePnlExcel` (legacy), never a fresh ExcelJS workbook.

## How to verify
- `tests/unit/financials-excel.test.ts` (Excel renders from the draft), `tests/unit/pnl-totals.test.ts`, `tests/unit/build-pnl-workbook.test.ts`.
- The standalone staff tool, the review component, the routes, and the ingest pipeline are all documented in **tax-returns.md**.
