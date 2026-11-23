/**
 * Was credit netted into this invoice? (dev job e62bc2b6, bug-hunter follow-up)
 *
 * Credit comes out of a company's credit pool. When it is applied to an invoice it shows as a negative "Credit applied" line
 * on the invoice, and a credit note used up completely on it carries the invoice's id in credit_consumed_by. Either way,
 * moving that invoice to ANOTHER company would leave the first company's credit spent on an invoice in someone else's books —
 * so the Bill to change refuses the move (a payer can still be named). Read-only.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { CREDIT_LINE_LABEL } from "@/lib/portal/invoice-regenerate"

export async function invoiceHasAppliedCredit(paymentId: string): Promise<boolean> {
  const { data: lines, error } = await supabaseAdmin
    .from("payment_items")
    .select("amount")
    .eq("payment_id", paymentId)
    .eq("description", CREDIT_LINE_LABEL)
  if (error) throw new Error(`Could not check credit on the invoice: ${error.message}`)
  // A credit line is NEGATIVE (a positive line that happens to carry the label is not credit).
  if ((lines ?? []).some((l) => Number((l as { amount: number | string | null }).amount) < 0)) return true

  const { data: used, error: usedErr } = await supabaseAdmin
    .from("payments")
    .select("id")
    .eq("credit_consumed_by", paymentId)
    .limit(1)
  if (usedErr) throw new Error(`Could not check credit on the invoice: ${usedErr.message}`)
  return (used ?? []).length > 0
}
