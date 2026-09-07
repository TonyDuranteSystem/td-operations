/**
 * Financials draft engine (Slice 7, master plan §4) — PURE.
 *
 * Takes the year's categorized transactions + the resolved ownership + the
 * prior-return record and produces the FinancialDraft: P&L totals (via the
 * shared computePnlTotals — F1/F2/F3 semantics), the per-member capital
 * roll-forward (M-2), the cash-basis balance sheet, and every number the six
 * verification gates need. No I/O here — the orchestration layer loads data
 * and persists results.
 *
 * Cash-basis v1 decisions (plan §4 + §13 A5):
 * - Balance sheet books CASH + CAPITAL (assets = cash; liabilities = 0 unless
 *   a later version adds client questions for non-cash items).
 * - Beginning cash comes from the prior return's Schedule L ending cash
 *   (validated extractions only); first-year/never-filed start at 0.
 * - Per-bank beginning balances are derived from statement balance columns
 *   where present (first row: balance_after − amount) — used by gate 1.
 * - Contributions/distributions are attributed to members by counterparty
 *   name match; unattributed amounts are reported (staff/client question),
 *   and for the roll-forward they are spread by ownership % so the M-2 still
 *   ties while the draft FLAGS the attribution gap.
 */

import { computePnlTotals } from "@/lib/pnl-generator"
import { sameName, type ResolvedMember } from "./ownership-resolution"
import { confirmedMemberFromNote, matchMemberForTransaction } from "./member-names"
import { validatedExtraction, type PriorReturnCaseRecord } from "./prior-return-case"
import { toUsd, type FxRates } from "./fx"
import { mergeBankBalances, type ProvidedBankBalance, type BankBalancesSummary } from "./bank-balances"
import { accountKeyOf } from "./bank-identity"

export interface DraftTransaction {
  id: string
  transaction_date: string
  description: string
  counterparty: string | null
  amount: number
  currency: string
  category: string
  subcategory: string | null
  bank_name: string
  account_type: string | null
  /** Client-confirmed account identity key (Chase#5678 / Wise). Null/absent for rows
   *  not yet backfilled — accountKeyOf falls back to the canonical bank name. */
  account_ref?: string | null
  balance_after: number | null
  /** AI-assigned expense bucket slug (catalog_entries 'expense_categories') — the
   *  grouping key for the operating-expense breakdown. Null/absent → "other". */
  ai_bucket?: string | null
  /** Provenance note. Read ONLY for the "| Member: X" tail a client writes when
   *  they confirm which owner a payment went to — see attributeToMember. */
  notes?: string | null
}

export interface MemberCapital {
  name: string
  pct: number
  beginning_capital: number
  contributions: number
  distributions: number
  income_share: number
  ending_capital: number
}

export interface BankCashPosition {
  bank_key: string
  /** Dominant row currency for this bank account — the currency provided
   *  balances should be entered in (S2 slice 2 UI hint). */
  currency: string
  /** Derived from the first balance-bearing row (balance_after − amount); null when the CSV has no balance column. */
  derived_beginning: number | null
  /** Last balance_after seen; null when the CSV has no balance column. */
  reported_ending: number | null
  net_movement: number
}

