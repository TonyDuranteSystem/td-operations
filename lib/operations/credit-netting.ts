import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildRegeneratedLineItems,
  computeClickToApplyCredit,
  isCreditLine,
  sumLineAmounts,
} from "@/lib/portal/invoice-regenerate"
import { syncTDInvoiceMirror } from "@/lib/portal/td-invoice-mirror"

export interface CreditApplication {
  appliedTotal: number
  credits: Array<{ id: string; applyAmount: number }>
  /** Credits this client holds in a DIFFERENT currency — never applied (no FX),
   *  but reported so staff can be told rather than the client silently billed
   *  full price after being promised a deduction (hunter major 4). */
  strandedByCurrency?: Array<{ amount: number; currency: string }>
}

/**
 * WS-A: the scope a credit lives in. EXACTLY ONE key — the query filters on one
 * scope column, so account credits can never surface for a contact-scoped
 * invoice or vice versa (pinned by regression tests T5/T6).
 */
export type CreditScope = { accountId: string; contactId?: never } | { contactId: string; accountId?: never }

/**
 * Atomically CLAIM credits for an invoice-to-be (WS-A, dev job c0a61e44).
 *
 * Two concurrent signings both READ the same available credit (proven by test
 * T9) — so the guard must live in the write. Each claim is a conditional
 * UPDATE on `credit_consumed_by IS NULL`, rowcount-checked: of two racers
 * exactly one wins a given credit; the loser gets nothing for that credit and
 * its caller must not apply it.
 *
 * ORDER (uniform for BOTH scopes): claim → create the invoice → confirm
 * (decrement remaining). If the invoice creation fails, the caller calls
 * `unwindCreditClaims` so the credits become available again.
 *
 * @returns the subset of `application.credits` this caller actually won.
 */
export async function claimCredits(
  application: CreditApplication,
  claimToken: string,
  supabase: SupabaseClient,
): Promise<CreditApplication> {
  const won: Array<{ id: string; applyAmount: number }> = []
  for (const c of application.credits) {
    const { data, error } = await supabase
      .from("payments")
      .update({ credit_consumed_by: claimToken })
      .eq("id", c.id)
      .is("credit_consumed_by", null)
      .select("id")
    if (error) {
      console.error(`[claimCredits] claim failed for credit ${c.id}:`, error.message)
      continue
    }
    // rowcount 1 = we won this credit; 0 = a concurrent claimer got there first.
    if (Array.isArray(data) && data.length === 1) won.push(c)
  }
  const appliedTotal = Math.round(won.reduce((s, a) => s + a.applyAmount, 0) * 100) / 100
  return { appliedTotal, credits: won }
}

/**
 * CONFIRM step (third of claim → create → confirm): re-stamp the claim from the
 * temporary token to the real invoice id, so the column reads "claimed BY this
 * invoice" for audit. Lives here (not at the call site) so the credit-claim
 * writes stay in one module — and so the supabase generic depth stays bounded.
 */
export async function confirmCreditClaims(
  application: CreditApplication,
  invoiceId: string,
  claimToken: string,
  supabase: SupabaseClient,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate: bounds TS2589 on the chained update; column is newer than generated types
  const untyped = supabase as unknown as { from: (t: string) => any }
  for (const c of application.credits) {
    // THE CLAIM IS A TRANSIENT LOCK, NOT A TOMBSTONE (hunter blocker 1).
    // A partially-used credit MUST return to the pool: the read filters on
    // `credit_consumed_by IS NULL`, so leaving the stamp on a credit that still
    // has a balance would strand that balance forever — invisible to both
    // auto-netting and click-to-apply. Re-read the remaining balance and
    // release the lock unless the credit is now exhausted.
    const { data: row } = await untyped
      .from("payments")
      .select("credit_remaining")
      .eq("id", c.id)
      .maybeSingle()
    const remaining = Number((row as { credit_remaining?: number | null } | null)?.credit_remaining ?? 0)
    const { error } = await untyped
      .from("payments")
      .update({ credit_consumed_by: remaining > 0 ? null : invoiceId })
      .eq("id", c.id)
      .eq("credit_consumed_by", claimToken)
    if (error) console.error(`[confirmCreditClaims] claim settle failed for credit ${c.id}:`, error.message)
  }
}

/**
 * Release claims taken by `claimCredits` when the invoice creation that they
 * were claimed FOR did not happen. Scoped to this caller's claim token so a
 * concurrent winner's claim is never released by someone else's failure.
 */
