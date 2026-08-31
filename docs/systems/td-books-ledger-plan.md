# TD Books — the real ledger programme (2025 rebuild → 2024 amendment → expert agent)

_Living plan. **Update this file in the same change as the work it describes.** Its job is that nothing learned in a session is lost when that session ends — Antonio, 2026-08-31: "We can't lose information along the way, this is very important."_

_Status: **PLAN — awaiting Antonio's go.** Dev job `81fb5a05`. Companion doc: `td-books.md` (how the books work TODAY; this file is what replaces that model)._

---

## 1. Why this exists

Antonio's own 2025 books are being rebuilt from real bank statements, because the numbers his bookkeeper (Tasha Batts) produced are not trusted. The same errors are believed to be in 2024, and **the 2024 return will be amended** once 2025 is finished.

The first attempt used a flat list of ten fixed categories with a hardcoded sub-list. Antonio rejected it, correctly:

> *"My own accounting system is not hard-coded with only that fucking list... if I want to know how much I spent on electricity, I want to know. If I want to know how much I spent for the state, I want to know."*

A fixed enum cannot answer those questions and cannot produce a balance sheet. The replacement is a real double-entry ledger with a chart of accounts Antonio owns.

**The agent is the destination, not an afterthought.** Antonio wants a CPA / IRS / tax-strategist expert living inside the system. Verified 2026-08-31 that this is standard in the market, not aspirational: EY runs 150 agents for 80,000 tax staff; KPMG's Workbench is multi-agent; PwC's GL.ai reviews journal entries; Digits ships an Autonomous General Ledger; Intuit's Accounting Agent auto-categorises (Anthropic partnership, Feb 2026); Basis raised $100M at $1.15B building agents for accounting firms. **An earlier answer in this project implied such an agent did not exist. That was wrong and was corrected.**

---

## 2. The order, and why it cannot change

**Ledger → invariants → agent.** Every platform above sits on a general ledger that ties. Nothing intelligent can reason about books that don't balance, and a beautiful screen over a wrong ledger shows wrong numbers convincingly.

**2025 completely, then 2024.** Antonio, verbatim: *"we have to continue in 2025 in order to finish it and make the system that works, and then we'll think also about 2024. Otherwise we'll start mixing everything and then it will be just a mess."*

**Opening balances go in as a normal dated journal entry, never a hardcoded constant.** This single decision is what makes "2025 now, 2024 later" safe: when 2024 is rebuilt, we replace that one entry and 2025 is not redone.

---

## 3. Architecture — three layers

| Layer | What it is | Rule |
|---|---|---|
| **Ledger** | Chart of accounts, journal entries, journal lines. Every transaction posts both sides. | **Deterministic. Never a model.** Same input → same output, every run. A model that files a row differently on two runs cannot produce accounts anyone would sign. |
| **Auditor** | Machine-checkable invariants, run after every change. | This is where "the system knows what money in means" actually lives. See §7. |
| **Agent** | Judgement on what is genuinely ambiguous; reads unknown bank formats; answers questions against the real ledger. | **Proposes, never posts.** Every proposal carries its reasoning and is accepted by a human. |

**A smarter categoriser would not have caught the Amex sign bug** — nothing was miscategorised, the rows had no category at all. Only an invariant catches that. This is the central design lesson of the project.

### What already exists (verified 2026-08-31, do not rebuild)

- **`journal_entries` / `journal_lines`** — designed correctly, **0 rows**, no code touches them. Debits/credits in whole cents (`debit_minor`/`credit_minor`), per-line currency + `fx_rate` + `base_*_minor`, and `status`/`posted_at`/`reversal_of` so entries reverse rather than delete.
- **`chart_of_accounts`** — `code, name, type, subtype, parent_id, normal_balance, currency, tax_line, is_postable, is_system, is_contra`. **68 rows across two non-owner entities. Tony Durante LLC has none.**
- **The agent loop** — reached from six entry points (dashboard sidebar, Inbox worker chat, portal chat suggest, Team Chat trigger, Team Chat approval, Hermes bridge cron), with tools, extended thinking, guards, approval discipline.
- **`lib/tax/ai-categorizer.ts`** — an accounting AI categoriser whose own guarantees are: runs only AFTER deterministic rules, only on what they left, applies only HIGH-confidence suggestions, tags them `ai:` so they are always distinguishable, and categorises **nothing** on API failure. Used by five modules, all client-tax-books. **Nothing in the owner books imports it.**
- **Statement parsing** — hand-written readers for Relay, Mercury, Revolut, Slash, Wise. AI extraction exists but only as a **parse-failure fallback**.

---

## 4. Facts established — do not re-derive

### Antonio's decisions (binding)

