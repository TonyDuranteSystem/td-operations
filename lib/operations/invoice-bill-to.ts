/**
 * Change who an invoice is billed to — the ONE write path (dev job e62bc2b6,
 * Antonio 2026-11-21). Used by the Finance "Bill to" button (staff) and by the
 * client's "someone else is paying" box on the payment page.
 *
 * What it changes: payments.billing_entity_id (the payer printed as Bill To) and,
 * only when the choice is "a company in the CRM" or "the person", payments.account_id.
 * When the company changes, the client's own copy of the invoice (the client_expenses
 * mirror row) moves with it — the database trigger does NOT follow an account change.
 *
 * What it never changes: who RECEIVES the invoice (payments.contact_id), the number,
 * the amounts, the status. It writes a dated line to the invoice's INTERNAL notes.
 * Rules (what is allowed) live in lib/invoices/bill-to-change.ts.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ensureBillingEntity } from "@/lib/offers/bill-to-server"
import { appendNote, billToChangeNote, decideBillToChange, type BillToPaymentRow } from "@/lib/invoices/bill-to-change"

export interface ChangeInvoiceBillToInput {
  paymentId: string
  /** Raw "Invoice to" value — see lib/offers/bill-to.ts parseBillTo. */
  billTo: unknown
  /** Text after the dash in the notes line, e.g. "by staff in Finance". */
  by: string
}

export interface ChangeInvoiceBillToResult {
  invoiceNumber: string | null
  from: string
  to: string
  /** False when the invoice was already billed to exactly this (nothing written). */
  changed: boolean
  accountChanged: boolean
  accountId: string | null
  billingEntityId: string | null
}

/** The person a payer hangs on: the invoice's own contact, else the company's owner. */
async function contactForPayer(row: { contact_id: string | null; account_id: string | null }): Promise<string | null> {
  if (row.contact_id) return row.contact_id
  if (!row.account_id) return null
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role")
    .eq("account_id", row.account_id)
    .is("access_revoked_at", null)
    .limit(10)
  const links = (data ?? []) as Array<{ contact_id: string; role: string | null }>
  return (links.find((l) => l.role?.toLowerCase().includes("owner")) ?? links[0])?.contact_id ?? null
}

/** A readable name for where an invoice is billed right now. */
async function billToLabel(p: { billing_entity_id: string | null; account_id: string | null; contact_id: string | null }): Promise<string> {
  if (p.billing_entity_id) {
    const { data } = await supabaseAdmin.from("billing_entities").select("entity_name").eq("id", p.billing_entity_id).maybeSingle()
    if (data?.entity_name) return data.entity_name
  }
  if (p.account_id) {
    const { data } = await supabaseAdmin.from("accounts").select("company_name").eq("id", p.account_id).maybeSingle()
    if (data?.company_name) return data.company_name
  }
  if (p.contact_id) {
    const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", p.contact_id).maybeSingle()
    if (data?.full_name) return data.full_name
  }
  return "—"
}

/** Throws an Error with a plain-English message when the change is not allowed or fails. */
export async function changeInvoiceBillTo(input: ChangeInvoiceBillToInput): Promise<ChangeInvoiceBillToResult> {
  const { data: pay, error: payErr } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, total, account_id, contact_id, billing_entity_id, payment_category, installment, notes, updated_at")
    .eq("id", input.paymentId)
    .maybeSingle()
  if (payErr) throw new Error(`Could not read the invoice: ${payErr.message}`)
  if (!pay) throw new Error("Invoice not found.")

  const { data: creditNoteRows, error: cnErr } = await supabaseAdmin
    .from("payments")
    .select("id")
    .eq("credit_for_payment_id", pay.id)
    .limit(1)
  if (cnErr) throw new Error(`Could not check credit notes: ${cnErr.message}`)
  const creditNotes = creditNoteRows?.length ?? 0

  const row: BillToPaymentRow = {
    invoice_status: pay.invoice_status,
    total: pay.total === null ? null : Number(pay.total),
    account_id: pay.account_id,
    contact_id: pay.contact_id,
    billing_entity_id: pay.billing_entity_id,
    payment_category: pay.payment_category,
    installment: pay.installment,
  }
  const decision = decideBillToChange(row, input.billTo, { creditNotesReferencing: creditNotes })
  // `in` narrows reliably here (the project's TypeScript is not in strict mode).
  if ("error" in decision) throw new Error(decision.error)
  const { plan } = decision

  // Resolve the payer row / company the plan points at.
  let newEntityId: string | null = null
  if (plan.entity.kind === "saved" || plan.entity.kind === "typed") {
    const personId = await contactForPayer(row)
    if (!personId) throw new Error("This invoice has no person or company owner to attach a payer to.")
    if (plan.entity.kind === "saved") {
      const { data: be } = await supabaseAdmin.from("billing_entities").select("id, contact_id").eq("id", plan.entity.id).maybeSingle()
      if (!be || be.contact_id !== personId) throw new Error("That payer does not belong to this invoice's person. Pick one of their saved payers or type a new one.")
      newEntityId = be.id
    } else {
      newEntityId = await ensureBillingEntity(personId, plan.entity.details)
    }
  }
  if (plan.account_id && plan.account_id !== pay.account_id) {
    const { data: acc } = await supabaseAdmin.from("accounts").select("id").eq("id", plan.account_id).maybeSingle()
    if (!acc) throw new Error("That company was not found in the CRM.")
  }

  const from = await billToLabel(row)
  const to = await billToLabel({
    billing_entity_id: newEntityId,
    account_id: plan.account_id,
    contact_id: pay.contact_id,
  })
  const result: ChangeInvoiceBillToResult = {
    invoiceNumber: pay.invoice_number,
    from,
    to,
    changed: true,
    accountChanged: plan.accountChanged,
    accountId: plan.account_id,
    billingEntityId: newEntityId,
  }

  if (plan.account_id === pay.account_id && newEntityId === pay.billing_entity_id) {
    return { ...result, changed: false }
  }

  const now = new Date().toISOString()
  const notes = appendNote(pay.notes, billToChangeNote({ date: now.slice(0, 10), from, to, by: input.by }))
  let update = supabaseAdmin
    .from("payments")
    .update({ account_id: plan.account_id, billing_entity_id: newEntityId, notes, updated_at: now })
    .eq("id", pay.id)
  // Compare-and-swap: refuse if somebody else changed the invoice since we read it.
  update = pay.updated_at ? update.eq("updated_at", pay.updated_at) : update.is("updated_at", null)
  const { data: written, error: wErr } = await update.select("id")
  if (wErr) throw new Error(`Could not save the change: ${wErr.message}`)
  if (!written || written.length === 0) throw new Error("The invoice was changed by someone else a moment ago. Reload and try again.")

  if (plan.accountChanged) {
    // The client's own copy of this invoice must follow the company, or the invoice would stay
    // in the old company's portal. If this fails, put the invoice back — never leave them apart.
    const { error: mErr } = await supabaseAdmin
      .from("client_expenses")
      .update({ account_id: plan.account_id })
      .eq("td_payment_id", pay.id)
      .eq("source", "td_invoice")
    if (mErr) {
      await supabaseAdmin
        .from("payments")
        .update({ account_id: pay.account_id, billing_entity_id: pay.billing_entity_id, notes: pay.notes, updated_at: new Date().toISOString() })
        .eq("id", pay.id)
      throw new Error(`Could not move the client's copy of the invoice, so nothing was changed: ${mErr.message}`)
    }
  }
  return result
}