export async function unwindCreditClaims(
  application: CreditApplication,
  claimToken: string,
  supabase: SupabaseClient,
): Promise<void> {
  for (const c of application.credits) {
    const { error } = await supabase
      .from("payments")
      .update({ credit_consumed_by: null })
      .eq("id", c.id)
      .eq("credit_consumed_by", claimToken)
    if (error) console.error(`[unwindCreditClaims] release failed for credit ${c.id}:`, error.message)
  }
}

/**
 * Compute how much of an account's outstanding credit notes to apply against an
 * invoice of `amount`. Same-currency only, oldest-first, capped at the invoice
 * amount. Pure read — does NOT mutate. The caller creates the offsetting invoice
 * (with a negative "credit applied" line of `appliedTotal`), then calls
 * consumeCredits() to decrement the credits. Leftover credit carries forward.
 */
export async function computeCreditApplication(
  params: ({ accountId: string; contactId?: string } | { contactId: string; accountId?: string }) & {
    amount: number
    currency: string
  },
  supabase: SupabaseClient
): Promise<CreditApplication> {
  const { amount, currency } = params
  const accountId = (params as { accountId?: string }).accountId
  const contactId = (params as { contactId?: string }).contactId
  if (amount <= 0) return { appliedTotal: 0, credits: [] }
  // EXACTLY ONE scope column filters the query (WS-A). Account scope wins when
  // both are somehow supplied — an account-linked invoice is account money.
  // Cross-scope credits can never surface: there is no OR here, by design
  // (pinned by regression tests T5/T6; mutation-proven).
  if (!accountId && !contactId) return { appliedTotal: 0, credits: [] }

  const scopeColumn = accountId ? "account_id" : "contact_id"
  const scopeValue = accountId ?? (contactId as string)

  const { data: credits } = await supabase
    .from("payments")
    .select("id, credit_remaining")
    .eq(scopeColumn, scopeValue)
    .eq("invoice_status", "Credit")
    .eq("amount_currency", currency)
    .gt("credit_remaining", 0)
    .is("credit_consumed_by", null) // unclaimed only — a claimed credit is spoken for
    .order("created_at", { ascending: true }) // oldest-first

  let remainingNeed = amount
  const applied: Array<{ id: string; applyAmount: number }> = []
  for (const cr of (credits ?? []) as Array<{ id: string; credit_remaining: number | null }>) {
    if (remainingNeed <= 0) break
    const avail = Number(cr.credit_remaining) || 0
    if (avail <= 0) continue
    const use = Math.min(avail, remainingNeed)
    applied.push({ id: cr.id, applyAmount: use })
    remainingNeed -= use
  }

  const appliedTotal = Math.round(applied.reduce((s, a) => s + a.applyAmount, 0) * 100) / 100

  // CROSS-CURRENCY VISIBILITY (hunter major 4): a €257 call credit against a USD
  // offer applies NOTHING — correct (no silent FX), but the client was told the
  // fee is deductible, so silence is the wrong answer. Report it; the caller
  // raises the staff notice. A pure read: nothing here mutates.
  const { data: otherCurrency } = await supabase
    .from("payments")
    .select("id, credit_remaining, amount_currency")
    .eq(scopeColumn, scopeValue)
    .eq("invoice_status", "Credit")
    .neq("amount_currency", currency)
    .gt("credit_remaining", 0)
    .is("credit_consumed_by", null)
  const strandedByCurrency = ((otherCurrency ?? []) as Array<{ credit_remaining: number | null; amount_currency: string }>)
    .map((r) => ({ amount: Number(r.credit_remaining) || 0, currency: r.amount_currency }))
    .filter((r) => r.amount > 0)

  return { appliedTotal, credits: applied, ...(strandedByCurrency.length ? { strandedByCurrency } : {}) }
}

/**
 * Decrement credit_remaining for each applied credit after the offsetting invoice
 * is created. Re-reads each row to avoid clobbering a concurrent decrement, and
 * stamps credit_for_payment_id with the invoice it most recently offset (audit).
 * Idempotency note: only call after a NEW invoice is created (not on a cron re-run
 * that returns an existing invoice), so credits are never consumed twice.
 */
export async function consumeCredits(
  application: CreditApplication,
  offsetInvoiceId: string,
  supabase: SupabaseClient
): Promise<void> {
  for (const c of application.credits) {
    const { data: row } = await supabase
      .from("payments")
      .select("credit_remaining, credit_for_payment_id")
      .eq("id", c.id)
      .single()
    const r = row as { credit_remaining: number | null; credit_for_payment_id: string | null } | null
    // Idempotency: if this credit was already applied to this same invoice
    // (cron re-run / double fire), skip — don't decrement twice.
    if (r?.credit_for_payment_id === offsetInvoiceId) continue
    const current = Number(r?.credit_remaining ?? 0)
    const next = Math.max(Math.round((current - c.applyAmount) * 100) / 100, 0)
    // eslint-disable-next-line no-restricted-syntax -- credit_remaining bookkeeping on the credit-note payments row; not a client/tier field.
    await supabase
      .from("payments")
      .update({ credit_remaining: next, credit_for_payment_id: offsetInvoiceId })
      .eq("id", c.id)
  }
}

