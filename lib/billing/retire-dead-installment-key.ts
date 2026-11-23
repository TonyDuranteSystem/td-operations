/**
 * Frees the key of a cancelled / voided installment invoice so the installment can be invoiced again (dev job bea928e0).
 *
 * An installment invoice carries a fixed key (company + number + year — see installment-invoice-key.ts). The key is unique across
 * EVERY row, dead ones included, and some cancel paths leave it on the row (production had 8 such rows, 2 of them with no
 * replacement: re-invoicing from the company page would have hit a raw database error). Voiding an invoice already clears its key
 * (finance voidInvoice, cancel-offer-payments, close-company); this does the same for the rows that were cancelled without it.
 *
 * Deliberately narrow: it only ever touches an INSTALLMENT key, and only on a row that is cancelled or voided. A credit note's key
 * (invoice_status 'Credit') and every live invoice are never touched — freeing a credit note's key would let the same credit be
 * written twice.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isInstallmentIdempotencyKey } from "@/lib/billing/installment-invoice-key"

/** Returns how many dead rows had their key cleared (0 for any key that is not an installment key). */
export async function retireDeadInstallmentKey(key: string | null | undefined): Promise<number> {
  if (!key || !isInstallmentIdempotencyKey(key)) return 0
  // eslint-disable-next-line no-restricted-syntax -- clears the key of a dead (cancelled/voided) installment invoice, same as the void paths do; createTDInvoice has no helper for it.
  const { data, error } = await supabaseAdmin
    .from("payments")
    .update({ idempotency_key: null })
    .eq("idempotency_key", key)
    .or("status.eq.Cancelled,invoice_status.eq.Cancelled,invoice_status.eq.Voided")
    .select("id")
  if (error) throw new Error(`retireDeadInstallmentKey: ${error.message}`)
  return data?.length ?? 0
}