| Decision | Detail |
|---|---|
| **Ownership** | 50/50 with his wife **Jodi**. Antonio is the **only** one on payroll. Equity must be built as two members from the start. |
| **The 2024 return is wrong on ownership** | It records **one shareholder** taking all $174,383 of profit and all $135,965 of distributions. A bigger reason to amend than the categories. |
| **Office rent** | GC Portobello (bank transfer, Jan–Jul, ~$2,600/mo) **and all 14 cheques** (ten monthly $575 = Indian Shores office, the rest Portobello from October). **$39,642.18 across 25 payments.** |
| **Janet Durant** | **Marketing.** $8,650 across 9 payments. Name is **Durant, not Durante** — not family. |
| **Vehicle service & fuel** | **Business.** $1,517.86 across 6 charges. |
| **Meals & travel** | **Business.** $1,733.01 across 20 charges (11 travel $1,363.68, 9 meals $369.33). |
| **Car LOAN payments** | NOT reclassified. A loan payment is not deductible — only the interest, plus depreciation. $11,266 to Ally/Suncoast/Toyota stays as drawings pending the vehicle-on-books decision. |
| **2024 scope correction** | Chase 6094 did **not exist** in 2024 and the office was bought in **2025** — their absence from the 2024 CPA file is correct, **not a gap**. An earlier "incomplete data" claim was wrong on both counts. |
| **2024 is PARKED** | Untouched until 2025 is closed and locked. |

### Verified numbers

- **2025 books: 2,768 rows across 13 accounts.** Reconciles exactly (category totals = sum of all rows). 2026 holds 78 live bank-feed rows and is **off limits**. 2024 holds **0**.
- **2025 opening balances**, from the filed 2024 return's balance sheet: cash **$46,765**, receivables **$887**, other current assets **$5,815**, total assets **$53,467**, notes payable **$6,456**, retained earnings **$47,011**.
- **2024 as filed:** receipts $488,348 · COGS $15,333 · officer comp $92,000 · taxes & licences $36,951 · other deductions $169,880 · profit $174,383 · distributions $135,965. **Cash basis.** Prepared by James Baker CPA. EIN 83-4299021.
- **$392,334 arriving in Chase is Antonio's own money** sweeping in from Airwallex and Mercury — both in these books. As income it double-counts the same client money. The reliable tell is Airwallex's ACH originator id `1371913769`, **not** the wording: one April sweep of $12,400 is described as "Chase".
- **Amex 9245 is a SAVINGS account**, not a card. Pays interest, closes at **$602.73**.
- **First Citizens loan 7363**: drawn **$144,500 on 2025-05-22**, closes about **$140,246.52**. Opens *inside* 2025 — no 2024 opening balance needed for it.

### The accounts

| Account | Rows | Notes |
|---|---|---|
| Chase checking 3920 | 492 | main operating account |
| Chase credit card 9279 | 437 | where client state filing fees are paid |
| Chase credit card 6094 | 152 | opened 2025 |
| Amex credit card 51007 | 790 | **signs inverted — see §5** |
| Amex savings 9245 | 37 | interest income |
| Mercury checking 4517 | 365 | second-biggest account |
| Relay checking 6770 | 39 | low activity |
| Stripe processor | 187 | **charges export** — gross + per-charge fee, no payout rows ⇒ clearing account |
| Airwallex EUR / USD | 104 / 38 | multi-currency |
| First Citizens checking 5812 / 5820 | 14 / 94 | |
| First Citizens loan 7363 | 19 | office loan — **signs inverted**, and PARKED |

**No statements held for:** Truly Financial, Verto, Ally 2167, Jeep Compass 1244 — all have folders in the CPA's TaxDome portal.

---

## 5. Open defects — must be fixed before or during Phase 2

1. **Amex 51007 signs are inverted.** Amex writes a charge as **positive** and a card payment as **negative** — the reverse of every other account here. Left alone the books report $80,457 *earned* from Corporate Filings, Home Depot, Geico and Zoho, and $83,883 *spent* paying the card. Proof: of 48 negative rows totalling −$83,883, **24 are "MOBILE PAYMENT - THANK YOU" (−$81,124)**; the rest are merchant refunds. **790 rows, none categorised** — flipping disturbs nothing filed.
2. **First Citizens loan 7363 signs are inverted.** Drawdown recorded as money out, repayments as money in. **19 rows, none categorised.**
3. **Root cause of both:** Amex and Chase have no hand-written reader, so they fall to the generic column mapper — find a date column, find an amount column, **copy the number exactly as written**. It forms no belief about what the account is, so it cannot notice a contradiction. The AI in the importer is a *parse-failure* fallback and was never consulted, because the file parsed "successfully".
4. **The match panel shows 8 of N with no way to deselect.** Antonio, on the 210 Corporate Filings rows: *"I want to expand them and check that there are no other transactions mixed up. If there are I want to unselect what don't go there."* Needs: full list with date/description/amount, per-row ticks, live count on the button, **and a warning that a saved rule matches on wording and will re-match anything unticked**.

