/**
 * QB One-Way Sync — Pushes CRM invoice data to QuickBooks
 *
 * Direction: Supabase (SOT) → QuickBooks (accounting mirror)
 * QB is for accounting/tax only. CRM invoices are the source of truth.
 *
 * All functions are non-blocking best-effort: they catch errors and
 * update qb_sync_status on the payment record rather than throwing.
 */

import { qbApiCall, createInvoice } from "@/lib/quickbooks"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ─── Types ──────────────────────────────────────────────

interface QbSyncResult {
  success: boolean
  qb_invoice_id?: string
  qb_doc_number?: string
  error?: string
}

// ─── Sync Invoice to QB ─────────────────────────────────

/**
 * Push a CRM invoice to QuickBooks. Creates a QB invoice mirroring the CRM data.
 * Updates payment.qb_invoice_id + qb_sync_status on the CRM record.
 *
 * Call this AFTER invoice is sent (status = Sent).
 */
export async function syncInvoiceToQB(paymentId: string): Promise<QbSyncResult> {
  try {
    // Fetch payment + items + account
    const { data: payment, error: pErr } = await supabaseAdmin
      .from("payments")
      .select("*, payment_items(*)")
      .eq("id", paymentId)
      .single()

    if (pErr || !payment) {
      return { success: false, error: `Payment not found: ${pErr?.message}` }
    }

    // Already synced?
    if (payment.qb_invoice_id) {
      await updateSyncStatus(paymentId, "synced")
      return { success: true, qb_invoice_id: payment.qb_invoice_id }
    }

    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("company_name")
      .eq("id", payment.account_id)
      .single()

    const customerName = account?.company_name ?? "Unknown Client"
    const items = (payment.payment_items ?? []) as Array<{
      description: string
      quantity: number
      unit_price: number
    }>

    // If no items, create a single line item from payment description + amount
    const lineItems = items.length > 0
      ? items.map((item) => ({
          description: item.description,
          amount: Number(item.unit_price),
          quantity: Number(item.quantity),
        }))
      : [{
          description: payment.description ?? "Invoice",
          amount: Number(payment.total ?? payment.amount ?? 0),
          quantity: 1,
        }]

    // Get contact email for QB customer
    const { data: contactLink } = await supabaseAdmin
      .from("account_contacts")
      .select("contacts(email)")
      .eq("account_id", payment.account_id)
      .eq("role", "Owner")
      .limit(1)
      .maybeSingle()

    const contactEmail = (contactLink as unknown as { contacts: { email: string } })?.contacts?.email

    // Create QB invoice
    const result = await createInvoice({
      customerName,
      customerEmail: contactEmail,
      lineItems,
      dueDate: payment.due_date ?? undefined,
      memo: `CRM Invoice: ${payment.invoice_number ?? paymentId}`,
    })

    const qbInvoice = result.Invoice
    const qbInvoiceId = qbInvoice?.Id as string
    const qbDocNumber = qbInvoice?.DocNumber as string

    // Store QB reference on CRM record
    await supabaseAdmin
      .from("payments")
      .update({
        qb_invoice_id: qbInvoiceId,
        qb_sync_status: "synced",
        qb_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId)

    return { success: true, qb_invoice_id: qbInvoiceId, qb_doc_number: qbDocNumber }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await updateSyncStatus(paymentId, "error", errorMsg)
    return { success: false, error: errorMsg }
  }
}

// ─── Sync Payment to QB ─────────────────────────────────

/**
 * Record a payment in QB against the synced invoice.
 * Call this when a CRM invoice is marked as Paid.
 */
export async function syncPaymentToQB(
  paymentId: string,
  opts?: { paymentDate?: string; paymentMethod?: string; reference?: string }
): Promise<QbSyncResult> {
  try {
    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("qb_invoice_id, total, amount, account_id")
      .eq("id", paymentId)
      .single()

    if (!payment?.qb_invoice_id) {
      // No QB invoice to pay against — skip silently
      return { success: true }
    }

    // Fetch QB invoice to get customer + balance
    const qbInvoice = await qbApiCall(`/invoice/${payment.qb_invoice_id}`)
    const inv = qbInvoice.Invoice

    if (!inv || inv.Balance === 0) {
      return { success: true } // Already paid in QB
    }

    const qbPayment: Record<string, unknown> = {
      CustomerRef: inv.CustomerRef,
      TotalAmt: inv.Balance,
      Line: [{
        Amount: inv.Balance,
        LinkedTxn: [{ TxnId: inv.Id, TxnType: "Invoice" }],
      }],
    }

    if (opts?.paymentDate) qbPayment.TxnDate = opts.paymentDate
    if (opts?.reference) qbPayment.PaymentRefNum = opts.reference

    await qbApiCall("/payment", { method: "POST", body: qbPayment })

    return { success: true, qb_invoice_id: payment.qb_invoice_id }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    // Don't overwrite sync status — the invoice was synced, just the payment failed
    console.error(`[qb-sync] Payment sync failed for ${paymentId}:`, errorMsg)
    return { success: false, error: errorMsg }
  }
}

// ─── Sync Void to QB ────────────────────────────────────

/**
 * Void the corresponding QB invoice when a CRM invoice is voided.
 */
export async function syncVoidToQB(paymentId: string): Promise<QbSyncResult> {
  try {
    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("qb_invoice_id")
      .eq("id", paymentId)
      .single()

    if (!payment?.qb_invoice_id) {
      return { success: true } // Nothing to void in QB
    }

    // Get the invoice to retrieve SyncToken
    const qbInvoice = await qbApiCall(`/invoice/${payment.qb_invoice_id}`)
    const inv = qbInvoice.Invoice

    if (!inv) {
      return { success: true } // Already gone from QB
    }

    await qbApiCall("/invoice?operation=void", {
      method: "POST",
      body: { Id: inv.Id, SyncToken: inv.SyncToken },
    })

    await supabaseAdmin
      .from("payments")
      .update({
        qb_sync_status: "synced",
        qb_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId)

    return { success: true, qb_invoice_id: payment.qb_invoice_id }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await updateSyncStatus(paymentId, "error", errorMsg)
    return { success: false, error: errorMsg }
  }
}

// ─── Helpers ────────────────────────────────────────────

async function updateSyncStatus(paymentId: string, status: string, error?: string) {
  try {
    await supabaseAdmin
      .from("payments")
      .update({
        qb_sync_status: status,
        qb_sync_error: error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId)
  } catch {
    // Best effort — don't throw
  }
}
