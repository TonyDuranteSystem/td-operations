import type { SupabaseClient } from "@supabase/supabase-js"

export interface CreditApplication {
  appliedTotal: number
  credits: Array<{ id: string; applyAmount: number }>
}

/**
 * Compute how much of an account's outstanding credit notes to apply against an
 * invoice of `amount`. Same-currency only, oldest-first, capped at the invoice
 * amount. Pure read — does NOT mutate. The caller creates the offsetting invoice
 * (with a negative "credit applied" line of `appliedTotal`), then calls
 * consumeCredits() to decrement the credits. Leftover credit carries forward.
 */
export async function computeCreditApplication(
  params: { accountId: string; amount: number; currency: string },
  supabase: SupabaseClient
): Promise<CreditApplication> {
  const { accountId, amount, currency } = params
  if (amount <= 0) return { appliedTotal: 0, credits: [] }

  const { data: credits } = await supabase
    .from("payments")
    .select("id, credit_remaining")
    .eq("account_id", accountId)
    .eq("invoice_status", "Credit")
    .eq("amount_currency", currency)
    .gt("credit_remaining", 0)
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
  return { appliedTotal, credits: applied }
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
 * Apply an account's outstanding credit notes to its EXISTING unpaid invoices
 * ("reduce amount owed, keep total"): drops each invoice's amount_due, marks it
 * Paid when fully covered, consumes credit_remaining, and mirrors the new balance
 * onto client_expenses so the portal shows the true amount due. Idempotent-ish:
 * only touches invoices with amount_due>0 and credits with credit_remaining>0, so
 * re-running after everything is netted is a no-op. Safe to call after any credit
 * is created. Returns what was applied.
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
    // Mirror onto client_expenses (portal-visible balance).
    // eslint-disable-next-line no-restricted-syntax -- portal expense mirror balance update; consistency with the invoice row above.
    await supabase.from("client_expenses").update({
      amount_due: newDue,
      amount_paid: newPaid,
      ...(settled ? { status: "Paid", paid_date: new Date().toISOString().split("T")[0] } : {}),
    }).eq("td_payment_id", invId)
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