export interface FinancialDraft {
  tax_year: number
  pnl: ReturnType<typeof computePnlTotals>
  members: MemberCapital[]
  banks: BankCashPosition[]
  /** Per-bank merged balances + tie-out results (S2 slice 2) — provided
   *  anchors merged with statement-derived figures, USD, with provenance. */
  bank_balances: BankBalancesSummary | null
  /** The current year's beginning cash. Prefers the prior return's Schedule L
   *  ending cash; when there is no validated prior, falls back to the bank
   *  statements' opening balances (only when EVERY account carries a running
   *  balance and there are members to hold the opening equity), then to the
   *  client/staff-provided per-bank openings (only when EVERY bank has one). */
  beginning_cash: number | null
  /** Where beginning_cash came from — drives the UI note + gate wording. */
  beginning_cash_source: "prior_return" | "statements" | "provided" | null
  beginning_capital_total: number
  /** Operating-expense total broken down by AI bucket, on the SAME USD-converted,
   *  refund-netted basis as pnl.totalExpenses — so the parts always sum to the
   *  headline total (Phase 2 fix: the portal used to sum raw native amounts,
   *  which drifted from the converted total for any multi-currency account). The
   *  bucket key is the row's ai_bucket ("other" when absent); the caller maps it
   *  to a catalog label. Grand total == pnl.totalExpenses (invariant-checked). */
  operating_expense_breakdown: Array<{ bucket: string; total: number }>
  ending_cash: number
  /** v1: assets = cash. */
  total_assets: number
  total_liabilities: number
  ending_capital_total: number
  /** Foreign-exchange TRANSLATION adjustment (Phase 3) — the net of the year's
   *  currency-exchange / internal-transfer ("conversion") rows in USD. A true
   *  same-currency transfer nets to zero; the leftover is the difference between
   *  valuing cross-currency exchanges at the IRS yearly-average rate and the
   *  amounts actually received. It is a DISCLOSED EQUITY line — assets =
   *  liabilities + capital + this — and is NEVER income and NEVER allocated to a
   *  member's capital account (CPA condition: it must not fabricate taxable
   *  income). Zero for all-USD / no-conversion accounts. */
  fx_translation_adjustment: number
  /** Gross USD volume of the conversion rows (Σ|amount|) — context for the
   *  translation adjustment and the "unexpectedly large" review alarm. */
  conversion_gross: number
  /** Cumulative FX/CTA equity position — input beginningCta (carried from the
   *  prior year, 0 when there is none / first adoption) plus this year's own
   *  fx_translation_adjustment. Feeds the balance identity below AND is what a
   *  future carry reads as ITS beginningCta, so the accumulated position
   *  survives year to year instead of resetting every Jan 1. Purely additive:
   *  when beginningCta is never supplied, ending_cta === fx_translation_adjustment
   *  and every existing account/test is byte-for-byte unchanged. */
  ending_cta: number
  /** Balance-sheet residual — total_assets − (total_liabilities + ending capital
   *  + ending_cta + uncategorized cash). ~0 when the sheet ties. THE single
   *  source of the balance identity: gate 3, the portal screen, and the Excel
   *  all read this field instead of each re-summing the components, so a
   *  renderer can never again silently drop a term (the FX-missing-from-Excel
   *  bug). */
  balance_sheet_check: number
  /** Contribution/distribution amounts that matched no member by name — needs staff/client resolution. */
  unattributed: { contributions: number; distributions: number }
  notes: string[]
}

export interface BuildDraftInput {
  taxYear: number
  transactions: DraftTransaction[]
  /** From resolveOwnership — only members with a pct take part in allocation. */
  members: ResolvedMember[]
  priorReturn: PriorReturnCaseRecord | null
  /** "Default + flag exceptions" policy: treat remaining uncategorized rows by
   *  sign (outflow → business expense, inflow → income) so the P&L is complete
   *  and gate 6 is not blocked; the owner flags only the exceptions. Portal tax
   *  review turns this ON; staff/Excel paths leave it OFF. */
  defaultUncategorizedBySign?: boolean
  /** IRS yearly-average rates (foreign units per USD) for converting
   *  foreign-currency amounts to USD (Phase 2). Omit for all-USD datasets. */
  fxRates?: FxRates
  /** Per-bank balance anchors (S2 slice 2): client/staff-recorded opening +
   *  closing balances in the account's own currency. Third beginning-cash
   *  source (after prior return and statement balance columns) and the
   *  per-bank tie-out anchor. */
  providedBalances?: ProvidedBankBalance[]
  /** Cumulative FX/CTA position carried from the prior year (see ending_cta on
   *  FinancialDraft). Omit/0 for every account that predates this concept or
   *  has no prior year — purely additive, changes nothing when absent. */
  beginningCta?: number
}