// ─── Reconcile EXISTING unpaid invoices against outstanding credits ──────────

export interface InvoiceNeed { id: string; amountDue: number; currency: string }
export interface CreditAvail { id: string; remaining: number; currency: string }
export interface CreditAllocation { invoiceId: string; creditId: string; amount: number }

/**
 * Pure FIFO allocator: distribute outstanding credits across unpaid invoices,
 * same-currency only, oldest-first (caller orders both lists). Returns the list
 * of (invoice, credit, amount) applications. Does NOT mutate — fully unit tested.
 */
export function allocateCredits(invoices: InvoiceNeed[], credits: CreditAvail[]): CreditAllocation[] {
  const remaining = new Map(credits.map((c) => [c.id, Math.max(Number(c.remaining) || 0, 0)]))
  const out: CreditAllocation[] = []
  for (const inv of invoices) {
    let need = Math.max(Number(inv.amountDue) || 0, 0)
    if (need <= 0) continue
    for (const c of credits) {
      if (need <= 0) break
      if (c.currency !== inv.currency) continue
      const avail = remaining.get(c.id) ?? 0
      if (avail <= 0) continue
      const use = Math.round(Math.min(avail, need) * 100) / 100
      if (use <= 0) continue
      out.push({ invoiceId: inv.id, creditId: c.id, amount: use })
      remaining.set(c.id, Math.round((avail - use) * 100) / 100)
      need = Math.round((need - use) * 100) / 100
    }
  }
  return out
}

export interface ReconcileResult { applied: number; invoicesAffected: number; allocations: CreditAllocation[] }

/**
 * ⚠️ RETAINED BUT NO LONGER AUTO-INVOKED (2026-06-03). Credit application moved to
 * a click-to-apply model: credits sit as available credit_remaining and are applied
 * to a SPECIFIC invoice only when staff click Regenerate (see regenerateInvoice in
 * app/(dashboard)/payments/invoice-actions.ts). This function applied credits to the
 * OLDEST unpaid invoice automatically, which caused a credit earned in June to
 * silently reduce an overdue January invoice (Wise Strategies bug). DO NOT re-wire
 * this into credit creation (createCreditNote / createManualReferralCredit). Kept
 * only as a potential future "reconcile all" batch tool; harmless if uncalled.
 *
 * Apply an account's outstanding credit notes to its EXISTING unpaid invoices
 * ("reduce amount owed, keep total"): drops each invoice's amount_due, marks it
 * Paid when fully covered, consumes credit_remaining, and mirrors the new balance
 * onto client_expenses so the portal shows the true amount due. Idempotent-ish:
 * only touches invoices with amount_due>0 and credits with credit_remaining>0, so
 * re-running after everything is netted is a no-op. Returns what was applied.
 */
