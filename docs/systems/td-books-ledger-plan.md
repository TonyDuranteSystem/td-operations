# TD Books — 2025 filing, then the ledger, then the agent

_Living plan. **Update this file in the same change as the work it describes.** Its job is that nothing learned in a session is lost when that session ends — Antonio, 2026-08-31: "We can't lose information along the way, this is very important."_

_Status: **LIVE — Track A in progress. Updated continuously as work lands; see §13 for the running log.** Rewritten 2026-08-31 after a full council pass (8 reviewers, ~30 blockers, verdict FIX-FIRST).** The previous version of this plan was written without a council review and without asking about the filing deadline. Both were shortcuts. Dev job `81fb5a05`. Companion: `td-books.md` (how the books work TODAY)._

---

## 0. THE DEADLINE — everything is sequenced from this

**The 2025 return is on extension. It is due 15 September 2026.** Today is 31 August. **Fifteen days.**

The previous plan had six phases finishing long after that date and never mentioned a deadline anywhere. That single omission invalidated its whole sequence.

**There are TWO deliverables, and they were being conflated:**

| | What it is | When |
|---|---|---|
| **Track A** | Numbers the preparer can file. A correct P&L, a balance sheet, two K-1s. **No system required.** | **By 15 Sept** |
| **Track B** | The real double-entry ledger, the auditor, the expert agent. | After. No deadline. |
| **Track C** | 1099s and payroll obligations. **~7 months overdue.** Needs only a payee list. | **Immediately, in parallel** |

The categorisation work feeds A and B both, so none of it is wasted. **Track A is not a shortcut that gets redone — it is the input to Track B.**

---

## 1. Why this exists

Antonio's 2025 books are being rebuilt from real bank statements because the bookkeeping he was given is not trusted. He rejected a flat ten-category list:

> *"My own accounting system is not hard-coded with only that fucking list... if I want to know how much I spent on electricity, I want to know. If I want to know how much I spent for the state, I want to know."*

**The bookkeeping is now demonstrably wrong, not just distrusted.** Read from the prepared 2025 P&L on 2026-08-31:

| What it says | Why it is wrong |
|---|---|
| Operating income **$868,573.53** (Sales $856,643.56) | We have identified **$392,334** arriving in Chase that is Antonio's own money sweeping in from Airwallex and Mercury. If counted as sales it is ~45% of reported revenue. Stripe compounds it — the charges *or* the payouts, never both. |
| **"Basis: Accrual"** | The 2024 return was filed **cash basis**. A basis change requires IRS consent on Form 3115. |
| **"Closing cost $40,032.53"** as an operating expense | Costs of buying the office. They capitalise into the building and depreciate; they are not a one-year deduction. **No depreciation appears anywhere in the statement.** |
| **"Estimated Tax $40,605.26"** as a business expense | Federal estimated tax is not a company deduction — it is money taken out. |

Checked and clean: payroll. Her $179,899.60 matches the Gusto bank total almost exactly.

**Antonio informed the preparer on 2026-08-31** that double-counted income and these three other issues were found and that corrected figures are coming.

---

## 2. Ownership — SETTLED, with documents

Previously recorded on Antonio's word alone, which was not sufficient for a fact that drives K-1s. Now read from the documents:

- **The operating agreement lists Antonio Durante 50% and Jodi Marie Ziegler Durante 50%**, allocates profits, losses and distributions **"in proportion to their respective Membership Interests"**, and requires a Schedule K-1 for each member.
- **The CP261 is addressed to "JODI MARIE ZIEGLER SR MBR"** — the IRS entity record carries her. S election effective **1 January 2023**.
- **The 2024 return reported ONE shareholder** taking all $174,383 of income and all $135,965 of distributions.

**This resolves the single-class-of-stock alarm favourably.** That test looks at what the *governing document* confers, not at what was actually paid. The agreement confers identical proportional rights. What remains is narrow: the 2024 return contradicts the agreement — a preparer error.

**Open:** the copy read has a **blank effective date**, suggesting it was never executed. Worth fixing going forward. It does not change 2024 or 2025 — ownership in a filed or filing year is a fact, not a drafting choice.

**Consequence for Track A: 2025 files with TWO K-1s at 50/50.**

---

## 3. Architecture — three layers, and REUSE

| Layer | Rule |
|---|---|
| **Ledger** | Deterministic. Never a model. Same input → same output, or the books are not signable. |
| **Auditor** | Machine-checkable invariants after every change. Where "the system knows what money in means" lives. |
| **Agent** | Proposes with reasoning. A human accepts. |