/**
 * The member a client EXPLICITLY confirmed, from the note's "| Member: X" tail.
 *
 * Name-matching cannot cover this case by construction: the whole reason we ask
 * is that the payee carries only a SURNAME, and matching needs the full name.
 * Without reading the confirmed answer, a draw the client just told us belongs
 * to Gabriele lands in "unattributed" and is spread across every partner by
 * ownership % — putting withdrawals on the K-1 of a partner who received
 * nothing, while the totals still tie so no gate notices.
 */
export function confirmedMemberFromNotes(notes: string | null | undefined, members: ResolvedMember[]): ResolvedMember | null {
  // Delegates to the ONE canonical note reader (./member-names) instead of a
  // second, hand-rolled parse of the same concept — this file used to search
  // for "| Member: " on its own, which missed the deterministic exact-name-
  // match parser's bare "Member: X" note (no pipe) entirely, silently falling
  // back to spreading that member's real capital contribution/distribution
  // across everyone else by ownership % (2026-08-23, bug-hunter finding: this
  // duplicate was the one place tonight's member-names.ts fix didn't reach).
  const name = confirmedMemberFromNote(notes)
  if (!name) return null
  return members.find(m => sameName(m.name, name)) ?? null
}

/**
 * Match a transaction to a member by name. Exported for tests.
 *
 * Delegates to matchMemberForTransaction (member-names.ts) — NOT sameName's
 * token-subset check — because `description`/`counterparty` are raw bank
 * free text, and a token-subset check over an entire string matches whenever
 * a member's first AND last name both appear as separate words ANYWHERE in
 * it, in any order, for any reason: the same failure the categoriser had
 * (2026-09-03) — a corporate-card line like "Airbnb | Spend | Donato Ciardo -
 * 5221 (Spese)" contains "donato" and "ciardo" as tokens without Donato being
 * the payee. sameName is right elsewhere in this file for comparing two
 * already-clean names (confirmedMemberFromNotes above, prior-K1 matching
 * below) — it is wrong here for the same reason it was wrong in the
 * categoriser.
 *
 * TWO ARGUMENTS, NOT ONE (2026-09-03 council finding): an earlier version of
 * this fix took a single `text` and applied payeePart to whichever field the
 * caller passed — which strips counterparty too, contradicting
 * matchMemberForTransaction's own rule that counterparty is checked RAW
 * because a wire genuinely made out to a member must always be caught with
 * nothing else to go on. Taking both fields and delegating directly is both
 * the fix and the simpler shape — one rule, three call sites, no fork.
 */
export function attributeToMember(description: string | null, counterparty: string | null, members: ResolvedMember[]): ResolvedMember | null {
  const matched = matchMemberForTransaction(description, counterparty, members.map(m => m.name))
  return matched ? members.find(m => m.name === matched) ?? null : null
}

/** Beginning cash from a validated prior return — from a client upload
 *  (filed_elsewhere) OR our own filed return (we_filed). Null when there is
 *  none; first_year / never_filed start at 0; quarantined / on_file are handled
 *  by the orchestration + gate 2 (staff tie out). */
export function priorEndingCash(prior: PriorReturnCaseRecord | null): number | null {
  return validatedExtraction(prior)?.schedule_l?.ending.cash ?? null
}

/** Prior per-member beginning capital from validated K-1s (matched by name),
 *  from either prior-return source. */
function priorBeginningCapital(prior: PriorReturnCaseRecord | null, memberName: string): number {
  const extracted = validatedExtraction(prior)
  if (extracted) {
    const k1 = extracted.k1s.find(k => sameName(k.partner_name, memberName))
    if (k1?.ending_capital !== null && k1?.ending_capital !== undefined) return k1.ending_capital
  }
  return 0
}

