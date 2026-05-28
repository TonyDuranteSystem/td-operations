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