export async function reconcileAccountCredits(accountId: string, supabase: SupabaseClient): Promise<ReconcileResult> {
  // Outstanding REAL invoices (not credit notes, not cancelled), oldest first.
  const { data: invRows } = await supabase
    .from("payments")
    .select("id, amount_due, amount_paid, amount_currency, total")
    .eq("account_id", accountId)
    .neq("invoice_status", "Credit")
    .neq("status", "Cancelled")
    .neq("invoice_status", "Cancelled")
    .gt("amount_due", 0)
    .order("created_at", { ascending: true })

  // Outstanding credits, oldest first.
  const { data: crRows } = await supabase
    .from("payments")
    .select("id, credit_remaining, amount_currency")
    .eq("account_id", accountId)
    .eq("invoice_status", "Credit")
    .gt("credit_remaining", 0)
    .order("created_at", { ascending: true })

  const invoices: InvoiceNeed[] = (invRows ?? []).map((r) => ({
    id: (r as { id: string }).id,
    amountDue: Number((r as { amount_due: number | null }).amount_due) || 0,
    currency: (r as { amount_currency: string }).amount_currency,
  }))
  const credits: CreditAvail[] = (crRows ?? []).map((r) => ({
    id: (r as { id: string }).id,
    remaining: Number((r as { credit_remaining: number | null }).credit_remaining) || 0,
    currency: (r as { amount_currency: string }).amount_currency,
  }))
  if (invoices.length === 0 || credits.length === 0) return { applied: 0, invoicesAffected: 0, allocations: [] }

  const allocations = allocateCredits(invoices, credits)
  if (allocations.length === 0) return { applied: 0, invoicesAffected: 0, allocations: [] }

  // Sum applied per invoice + per credit.
  const byInvoice = new Map<string, number>()
  const byCredit = new Map<string, number>()
  for (const a of allocations) {
    byInvoice.set(a.invoiceId, Math.round(((byInvoice.get(a.invoiceId) ?? 0) + a.amount) * 100) / 100)
    byCredit.set(a.creditId, Math.round(((byCredit.get(a.creditId) ?? 0) + a.amount) * 100) / 100)
  }

  const invById = new Map((invRows ?? []).map((r) => [(r as { id: string }).id, r as { amount_due: number | null; amount_paid: number | null }]))

  // Apply to each invoice (+ its portal mirror).
  for (const [invId, applied] of Array.from(byInvoice.entries())) {
    const cur = invById.get(invId)
    const prevDue = Number(cur?.amount_due) || 0
    const prevPaid = Number(cur?.amount_paid) || 0
    const newDue = Math.max(Math.round((prevDue - applied) * 100) / 100, 0)
    const newPaid = Math.round((prevPaid + applied) * 100) / 100
    const settled = newDue <= 0
    // eslint-disable-next-line no-restricted-syntax -- credit reconciliation bookkeeping on the invoice payments row (sanctioned write path, mirrors createTDInvoice netting).
    await supabase.from("payments").update({
      amount_due: newDue,
      amount_paid: newPaid,
      ...(settled ? { status: "Paid", invoice_status: "Paid", paid_date: new Date().toISOString().split("T")[0] } : {}),
    }).eq("id", invId)
    // Project the client mirror from the updated payments row via the single
    // authoritative sync — same path as applyAvailableCreditToInvoice, so this
    // (retained) path can't drift the mirror either.
    await syncTDInvoiceMirror(invId)
  }

  // Decrement each credit's remaining + stamp the last invoice it offset.
  for (const [creditId, used] of Array.from(byCredit.entries())) {
    const { data: row } = await supabase.from("payments").select("credit_remaining").eq("id", creditId).single()
    const current = Number((row as { credit_remaining: number | null } | null)?.credit_remaining ?? 0)
    const next = Math.max(Math.round((current - used) * 100) / 100, 0)
    const lastInv = allocations.filter((a) => a.creditId === creditId).slice(-1)[0]?.invoiceId
    // eslint-disable-next-line no-restricted-syntax -- credit_remaining bookkeeping on the credit-note payments row.
    await supabase.from("payments").update({ credit_remaining: next, credit_for_payment_id: lastInv ?? null }).eq("id", creditId)
  }

  const appliedTotal = Math.round(Array.from(byInvoice.values()).reduce((s, v) => s + v, 0) * 100) / 100
  return { applied: appliedTotal, invoicesAffected: byInvoice.size, allocations }
}

// ─── Click-to-apply: apply available credit to ONE specific invoice ──────────

export interface ApplyCreditToInvoiceResult {
  invoice_number: string | null
  applied_credit: number // NEWLY applied this call
  new_total: number
  mirror_synced?: boolean // client-portal copy was (re)synced to match the invoice
}

/**
 * Click-to-apply credit application (2026-06-03; WS-A: contact scope added).
 * Applies the client's AVAILABLE credit to THE GIVEN invoice (the one staff
 * clicked Regenerate on), capped at what the invoice still owes, shows it as a
 * "Credit applied −$X" line, drops amount_due, and consumes the credit.
 * amount_paid tracks REAL cash only — credit is represented purely as the line.
 * Idempotent: a re-call with no remaining available credit re-renders the same
 * document.
 *
 * SCOPE (WS-A): an account-scoped invoice draws on ACCOUNT credits; a
 * contact-only invoice (e.g. the signing invoice before the company exists)
 * draws on that CONTACT's credits. Exactly one scope per call — the pools never
 * mix. An invoice with neither is rejected.
 *
 * Throws on invalid targets (missing, credit note, cancelled, scopeless). Pure
 * math lives in invoice-regenerate.ts; this function is the DB orchestration,
 * shared by the regenerateInvoice server action and the sandbox integration test.
 */