export function buildFinancialDraft(input: BuildDraftInput): FinancialDraft {
  const { taxYear, transactions: rawTransactions, members, priorReturn, fxRates, beginningCta } = input
  const notes: string[] = []

  // ── Phase 2: normalize every amount + running balance to USD ──
  // A foreign-currency row is converted by ITS OWN currency's IRS yearly-average
  // rate (USD = amount / rate). USD / empty currency pass through unchanged. A
  // non-USD row with no rate on file is left as-is and FLAGGED, so it never
  // silently counts 1:1. Everything downstream (P&L, banks, balance sheet) then
  // works in USD. Single-currency USD accounts are unaffected.
  const missingRateCurrencies = new Set<string>()
  const transactions: DraftTransaction[] = !fxRates ? rawTransactions : rawTransactions.map(t => {
    const conv = toUsd(Number(t.amount), t.currency, fxRates)
    if (conv.missingRate) missingRateCurrencies.add((t.currency ?? "").trim().toUpperCase())
    const balance_after = t.balance_after === null || t.balance_after === undefined
      ? t.balance_after
      : toUsd(Number(t.balance_after), t.currency, fxRates).usd
    return { ...t, amount: conv.usd, balance_after }
  })
  if (missingRateCurrencies.size > 0) {
    notes.push(`No IRS yearly-average exchange rate on file for ${Array.from(missingRateCurrencies).sort().join(", ")} (${taxYear}) — those amounts are shown unconverted; add the rate so the P&L is fully in USD.`)
  }

  const pnl = computePnlTotals(transactions, { defaultUncategorizedBySign: input.defaultUncategorizedBySign })

  // ── Operating-expense breakdown by AI bucket (Phase 2) ──
  // Computed on the SAME USD-converted, signed, refund-netted rows as
  // pnl.totalExpenses, so the parts ALWAYS sum to the headline total. Each row
  // contributes (−amount): an expense/fee/uncategorized-outflow adds its
  // magnitude; a refund (money received back) subtracts (contra-expense). The
  // uncategorized-outflow term is included only under the by-sign policy — the
  // exact condition computePnlTotals uses — so the two never disagree. Bucket
  // key = the row's ai_bucket ("other" when absent); the caller maps it to a
  // catalog label. Replaces the portal's old raw-native, refund-blind sum.
  const foldUncatExpense = input.defaultUncategorizedBySign === true
  const opexByBucket = new Map<string, number>()
  for (const t of transactions) {
    const amt = Number(t.amount)
    const inOpex =
      t.category === "expense" ||
      t.category === "fee" ||
      t.category === "refund" ||
      (foldUncatExpense && t.category === "uncategorized" && amt < 0)
    if (!inOpex) continue
    const bucket = typeof t.ai_bucket === "string" && t.ai_bucket.length > 0 ? t.ai_bucket : "other"
    opexByBucket.set(bucket, (opexByBucket.get(bucket) ?? 0) - amt)
  }
  const operating_expense_breakdown = Array.from(opexByBucket.entries())
    .map(([bucket, total]) => ({ bucket, total }))
    .sort((a, b) => b.total - a.total)
  const opexBreakdownSum = operating_expense_breakdown.reduce((s, b) => s + b.total, 0)
  if (Math.abs(opexBreakdownSum - pnl.totalExpenses) > 0.01) {
    notes.push(`Internal check: the operating-expense breakdown (${opexBreakdownSum.toFixed(2)}) does not add up to the operating-expense total (${pnl.totalExpenses.toFixed(2)}) — please report this.`)
  }

  // ── Per-bank cash positions (gate 1 inputs) ──
  // A statement's running-balance column is TRUSTED as the beginning/ending
  // anchor ONLY when it is reliable for that account: it covers EVERY row and
  // the chain self-reconciles in the account's own currency (opening + the
  // year's movements = closing). A partial column (only some rows carry a
  // balance) or an out-of-order/foreign-currency running total does NOT
  // reconcile, so it is DISCARDED (derived_beginning/reported_ending stay null)
  // and the merge falls back to the client/staff-provided balances — which the
  // client attests. This is the Dynamiq fix: keeping "statement-derived
  // outranks typed" TRUE while making "derived" mean "reliable derived only",
  // so an unreliable column can no longer inflate cash or raise a false "off
  // by" / "statement doesn't add up". Reliability is checked on the RAW native
  // amounts (exact — no FX rounding); the trusted position values are then USD.
  const NATIVE_RECONCILE_EPS = 0.01
  const rawByKey = new Map<string, DraftTransaction[]>()
  for (const t of rawTransactions) {
    const k = accountKeyOf(t)
    const arr = rawByKey.get(k) ?? []
    arr.push(t)
    rawByKey.set(k, arr)
  }
  const toUsdAmt = (v: number, ccy: string): number => fxRates ? toUsd(v, ccy, fxRates).usd : v
  const discardedColumns: string[] = []
  const banks: BankCashPosition[] = Array.from(rawByKey.entries()).map(([key, rawRows]) => {
    const rows = [...rawRows].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
    const curCounts = new Map<string, number>()
    for (const r of rows) {
      const c = (r.currency ?? "USD").trim().toUpperCase() || "USD"
      curCounts.set(c, (curCounts.get(c) ?? 0) + 1)
    }
    const currency = Array.from(curCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD"
    const net_movement = rows.reduce((s, r) => s + toUsdAmt(Number(r.amount), r.currency ?? "USD"), 0)

    const fullCoverage = rows.length > 0 && rows.every(r => r.balance_after !== null && r.balance_after !== undefined)
    const hasAnyBalance = rows.some(r => r.balance_after !== null && r.balance_after !== undefined)
    let derived_beginning: number | null = null
    let reported_ending: number | null = null
    if (fullCoverage) {
      const first = rows[0]
      const last = rows[rows.length - 1]
      const nativeBeginning = Number(first.balance_after) - Number(first.amount)
      const nativeEnding = Number(last.balance_after)
      const nativeNet = rows.reduce((s, r) => s + Number(r.amount), 0)
      const reconciles = Math.abs(nativeBeginning + nativeNet - nativeEnding) <= NATIVE_RECONCILE_EPS
      if (reconciles) {
        derived_beginning = toUsdAmt(nativeBeginning, currency)
        reported_ending = toUsdAmt(nativeEnding, currency)
      } else {
        discardedColumns.push(key) // full column but doesn't reconcile (ordering / foreign running total)
      }
    } else if (hasAnyBalance) {
      discardedColumns.push(key) // partial column — some rows carry no balance
    }
    return { bank_key: key, currency, derived_beginning, reported_ending, net_movement }
  })
  if (discardedColumns.length > 0) {
    notes.push(`Statement running-balance column not used as the anchor for: ${discardedColumns.join(", ")} — it was incomplete or did not reconcile, so the opening/closing balances you provided were used instead.`)
  }

  // ── Capital roll-forward per member ──
  const allocatable = members.filter(m => m.pct !== null) as Array<ResolvedMember & { pct: number }>

  // ── Beginning cash source (prior return → statements → provided → none) ──
  // Prior return wins (year-over-year tie-out). With no validated prior, fall
  // back to the statements' opening balances — but ONLY when every account
  // carries a running balance (a partial figure would mislead) AND there are
  // members to hold the matching opening equity (so the balance sheet still
  // ties: assets = equity). S2 slice 2: with neither, the client/staff-provided
  // per-bank openings fill the gap (again only when EVERY bank has one) —
  // always labeled as provided, never implied bank-verified.
  const priorCash = priorEndingCash(priorReturn)
  const allBanksHaveOpening = banks.length > 0 && banks.every(b => b.derived_beginning !== null)
  const statementOpening = allBanksHaveOpening ? banks.reduce((s, b) => s + (b.derived_beginning as number), 0) : null
  const usingStatementOpening = priorCash === null && statementOpening !== null && allocatable.length > 0

  // Per-bank balance anchors + tie-outs (computed even with no provided rows —
  // statement-derived figures alone still verify banks that carry balances).
  const balanceSummary = mergeBankBalances({
    banks,
    provided: input.providedBalances ?? [],
    fxRates: fxRates ?? null,
  })
  const usingProvidedOpening = priorCash === null && !usingStatementOpening
    && balanceSummary.total_opening_usd !== null && allocatable.length > 0
  const providedOpening = usingProvidedOpening ? balanceSummary.total_opening_usd : null
  if (balanceSummary.mismatched_banks.length > 0) {
    for (const m of balanceSummary.banks.filter(x => x.tie === "mismatch")) {
      notes.push(`${m.bank_key}: the opening balance plus the year's transactions do not equal the closing balance (off by ${(m.delta_usd as number).toFixed(2)} USD) — re-check that account's opening and closing figures, or a transaction may be missing for that account.`)
    }
  }
  for (const m of balanceSummary.banks.filter(x => x.provided_conflicts_derived)) {
    notes.push(`${m.bank_key}: the balance you provided disagrees with the statement's own balance column — please re-check which is right.`)
  }
  for (const m of balanceSummary.banks.filter(x => x.missing_fx_rate)) {
    notes.push(`${m.bank_key}: provided balance is in a currency with no IRS exchange rate on file — excluded from totals until the rate is added.`)
  }

  const contribTxs = transactions.filter(t => t.category === "contribution")
  const distTxs = transactions.filter(t => t.category === "distribution")

  const byMember = new Map<string, { contributions: number; distributions: number }>()
  for (const m of allocatable) byMember.set(m.name, { contributions: 0, distributions: 0 })
  let unattributedContrib = 0
  let unattributedDist = 0

  for (const t of contribTxs) {
    // Same precedence as distributions — a confirmed member wins.
    const m = confirmedMemberFromNotes(t.notes, allocatable)
      ?? attributeToMember(t.description, t.counterparty, allocatable)
    if (m) byMember.get(m.name)!.contributions += Number(t.amount)
    else unattributedContrib += Number(t.amount)
  }
  for (const t of distTxs) {
    // The client's own confirmation wins over name-matching — it is the only
    // signal that can identify a surname-only payee.
    const m = confirmedMemberFromNotes(t.notes, allocatable)
      ?? attributeToMember(t.description, t.counterparty, allocatable)
    if (m) byMember.get(m.name)!.distributions += Number(t.amount)
    else unattributedDist += Number(t.amount)
  }
  if (unattributedContrib !== 0 || unattributedDist !== 0) {
    notes.push(
      `Owner movements not matched to a member by name (spread by ownership % so totals tie — confirm with the client): ` +
      `contributions ${unattributedContrib.toFixed(2)}, distributions ${unattributedDist.toFixed(2)}.`,
    )
  }

  const memberCapital: MemberCapital[] = allocatable.map(m => {
    const own = byMember.get(m.name)!
    const share = m.pct / 100
    const contributions = own.contributions + unattributedContrib * share
    // Signed-sum-then-abs (matches pnl-generator.ts's totalDistributions fix):
    // a member's own attributed rows plus their ownership share of the
    // unattributed pool are combined SIGNED first, so a refund/reversal nets
    // against real draws instead of inflating the magnitude.
    const distributions = Math.abs(own.distributions + unattributedDist * share)
    // No validated prior → seed opening capital from the statements' opening cash
    // (by ownership %) so the balance sheet ties; else use the prior K-1 figure.
    const beginning = usingStatementOpening
      ? statementOpening! * share
      : usingProvidedOpening
        ? (providedOpening as number) * share
        : priorBeginningCapital(priorReturn, m.name)
    const incomeShare = pnl.netIncome * share
    return {
      name: m.name,
      pct: m.pct,
      beginning_capital: beginning,
      contributions,
      distributions,
      income_share: incomeShare,
      ending_capital: beginning + contributions + incomeShare - distributions,
    }
  })

  // ── Balance sheet (cash basis v1) ──
  const beginningCash = priorCash ?? (usingStatementOpening ? statementOpening : providedOpening)
  const beginningCashSource: FinancialDraft["beginning_cash_source"] =
    priorCash !== null ? "prior_return" : (usingStatementOpening ? "statements" : (usingProvidedOpening ? "provided" : null))
  const startCash = beginningCash ?? 0
  if (usingStatementOpening) {
    notes.push(`Beginning cash taken from your bank statements' opening balances (${statementOpening!.toFixed(2)}) — no prior-year return on file. Opening equity seeded from the same figure so the balance sheet ties; staff confirm during review.`)
  } else if (usingProvidedOpening) {
    notes.push(`Beginning cash per the provided per-bank opening balances (${(providedOpening as number).toFixed(2)} USD) — not bank-verified. Opening equity seeded from the same figure so the balance sheet ties.`)
  } else if (beginningCash === null && priorReturn && priorReturn.case === "filed_elsewhere") {
    notes.push("Prior return is not validated — beginning cash assumed 0 until staff resolve it (gate 2 will not pass).")
  }
  const netMovement = transactions.reduce((s, t) => s + Number(t.amount), 0)
  const endingCash = startCash + netMovement
  const beginningCapitalTotal = memberCapital.reduce((s, m) => s + m.beginning_capital, 0)
  const endingCapitalTotal = memberCapital.reduce((s, m) => s + m.ending_capital, 0)

  // ── Foreign-exchange translation adjustment (Phase 3) ──
  // Cash (assets) carries every "conversion" row (currency exchanges + internal
  // transfers); member capital does NOT (conversions are neither income nor
  // owner movement). A matched same-currency transfer nets to zero; the leftover
  // is the spot-vs-yearly-average difference on cross-currency exchanges (plus
  // any unmatched leg). It equals assets − (liabilities + capital), so recording
  // it as a disclosed EQUITY translation line makes the balance sheet tie
  // HONESTLY — without inventing income or touching any member's capital account.
  const conversionRows = transactions.filter(t => t.category === "conversion")
  const fxTranslationAdjustment = conversionRows.reduce((s, t) => s + Number(t.amount), 0)
  const conversionGross = conversionRows.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  // Cumulative position = whatever carried in (0 when there's none) + this
  // year's own movement. Carrying this forward is what stops a carried-forward
  // year from opening "off by" the prior year's stale FX position (round-2
  // bug-hunter blocker) — the balance identity below uses THIS, not the bare
  // single-year fxTranslationAdjustment.
  const endingCta = (beginningCta ?? 0) + fxTranslationAdjustment
  if (Math.abs(fxTranslationAdjustment) > 0.01) {
    notes.push(`Foreign-exchange translation adjustment of ${fxTranslationAdjustment.toFixed(2)} USD — the difference between valuing currency exchanges at the IRS yearly-average rate and the amounts actually received. It is shown as an equity translation adjustment so the balance sheet ties; it is not income and is not added to any member's capital account.`)
    // Magnitude alarm (CPA/architect condition): genuine FX drift is small next
    // to the exchange volume. A large share means a transfer leg or a whole
    // account may be missing, or a row is mis-categorized as a transfer — never
    // let the tie-out silently bury that.
    if (conversionGross > 0 && Math.abs(fxTranslationAdjustment) / conversionGross > 0.10) {
      notes.push(`This translation adjustment is large relative to the currency-exchange volume — a transfer leg or a bank account may be missing, or a transaction may be mis-categorized as an internal transfer. Staff should review before filing.`)
    }
  }

  return {
    tax_year: taxYear,
    pnl,
    members: memberCapital,
    banks,
    bank_balances: banks.length > 0 ? balanceSummary : null,
    beginning_cash: beginningCash,
    beginning_cash_source: beginningCashSource,
    beginning_capital_total: beginningCapitalTotal,
    operating_expense_breakdown,
    ending_cash: endingCash,
    total_assets: endingCash,
    total_liabilities: 0,
    ending_capital_total: endingCapitalTotal,
    fx_translation_adjustment: fxTranslationAdjustment,
    conversion_gross: conversionGross,
    ending_cta: endingCta,
    balance_sheet_check: endingCash - (0 + endingCapitalTotal + endingCta + pnl.uncategorizedTotal),
    unattributed: { contributions: unattributedContrib, distributions: unattributedDist },
    notes,
  }
}