---

## 6. The phases

Each phase is a **child dev job** under `81fb5a05`, so the board shows real state. The seven-stage lifecycle (requested → investigated → plan approved → building → QA passed → shipped → verified) applies to each child.

### Phase 1 — Chart of accounts + opening balances
Draft Tony Durante LLC's chart from the complete 2025 year: every account he named (Electricity, State Filings, Rent — Portobello, Rent — Indian Shores) plus everything the data shows. Each bank account and card becomes an account. Equity as **two members**. Then the 2025 opening entry from the 2024 return.
**Antonio's time:** 30–45 min reviewing. **Focus his review on the SHAPE** — what is cost of sale vs overhead vs money taken out — not the wording. Renaming later is cheap; restructuring is not.
**Exit:** Antonio has approved the account list.

### Phase 2 — Post 2025
Fix the Amex and loan signs. Post all 2,768 rows as journal entries, both sides. Map the 25 existing subcategory labels onto real accounts.
**Exit:** **every account's computed balance equals its bank statement closing balance.** Binary. It will fail on the first pass — that is what it is for, and where it fails is real missing or misfiled money.

### Phase 3 — The screens
Chart-of-accounts editor (add / rename / deactivate / sub-accounts). Account picker replacing the fixed dropdown. P&L and balance sheet generated from accounts. Rules editor. The match panel from §5.4.
**Exit:** Antonio can add an account and re-file a transaction without a developer.

### Phase 4 — Close 2025
Review, adjustments, lock the year.
**Exit:** a P&L and balance sheet he would hand to a CPA.

### Phase 5 — 2024 and the amendment
Only after 2025 is locked. From the TaxDome documents, opening from the 2023 return.
**Exit:** corrected 2024 figures ready for the amended return, including the two-member ownership correction.

### Phase 6 — The expert agent
Connect the existing agent to the ledger with accounting tools and grounded tax knowledge. Unknown bank formats get read once and stored as a permanent deterministic mapping — **learn once, replay forever**. Year-end review: reasonable compensation, personal charges, missing 1099s.
**Exit:** it proposes with reasoning against real numbers, and Antonio accepts with one click.

---

## 7. Invariants — the auditor layer

Cheap, deterministic, run after every change. **Any one of these catches the Amex bug.**

1. **Card polarity.** On a credit card, spending and payments have opposite signs, and payments are the minority.
2. **Balance chain.** Where a statement carries a running balance, previous + amount = next. Arithmetic — it settles a sign convention outright.
3. **Own-account money is a transfer.** Money arriving from an account already in these books is never income.
4. **Direction fences category.** A spending category cannot apply to money coming in. *(Already live in the rules — added after Zoho client money nearly became a software expense.)*
5. **Debits equal credits** on every entry.
6. **Cash ties.** Each account's computed balance equals its statement closing balance.
7. **Processor exception.** A clearing account (Stripe) will not tie to a bank balance — it isn't one. Expected, not a failure.

---

## 8. Known risks — stated, not hidden

1. **Nothing visible for the first stretch.** Phases 1–2 produce no screen. Building the visible part first would put a convincing face on a wrong ledger.
2. **A model with write access will eventually make a confident wrong entry that balances** — the hardest kind to find. Hence propose-only, forever.
3. **A model's recall of tax rules drifts.** The agent must answer from the actual return, the actual ledger and a maintained rules library, and say which.
4. **Antonio is the professional.** The agent drafts for his review and never speaks to a client directly. Tax strategy acted on unreviewed is his licence at risk.
5. **Don't run the model on everything.** Most rows are obvious. Deterministic first, model on the remainder — what the existing categoriser already does.
6. **A chart drafted from 2025 alone will miss 2024-only accounts.** It stays editable and we accept adding accounts during Phase 5.
7. **Multi-currency.** Airwallex EUR needs a conversion rule for a dollar balance sheet. Proposed: each transaction's own date (standard for cash basis). The 2024 return carried a $313 exchange gain, so the previous preparer did something comparable.
8. **Repeated arithmetic errors in this project** came from adding figures mentally. **Compute every total with a query or a script; never sum by hand.**

---

## 9. Time

~16–20 hours to complete 2025 through Phase 4; ~2 hours of Antonio's across the reviews. Phase 5 a further 6–8 hours once 2025 is locked. Phase 6 sized after Phase 4.

---

## 10. Still pending Antonio's word

- The four reclassifications (rent $39,642.18 · Janet Durant $8,650 · meals+travel $1,733.01 · vehicle $1,517.86) — **not applied**, deliberately: better posted straight into the ledger than into the old buckets first.
- Flipping the Amex and loan signs (809 rows).
- Rebuilding the match panel.
- Starting Phase 1.