**The central design lesson, which the council confirmed and sharpened:** a smarter categoriser would not have caught the Amex sign bug — nothing was miscategorised, the rows had no category. Only an invariant catches that. **But my invariants did not catch it either — see §6.**

### 3a. WHAT ALREADY EXISTS — verified, environment-stamped, DO NOT REBUILD

**The previous plan's biggest error: it named four things and missed an entire shipped accounting engine, then proposed to rebuild it.**

Built for CLIENTS, running against tens of thousands of production rows. **The owner books import ZERO of it** (verified: no `lib/tax/` import in any `owner-*` file):

| Track A / B need | Already built | Size |
|---|---|---|
| Per-account tie-out (opening + movement = closing, per bank, with a tie verdict and provenance) | `lib/tax/bank-balances.ts` | 152 lines |
| Own-account transfer pairing — outflow at A + inflow at B, distinguishing two accounts at one bank | `lib/tax/transfer-matcher.ts` | 291 |
| Independent re-derivation of every total; balance sheet must tie to $0.00 | `lib/tax/validation-breakdown.ts` | 359 |
| Cash-basis balance sheet, per-member capital roll-forward, beginning cash from the prior return | `lib/tax/financials-engine.ts` | 495 |
| Ordered, direction-gated, DB-backed rules — **992 live production rules, editable without a deploy** | `lib/tax/categorization-engine.ts` | 723 |
| The learning loop: derive a rule from a correction, scope it, deactivate conflicts, **evict on reversal** | `lib/tax/learned-rules.ts` | 325 |
| FX — **house standard is IRS yearly-average**, not per-transaction-date | `lib/tax/fx.ts` + `irs_exchange_rates` | 38 |
| Bank/account identity from a filename | `lib/tax/bank-identity.ts` | 243 |
| **Verification gates 3/4/5** — balance-sheet identity with a named FX equity line; M-2 roll-forward per member; **Σ K-1 shares = net income AND Σ ownership % = 100** | `lib/tax/verification-gates.ts` | — |

**Gate 5 is exactly the check that would have caught the one-shareholder problem.** It was added after a real client attested a return at 60%/60%. **The owner's own books were being built to a weaker standard than TD applies to paying clients.**