export async function applyAvailableCreditToInvoice(
  paymentId: string,
  supabase: SupabaseClient,
): Promise<ApplyCreditToInvoiceResult> {
  const { data: inv } = await supabase
    .from("payments")
    .select("id, account_id, contact_id, invoice_number, invoice_status, status, amount_due, amount_paid, amount_currency")
    .eq("id", paymentId)
    .single()
  if (!inv) throw new Error("Invoice not found")
  if (!inv.account_id && !(inv as { contact_id?: string | null }).contact_id) {
    throw new Error("Regenerate needs an invoice linked to a client (account or contact).")
  }
  if (inv.invoice_status === "Credit") throw new Error("A credit note cannot be regenerated.")
  if (inv.invoice_status === "Cancelled" || inv.status === "Cancelled") throw new Error("A cancelled invoice cannot be regenerated.")

  const { data: itemRows } = await supabase
    .from("payment_items")
    .select("description, quantity, unit_price, amount, sort_order, item_type")
    .eq("payment_id", paymentId)
    .order("sort_order", { ascending: true })
  const items = (itemRows ?? []).map((i) => ({
    description: (i as { description: string }).description,
    quantity: Number((i as { quantity: number | null }).quantity) || 1,
    unit_price: Number((i as { unit_price: number | null }).unit_price) || 0,
    amount: Number((i as { amount: number | null }).amount) || 0,
    // Carry the card-fee marker through so a credit-apply never wipes it and the
    // invoice's card_fee_amount stays valid (dev_task 6ec6872a).
    item_type: (i as { item_type?: string | null }).item_type === "fee" ? "fee" : "service",
  }))

  const gross = sumLineAmounts(items.filter((i) => !isCreditLine(i)))
  const existingCredit = Math.abs(sumLineAmounts(items.filter((i) => isCreditLine(i))))
  const cashPaid = Math.max(Number((inv as { amount_paid: number | null }).amount_paid) || 0, 0)
  const invoiceNumber = (inv as { invoice_number: string | null }).invoice_number
  if (gross <= 0) return { invoice_number: invoiceNumber, applied_credit: 0, new_total: gross }

  // Pull the account's AVAILABLE credit (oldest-first, same currency), capped at
  // this invoice's remaining room. Both reads and selects which rows to consume.
  const headroom = Math.max(Math.round((gross - cashPaid - existingCredit) * 100) / 100, 0)
  // WS-A: same one-scope-per-call rule as auto-netting. Account wins when both
  // are present (an account-linked invoice is account money).
  const invScope = (inv as { account_id: string | null }).account_id
    ? { accountId: (inv as { account_id: string }).account_id }
    : { contactId: (inv as { contact_id: string }).contact_id }
  const application = await computeCreditApplication(
    { ...invScope, amount: headroom, currency: (inv as { amount_currency: string }).amount_currency },
    supabase,
  )
  const calc = computeClickToApplyCredit({ gross, cashPaid, existingCredit, available: application.appliedTotal })

  if (calc.totalCredit <= 0) return { invoice_number: invoiceNumber, applied_credit: 0, new_total: gross }

  const newItems = buildRegeneratedLineItems(items, calc.totalCredit)

  await supabase.from("payment_items").delete().eq("payment_id", paymentId)
  await supabase.from("payment_items").insert(
    newItems.map((it, i) => ({
      payment_id: paymentId,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price,
      amount: it.amount,
      sort_order: i,
      // Preserve the fee marker on reinsert so `base = sum(item_type<>'fee')` and the
      // invoice's card_fee_amount stay correct after a credit-apply (dev_task 6ec6872a).
      item_type: it.item_type === "fee" ? "fee" : "service",
    })),
  )

  // eslint-disable-next-line no-restricted-syntax -- in-place document rebuild on an existing payments row (no new invoice, no money moved); credit consumed via consumeCredits below.
  await supabase.from("payments").update({
    amount: calc.newTotal,
    subtotal: calc.newTotal,
    total: calc.newTotal,
    amount_due: calc.newDue,
    ...(calc.settled ? { status: "Paid", invoice_status: "Paid" } : {}),
  }).eq("id", paymentId)

  // Project the client-facing mirror from the (now-updated) payments row via the
  // single authoritative sync — NOT a hand-rolled partial update. The old
  // per-column update here could silently miss (Giuseppe INV-002233 drift:
  // payment → $700, mirror stuck at $1,150). syncTDInvoiceMirror rebuilds the
  // full financial state, so the client always sees the reduced balance.
  const mirror = await syncTDInvoiceMirror(paymentId)

  if (application.appliedTotal > 0 && calc.newApply > 0) {
    await consumeCredits(application, paymentId, supabase)
  }

  return { invoice_number: invoiceNumber, applied_credit: calc.newApply, new_total: calc.newTotal, mirror_synced: mirror.changed }
}