`lib/owner-books-rules.ts` is a hand-written re-implementation of the rules engine; `lib/owner-statement-filename.ts` is a re-implementation of bank identity. **The rule CONTENT stays TD-specific** (nothing inherited from Zoho or a bank's category column — that instruction stands). **The ENGINE is reused.**

**The boundary:** shared pure engine, per-owner storage. Do NOT unify the storage — that was tried and reverted as "the single biggest corruption risk". The client engine is partnership-shaped; Antonio is an 1120-S. `pnl_workspaces.entity_type` already exists as an engine selector with only MMLLC registered. **The work is "register an S-corp engine behind the existing selector", not "build a second books stack".**

### 3b. WHAT DOES NOT EXIST — corrected

**The previous plan claimed the ledger tables "already exist — do not rebuild". That was a SANDBOX fact presented as general.**

**Verified on PRODUCTION: `chart_of_accounts`, `journal_entries`, `journal_lines` and `bookkeeper_review_items` do not exist at all.** Only `bank_categorization_rules`, `owner_vendor_rules` and `td_books_transactions` are there. **No migration file in the repo creates them.** The sandbox copies are orphans with no code and no committed DDL.

**Every figure in this plan is stamped with its environment. Track B needs a Phase 0 that authors real migrations and promotes them.**

---

## 4. Facts established — do not re-derive

**Environment: SANDBOX unless stated. Production figures are marked [PROD].**

### Antonio's binding decisions

| Decision | Detail |
|---|---|
| **Ownership** | 50/50 with Jodi, per the operating agreement. Antonio the only one on payroll. **Two K-1s for 2025.** |
| **Office rent** | $39,642.18 across 25 payments — 11 Portobello (7 monthly −18,175.51 + 4 small −262.91) + 14 cheques (−21,203.76). **OPEN QUESTION, see §5.** |
| **Janet Durant** | Marketing. $8,650.00 across 9 payments. Durant, not Durante — not family. |
| **Vehicle service & fuel** | Business. $1,517.86 across 6 charges. **Conditional — see §5.** |
| **Meals & travel** | Business. $1,733.01 across 20 charges (11 travel $1,363.68, 9 meals $369.33). |
| **Car LOAN payments** | NOT deducted. Only interest is, plus depreciation. $11,266 stays as drawings pending the vehicle-on-books decision. |
| **2024** | **PARKED** until 2025 is filed. It lives in Zoho. James Baker amends it when 2025 is right. |
| **Build, not buy** | Basis/Digits are mature but the books would live in their system — the Zoho problem again — and would never serve clients' books inside TD's own CRM. |

### Verified numbers

- **2025: 2,768 rows across 13 accounts, 1,220 categorised, 1,548 outstanding.** Reconciles. **[PROD: `td_books_transactions` holds 109 rows, ALL tax_year 2026 — no 2025, no 2024.]**
- **2025 opening balances**, from the filed 2024 return: cash $46,765 · receivables $887 · other current assets $5,815 · **total assets $53,467** · notes payable $6,456 · retained earnings $47,011. Ties exactly.
- **2024 as filed** (re-verified line by line — **it ties; a reviewer's claimed $199 gap was the reviewer omitting the other-income line**): receipts $488,348 · COGS $15,333 · other income $199 · officer comp $92,000 · taxes & licences $36,951 · other deductions $169,880 · **profit $174,383** · distributions $135,965. Cash basis. James Baker CPA. EIN 83-4299021.
- **$392,334 of own-money sweeps into Chase.** The reliable tell is Airwallex's ACH originator id `1371913769`, **not the wording** — one April sweep of $12,400 is described as "Chase".
- **Amex 9245 is a SAVINGS account**, not a card. Closes $602.73. Interest is taxable income against a 1099-INT.
- **First Citizens loan 7363**: drawn **$144,500 on 2025-05-22**, closes **$140,246.52** → **$4,253.48 of principal repaid**. Opens inside 2025.

### The accounts

Chase checking 3920 (492) · Chase card 9279 (437) · Chase card 6094 (152, opened 2025) · **Amex card 51007 (790 — signs inverted)** · Amex savings 9245 (37) · Mercury checking 4517 (365) · Relay checking 6770 (39) · Stripe processor (187 charges — clearing) · Airwallex EUR (104) / USD (38) · First Citizens checking 5812 (14) / 5820 (94) · **First Citizens loan 7363 (19 — signs inverted)**

**No statements held: Truly Financial, Verto, Ally 2167, Jeep Compass 1244** — all have folders in the CPA's TaxDome portal. **Ally and Jeep are vehicle loans; their 12/31 balances are absent from liabilities**, potentially a large fraction of a $53,467 balance sheet. Transfers *to* Truly/Verto currently read as expenses. **Fetching these is a Track A entry gate, not a footnote.**

---

## 5. Open defects and open questions

### Live defects in shipped code — all verified directly

1. **Amex 51007 signs inverted.** Amex writes a charge positive, a payment negative. Books currently say $80,457 was *earned* from Corporate Filings, Home Depot, Geico and Zoho. Proof: of 48 negative rows totalling −$83,883, **24 are "MOBILE PAYMENT - THANK YOU" (−$81,124)**; the rest are merchant refunds. 790 rows, none categorised.
2. **First Citizens loan 7363 signs inverted.** Drawdown as money out, repayments as money in. 19 rows, none categorised.
3. **THE CARD-PAYMENT RULE DOES NOT MATCH AMEX.** It matches Chase's *"PAYMENT THANK YOU-MOBILE"*; Amex writes *"MOBILE PAYMENT - THANK YOU"* — the hyphen breaks it. **Verified by running the regex.** After the sign flip, 24 payments totalling **$81,124** fall to the card catch-all refund rule and **reduce expenses by $81,124**. Before the flip it is worse: all 766 charges hit the catch-all and drive expenses **negative by $80,457**. The existing test used Chase's wording, which is why it passed.
4. **`getCashPosition` adds card and loan balances INTO cash** — no account-type filter, so the $140,246 loan and every card balance inflate the cash total. Also un-ranged (silent 1000-row cap drops whole accounts) and no id tie-break (the closing balance is nondeterministic on a busy day).
5. **`Math.abs` on expense/cogs/fee/distribution** means a money-IN row miscategorised as an expense **increases** expenses; `by_subcategory` absolute-values so the largest income renders as the largest expense.
6. **The match panel** shows 8 of N with no deselection; renders every matched row in the *opened* row's currency (reachable today — 1,532 USD + 16 EUR uncategorized); and the saved rule's pattern is computed from rows the user unticked.
7. **The bulk bar** keeps its selection across filter/page changes and does not restrict to uncategorized rows.
8. **THE SIGN FIX IS NOT DURABLE.** The owner import passes no mapping store, so it skips the learned-mapping + verify + quarantine layer and falls to the generic column mapper. Flip 809 rows by hand and the **next** Amex upload lands inverted again. **"Learn once, replay forever" already exists** — it is simply not wired to the owner books.
9. **The 6-hourly sweep has no year guard** — `tax_year` is taken straight from the row's date. A feed row dated 2025 lands in 2025 automatically, unattended, into a year Track A intends to finalise. **A year a cron can write to is not closed.**

### Open questions that change the numbers

- **The rent.** The count and total verify, but the large cheques (**$3,717.92 on 7 Oct, $8,217.92 on 31 Oct, $3,217.92 on 9 Dec**) are far above the ~$2,600 Portobello monthly rate **and begin five months after the office loan was drawn**. Three possibilities: mortgage payments mislabelled as rent (**principal is not deductible**), related-party rent needing arm's-length support, or a genuine third location. **Get the per-payment listing before posting.**
- **The vehicle decisions contradict each other.** Deducting fuel and service as business is only right if the car is a company asset — but the loan is parked as drawings, i.e. not one. And standard mileage vs actual cost is **either/or**; booking fuel now and claiming mileage later is a double deduction.
- **Gross vs net receipts.** The 2024 return shows Stripe fees of $694 against $488,348 of receipts — implausibly low, the signature of **net** receipts being reported. **Gross receipts are matched automatically against 1099-Ks.** Establish whether state filing fees are re-billed to clients and whether revenue is reported gross.

---

## 6. The invariants — REPLACED, because mine did not work

**The previous plan claimed in bold: "Any one of these catches the Amex bug." That was false for at least four of seven.**

| Old | Why it failed |
|---|---|
| Card polarity — "opposite signs, payments the minority" | **Invariant under global negation.** True before and after the flip. It cannot tell which side is spending. |
| Balance chain — "previous + amount = next settles the convention" | **Certifies the WRONG sign.** A card's running balance is the amount *owed* and rises with a charge, so the inverted data reconciles and the corrected data would fail. Also unrunnable on Mercury, which carries no balance at all. |
| Direction fences category | Cannot fire on 790 **un**categorised rows. |
| Debits = credits | Passes perfectly on a flipped sign — and on a perfect double-post. |

**The replacements. Reuse the client engine's gates rather than writing new ones.**

1. **Absolute card anchor** — rows matching a payment token must carry the sign that REDUCES the liability; a card's net over a statement period must equal the change in the stated balance.
2. **Per-period tie-out, not annual** — opening of month N = closing of month N−1, every account, no gaps. An annual test passes on offsetting errors (a missing March rent plus a duplicated July one ties at 12/31 while the P&L is wrong by $5,200). *(reuse `bank-balances.ts`)*
3. **Statement-coverage register** — account × month × opening/closing/row-count/source-file, gaps flagged. **The only real completeness control.**
4. **Own-account money is never income — AND money leaving toward an account in these books is never an expense.** The old rule had no mirror, leaving every outbound transfer leg unprotected: Amex card payments alone are **$81,124** of phantom expense. *(reuse `transfer-matcher.ts`)*
5. **Transfer legs are PAIRED before posting.** One $12,400 movement must produce one entry, not four legs. Unpaired legs go to suspense and are reported.
6. **P&L variance against the filed prior year** — line by line, with a threshold. The cheapest detector of a dropped or doubled category, and the only control that tests *classification* rather than cash.
7. **Zero in suspense and zero uncategorized before close.**
8. **A = L + E standalone**, and ledger-wide total debits = total credits. *(reuse `validation-breakdown.ts`)*
9. **M-2 / equity roll-forward per member**, and **Σ K-1 shares = net income, Σ ownership % = 100**. *(reuse `verification-gates.ts` gates 4 and 5)*
10. **Payroll reconciliation** — officer comp = W-2 Box 1; employer tax = the 941 totals. Payroll **cannot** be rebuilt from bank rows: a statement shows net pay, not gross wages, employer tax and withholding.
11. **Gross receipts ≥ Σ 1099-K received.**
12. **FX** — closing balances remeasured at the closing rate, difference to a named FX account; rate **frozen at import** or re-running changes prior periods.
13. **Duplicate-import** and **12/31 cut-off**.
14. **Stripe clearing must tie to Stripe's own year-end balance (expected ≈ 0)** — the old plan exempted it, which switched off the only detector of the largest silent double-count.

**"Category totals = sum of all rows" is NOT a control.** It is a tautology, true of any partition including a wholly miscategorised one. It was cited as evidence in the previous plan.

---

## 7. TRACK A — the 2025 filing. Fifteen days.

**Goal: figures the preparer can file. Not a system.**

| Step | What | Exit |
|---|---|---|
| **A0** | Fix the money bugs in the reporting path: cash position (account-type filter, paging, tie-break), the `Math.abs` sign handling, the match panel and bulk bar. **Track A's numbers come out of these surfaces — they must be right first.** | Reports compute correctly on known inputs |
| **A1** | Flip the Amex and loan signs (809 rows, none categorised). **Fix the card-payment rule FIRST** or the flip books $81,124 as refunds. Publish a before/after control total. | Card reads like a card; loan runs $144,500 → $140,246.52 |
| **A2** | Retrieve: **office closing statement · First Citizens 2025 year-end loan statement · 2025 payroll reports · December 2024 statements for every account · the four TaxDome folders (Truly Financial, Verto, Ally, Jeep).** *Antonio — start now, this is the long pole.* | All in hand |
| **A3** | Categorise the 1,548 outstanding rows. **Group-first: ~200 merchants, not 1,548 decisions.** Inside a group show *variants*, not 210 checkboxes. | Zero uncategorized |
| **A4** | Pair transfer legs and collapse them. Suspense for unpaired. | Zero in suspense |
| **A5** | The office: land/building split from the closing statement and the assessor ratio, in-service date, depreciation. The loan: interest split from principal against the lender's statement. Cards as liabilities. Per-account opening balances reconciled to $46,765. | Balance sheet balances |
| **A6** | Build the P&L and balance sheet **through the existing client engine behind a registered S-corp entity type** — not a new reporting layer. | Statements produced |
| **A7** | Run invariants 1–11. **Explain every variance against the filed 2024 return and against the prepared 2025 P&L.** | Variance report |
| **A8** | Two K-1s at 50/50. Reasonable-compensation record for the year. Hand to the preparer. | Filed |

### Why the account registry and the checks are INSIDE Track A, not deferred

Antonio, 2026-08-31, asking whether to build the smart system now or finish 2025 first. The answer is that two of the three "agent features" are **not a detour — they are how 2025 is done correctly**:

- **The account registry is required either way.** A balance sheet cannot be produced without knowing which accounts are liabilities, which invert their signs, which is a clearing account. That knowledge currently exists ONLY in this session's head and in two scripts. **Proof it is not yet in the system: upload a January 2026 Amex file tomorrow and it lands inverted again** — the 809-row repair was data, not a rule. Writing it down costs ~2–3h and is simultaneously the agent's foundation.
- **The checks are required either way.** Proving 2025 is right IS the tie-out. The same checks are what later let an agent prove rather than assert.
- **Rules-as-data is a genuine choice, and it is taken.** Filing 1,267 transactions is ~200 real decisions. If each writes a RULE rather than only a label, next year is nearly free. Same work, different destination. Cost ~4–5h.

**What still waits until after the 15th:** the agent itself, the double-entry journal, and the challenger. None change what the return says — and **building the agent now would be worse than useless, because the knowledge it needs is exactly what is still being discovered.** Two days before this entry nobody knew Amex inverts or that a fifth of the Stripe income never happened; an agent built on that understanding would have confidently reproduced those errors.

**The named weakness:** this adds ~6–8h to a ~15h job inside a 14-day window. If the estimate is wrong, the filing slips. Mitigation and honest read: **the deadline risk is the DOCUMENTS, not the hours.** If A2 takes a week, drop rules-as-data and keep only the registry and the checks.

**Stated tolerance — a filing deadline means disclosed-and-good-enough beats perfect-and-late.** Any account that cannot be tied by 12 September is **disclosed to the preparer with the amount and the reason**, not quietly plugged. That decision is Antonio's and the preparer's, not this project's.

**Honest estimate:** ~15 hours mine, ~4–6 hours Antonio's, **conditional on A2 arriving fast**. The old "16–20 hours" figure covered a different, larger scope and was not credible.

---

## 8. TRACK C — 1099s and payroll. Immediate, parallel.

**2025 Forms 1099-NEC were due 31 January 2026. Roughly seven months late. Penalties are per form and escalate.**

- **Luca DeG — $47,448.88 across 22 payments.** **Zelle is bank-to-bank and files no 1099-K**, so TD's own obligation is undiminished. **Also: Luca is referred to as STAFF in this system while being paid as a contractor for core delivery work — a worker-classification question for the CPA.**
- **Janet Durant — $8,650.00 across 9 payments.** Same analysis.
- **Rent $39,642.18** — 1099-MISC box 1 if the landlords are not corporations.
- **W-9s** — check they exist. Without a TIN, backup withholding applies and **the payer** becomes liable.

Needs only the payee list. **Does not wait for the ledger.**

---

## 9. TRACK B — the system. After the 15th.

**B0 — Promotion.** Author real migrations for the chart of accounts and journal tables and promote them. Re-measure every figure against production. **Nothing here exists on production today.**

**B1 — Chart of accounts.** Per-entity, seeded from a shared catalog of templates. Must include from day one, because restructuring later is the expensive kind: **AAA and OAA (AAA is NOT retained earnings — they diverge the moment there are non-deductible items, and there are)** · per-shareholder capital and stock/debt basis (**distributions above basis are capital gain and nothing tracks basis today**) · fixed assets and accumulated depreciation · **meals / travel / entertainment as three accounts** with a non-deductible section · payroll split into wages, employer tax and liabilities · FX gain/loss · suspense. **Populate `tax_line` — free now, a migration later.**

**B2 — Post the ledger**, with the account picker built FIRST (Track A already did the categorising, so this is a mapping exercise). One system of record, declared in writing. Idempotent: unique on (entity, source transaction).

**B3 — Screens.** Group-first review, cards on mobile, a permanent tie-out status strip on the money screens, chart editor in plain language (never *type*, *normal balance*, *contra*). Retire the old P&L in the same change that ships the new one.

**B4 — The learning loop.** Port `learned-rules.ts` to the owner scope: **a correction writes a deterministic RULE, not a weight**; the model only proposes the rule text a human accepts. Eviction on reversal is mandatory — without it one wrong learned rule silently re-books every future year.

**B4a — The CHALLENGER, built FIRST of the agent pieces.** Half the corrections in the session that produced this plan came from an independent verifier rejecting a claim and forcing a re-check — including several that were flatly wrong and would otherwise have reached Antonio as fact. An agent without one states a wrong number with complete confidence. This is the most important part and the one nobody builds.

**B5 — The agent.** Connect the existing agent to the ledger. **It may post only into a draft batch, in an open period, on lines no human has decided, every line stamped with agent and prompt version, and the invariants run as a precondition of leaving draft.** That turns "a human reads every proposal" into "a machine proves every proposal, a human reads the exceptions" — the only version that scales. Never in a closed period. **The bank-format mapping write is an agent write and is governed by the same rail.**

### What actually makes an agent reason like a person — derived 2026-08-31, not assumed

Antonio: *"How can I have a smart agent that can do this kind of reasoning in the system?"* The honest finding is that **very little of today's value was cleverness**:

- The Stripe error was not deduced. Two numbers that should have matched did not: the loaded file said $124,536, Stripe's own report said $103,947.
- The Amex error was spotted by ANTONIO ("+$25 on a credit card"), then confirmed.
- The sign fix was arithmetic — does the balance chain still add up.

**The pattern is always an independent source plus the discipline to check against it.** So:

1. **REACH, not intelligence, is the gap.** The agent has **82 distinct tools** and **not one can see the books** (the only finance-shaped name is a calendar booking search). It reads email, searches clients, runs a query, fetches a page. It cannot open a statement, reconcile an account or check a balance. Working Stripe credentials and the statements already exist; nothing connects them.
2. **Checks that fail loudly**, run in milliseconds on everything — the agent then works only on what they flag.
3. **A challenger** (B4a).
4. **The business written down** — the registry and the knowledge base.
5. **Permission to refuse.** The Stripe rebuild refuses to write unless it reproduces Stripe's own five figures. An agent that says "these do not match, I am stopping" is worth more than one that always answers.

**The economics that decide the design:** a session like this one is minutes of reasoning per question. Running that over 3,000 transactions monthly is neither affordable nor necessary. So: **cheap deterministic checks on everything always; the model's attention only on the exceptions.** That is also how the Big Four platforms are built, and why the existing client categoriser runs only on what the rules could not handle.

**B6 — 2024 and the amendment.** From Zoho, opening from the 2023 return, with a line-by-line bridge from filed to corrected.

---

## 10. Tax strategy — Antonio asked for a strategist and the old plan gave one vague line

None of this is Track A. All of it is real money and belongs in the system.

- **§199A / QBI is the biggest unknown and decides the direction of everything else.** Is TD an SSTB? If yes and income is above the phase-out, QBI is lost entirely — which flips the optimisation.
- **A retirement plan is the largest legitimate deduction available** and it **inverts** the minimise-compensation reflex: employer contributions are a percentage of W-2 wages, so *raising* comp *raises* the ceiling.
- **Putting Jodi on payroll solves three problems at once** — the zero-comp shareholder-employee exposure, the disproportionate-distribution pattern, and retirement capacity.
- **Comp + QBI + retirement is a THREE-WAY optimisation.** Deciding them separately, which the old plan's "year-end review of three unrelated items" would have done, gets the wrong answer.
- **The office may be in the wrong entity, and this is time-sensitive.** The standard structure is a separate LLC holding the property and leasing to the operating company. **Appreciated real property cannot leave an S-corp without triggering gain as if sold** — easy in, very expensive out. Bought 22 May 2025, return not yet filed. **Ask counsel now; the answer degrades with time and appreciation.**
- **Screen the ~$55,657 personal bucket item by item.** >2% shareholder health, dental and vision premiums **must be in W-2 wages** to be deductible above the line — buried in a distribution bucket that deduction is simply **lost**. Same for HSA, personal vehicle use, life insurance. Anything landing in wages triggers a W-2c and a 941-X.
- **An accountable plan** — cheapest, highest-return document available. Without a written one, every reimbursement is taxable wages, and it **gates** the vehicle and home-office treatments.
- **Quarterly estimates.** The flat 25%+SE estimate was correctly deleted and replaced with nothing. Underpayment penalties are computed quarterly.
- **State and local:** Florida corporate return and annual report, real property tax, **tangible personal property tax** (its own deadline, routinely missed by new property owners), local business tax receipts, and Florida sales tax on commercial rent.

---

## 11. Risks — stated, not hidden

1. **Track A produces numbers without the ledger.** Accepted deliberately: the deadline is real and the categorisation carries over. The risk is that the reporting surfaces have known bugs — which is why A0 comes first.
2. **The tie-out will fail on the first pass** and surface unsized work. In fifteen days there may not be time to chase everything. Hence the stated tolerance in §7.
3. **A model with write access will eventually make a confident wrong entry that balances** — the hardest kind to find. Draft-batch only, invariants as a precondition.
4. **A model's recall of tax rules drifts.** It answers from the return, the ledger and a maintained rules library, and says which.
5. **Antonio is the professional.** The agent drafts for his review, never speaks to a client. Tax strategy acted on unreviewed is his licence.
6. **Antonio is the sole reviewer with no fallback.** A2 must start immediately and run in parallel with everything else.
7. **Every "verified" figure needs an environment stamp.** The previous plan's foundation was sandbox facts presented as general.
8. **COMPUTE EVERY TOTAL WITH A QUERY.** Repeated arithmetic errors in this project came from adding figures mentally — including in the previous version of this document.

---

## 12. Awaiting Antonio

- **Go on Track A**, starting with A0 and A1.
- **A2 document retrieval** — the long pole. Nothing else can finish without it.
- **Go on Track C** (1099s) as a parallel workstream.
- The four reclassifications (rent $39,642.18 · Janet Durant $8,650 · meals+travel $1,733.01 · vehicle $1,517.86) — still unapplied, and the rent and vehicle both now carry open questions per §5.

---

## 13. Running log — findings and work, newest first

**Append here as work lands. Antonio, 2026-08-31: "while we work on the 2025 books, update it with new findings and implementation and features." Each entry states what was found, what was verified against, and what changed.**

### 2026-08-31 — Stripe rebuilt as a clearing account; it now ties to Stripe's own balance

**Reconciled the loaded data against Stripe's own 2025 balance summary. Three defects, none visible from the code:**

1. **29 FAILED charges booked as income — $20,589 of money that never arrived.** The export lists a declined card with an amount and a "Failed" status; the importer read the amount and ignored the status.
2. **EUR charges loaded at their EURO face value labelled as dollars.** "Amount" is the charge's own currency; "Converted Amount" is the settlement figure. Converted sums to **103,946.64** — Stripe's gross to the cent. Raw gives 103,057.60.
3. **Fees never booked in the rebuild at all** — Stripe charged **3,594.39**. (The prepared accounts DO carry them, at **3,451.57** — short by 142.82. Both figures recorded; the source of truth is Stripe.)

**The double-count is closed.** 158 captured charges are the income; the **94 payouts, $95,970.15, went to MERCURY** (not Relay — the dashboard was showing 2026) and are now marked as transfers on **both** legs, mirrored from the Mercury rows themselves so dates and amounts match by construction rather than by a heuristic.

**The proof:** 103,946.64 − 3,594.39 − 1,500.00 − 95,970.15 = **2,882.10**, exactly Stripe's stated ending balance. The rebuild script **refuses to write** unless it reproduces all five figures, and backs up the prior rows to disk before deleting. 412 rows written; 187 replaced.

### 2026-08-31 — closing balances retrieved from Antonio's own Drive

| Account | Closing balance | Source |
|---|---|---|
| Mercury 4517 | **$15,044.08** | December statement (opened 13,751.14 · +21,292.94 · −20,000.00) |
| Chase card 9279 | **$170.72** owed | December statement, cycle **23 Nov – 22 Dec** — the last nine days of the year fall outside it |
| Stripe | **$2,882.10** | Stripe balance summary |

**Still missing: Amex 51007 has NO December statement in the Drive** (searched; four December files present, none Amex). Chase 6094's statement IS there, unread as of this entry.

**Access note that cost real time:** the owner-Drive search failed with "GOOGLE_SA_KEY not configured" because a scratch script loaded the wrong env file. The credentials were present the whole time. Do not conclude "no access" from one failed script.

**Also learned:** four accounts seen in the CPA portal (Truly Financial, Verto, Ally 2167, Jeep Compass) are **2024**, not missing 2025 accounts. Folders were seen; the year inside was never checked. **Do not go to the CPA portal without Antonio's explicit word** — his instruction, 2026-08-31.

### 2026-08-31 — Amex and loan signs flipped; the rule that would have hidden it fixed first

**Order mattered.** The card-payment rule matched Chase's *"PAYMENT THANK YOU-MOBILE"* but NOT Amex's *"MOBILE PAYMENT - THANK YOU"* — the words are not adjacent. Flipping signs first would have dropped Amex's 24 payments (**$81,124.41**) through the card catch-all and booked them as refunds, **reducing expenses by that amount**. The existing test used Chase's wording, which is why it passed. Pattern now tolerates separators; the catch-all refuses any row naming a payment; both wordings tested.

**Then the flip: 809 rows** (790 Amex + 19 loan), none categorised, so no human decision was disturbed.

**The script does NOT negate the stated balance — checked with arithmetic, not assumed.** A first version did. A loan statement prints the balance OWED while the amounts are the CHANGE in it. Proven on the real June rows: amounts flipped and balance left positive gives 144,500 − 284.39 = **144,215.61**, exactly what the statement says. Negating it would have broken the very chain the fix exists to make true.

**Verified after:** charges negative, payments positive; the loan reconstructs from 144,500 drawn plus 5,361 interest less 8,546 repaid to **140,246.52**. **Caveat:** three rows share 22 December with no tie-break, so ordering by date alone gives **141,314.82**. The true closing balance needs First Citizens' own statement.

### 2026-08-31 — Cash stopped counting debt as cash

`getCashPosition` had **no account-type filter**, so roughly **$140,000** of loan principal and three card balances inflated the headline cash number — against a rule this codebase already states. Now cash means checking and savings; an unknown type is reported as a liability rather than assumed to be cash. Also **paged** (an un-ranged read is silently capped at 1000 and would have dropped the QUIET accounts entirely, not merely staled them) and given an **id tie-break** so "the latest balance" stops depending on which row Postgres returned first.

Filtering them out without showing them would have made the debts vanish, so the dashboard now reports **Owed by Account** separately. **Known gap:** five accounts (Mercury, three cards, Stripe) carry no `balance_after` at all in their exports, so they cannot appear in either block until their closing balances are entered from statements.

### 2026-08-31 — the transactions screen was unusable for the one job it exists for

**Measured, not assumed:** of 2,768 rows, **241 descriptions exceed 200 characters** (longest 358) against a column fitting roughly 30. Three different Airwallex sweeps all read `ORIG CO NAME:AIRWALLEX ORIG ID…` and stopped; what distinguished them was in the hidden part.

Fixed: the whole ROW opens the transaction; the panel shows the FULL description wrapped and selectable plus the running balance (it was truncated even there); the Categorize button is gone (a second, smaller target for what the row now does, and off-screen on a phone); list descriptions wrap to two lines. Interactive children stop propagation. **Verified live in the browser:** row opens, a 200-character line renders complete, and the checkbox selects WITHOUT opening the panel.

### Still open at the time of this entry

- **1,267 of 2,993 rows uncategorised.**
- **Amex 51007 December statement missing**; Chase 6094 statement unread.
- The four §5 open questions (rent composition, vehicle contradiction, gross-vs-net receipts) unresolved.
- Track C (1099s) not started.
