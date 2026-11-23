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
 * What it never changes: who RECEIVES the invoice, the number, the amounts, the status.
 * An invoice that has no person on it is emailed to its company's owner — so before such an
 * invoice moves to another company, that person is PINNED on the invoice (contact_id), or the
 * email would silently switch to the new company's owner. It writes a dated line to the
 * invoice's INTERNAL notes. Rules (what is allowed) live in lib/invoices/bill-to-change.ts.
 * Bug-hunter pass (job e62bc2b6, 2026-11-22): recipient pin, autopay refusal, is_test follows
 * the new company, and a checked roll-back. Follow-up (2026-11-23): an invoice with credit netted into it cannot change
 * company, the note's date is the New York date, and the person a payer hangs on is picked the same way every time.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ensureBillingEntity } from "@/lib/offers/bill-to-server"
import { appendNote, billToChangeNote, billToNoteDate, decideBillToChange, type BillToPaymentRow } from "@/lib/invoices/bill-to-change"
import { pickPayerPerson } from "@/lib/invoices/payer-person"
import { invoiceHasAppliedCredit } from "@/lib/invoices/applied-credit"

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
  /** Set when the invoice had no person: the person its email keeps going to (pinned on the invoice). */
  emailKeptWith: string | null
}

/**
 * The person a payer hangs on: the invoice's own contact, else the company's owner. The pick (lib/invoices/payer-person.ts) is
 * the same on every call and the same one the Bill to dialog uses, so the payers it lists are the payers this saves.
 */
async function contactForPayer(row: { contact_id: string | null; account_id: string | null }): Promise<string | null> {
  if (row.contact_id) return row.contact_id
  if (!row.account_id) return null
  const { data, error } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role, is_primary")
    .eq("account_id", row.account_id)
    .is("access_revoked_at", null)
  if (error) throw new Error(`Could not read the company's contacts: ${error.message}`)
  return pickPayerPerson((data ?? []) as Array<{ contact_id: string; role: string | null; is_primary: boolean | null }>)
}

/**
 * The person an invoice WITH NO PERSON is emailed to today — the SAME pick as
 * lib/portal/resolve-payment-recipient.ts (path 2): the owner-role contact that has an email,
 * else any linked contact with an email. Null when the company has none (then the email would
 * only be able to go to the company's general address, which cannot be kept across a move).
 */
async function recipientOfCompany(accountId: string): Promise<{ id: string; name: string | null } | null> {
  const { data: links, error } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role")
    .eq("account_id", accountId)
    .is("access_revoked_at", null)
    .limit(10)
  if (error) throw new Error(`Could not read the company's contacts: ${error.message}`)
  const rows = (links ?? []) as Array<{ contact_id: string; role: string | null }>
  if (rows.length === 0) return null
  const { data: people, error: pErr } = await supabaseAdmin.from("contacts").select("id, email, full_name").in("id", rows.map((r) => r.contact_id))
  if (pErr) throw new Error(`Could not read the company's contacts: ${pErr.message}`)
  const usable = new Map((people ?? []).filter((c) => c.email).map((c) => [c.id as string, (c.full_name as string | null) ?? null]))
  const ok = rows.filter((r) => usable.has(r.contact_id))
  const chosen = ok.find((l) => l.role?.toLowerCase().includes("owner")) ?? ok[0]
  return chosen ? { id: chosen.contact_id, name: usable.get(chosen.contact_id) ?? null } : null
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
    .select("id, invoice_number, invoice_status, total, account_id, contact_id, billing_entity_id, payment_category, installment, notes, is_test, updated_at")
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
  const creditApplied = await invoiceHasAppliedCredit(pay.id)

  const row: BillToPaymentRow = {
    invoice_status: pay.invoice_status,
    total: pay.total === null ? null : Number(pay.total),
    account_id: pay.account_id,
    contact_id: pay.contact_id,
    billing_entity_id: pay.billing_entity_id,
    payment_category: pay.payment_category,
    installment: pay.installment,
  }
  const decision = decideBillToChange(row, input.billTo, { creditNotesReferencing: creditNotes, creditAppliedToThis: creditApplied })
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

  // A move to another company (or to the person) changes more than the printed name — check each side effect first.
  let pinned: { id: string; name: string | null } | null = null
  let targetIsTest: boolean | null = null
  if (plan.accountChanged) {
    if (plan.account_id) {
      const { data: acc, error: accErr } = await supabaseAdmin
        .from("accounts")
        .select("id, is_test, autopay_card_enabled")
        .eq("id", plan.account_id)
        .maybeSingle()
      if (accErr) throw new Error(`Could not read that company: ${accErr.message}`)
      if (!acc) throw new Error("That company was not found in the CRM.")
      // The card-autopay cron picks Sent invoices by the company on the invoice: moving an unpaid one into a company with a saved
      // card on autopay could charge that card for an invoice that is not theirs.
      if (acc.autopay_card_enabled && pay.invoice_status !== "Paid") {
        throw new Error("That company has automatic card payment turned on, so an unpaid invoice moved into it could be charged to its saved card. Turn that off first, or choose a payer instead of the company.")
      }
      targetIsTest = Boolean(acc.is_test)
    } else if (pay.contact_id) {
      const { data: cont, error: cErr } = await supabaseAdmin.from("contacts").select("is_test").eq("id", pay.contact_id).maybeSingle()
      if (cErr) throw new Error(`Could not read the person: ${cErr.message}`)
      targetIsTest = Boolean(cont?.is_test)
    }
    // No person on the invoice: its email goes to the company's owner. Pin that person so the email does not switch to the new company's owner.
    if (plan.account_id && !pay.contact_id) {
      pinned = pay.account_id ? await recipientOfCompany(pay.account_id) : null
      if (!pinned) {
        throw new Error("This invoice has no person on it and its company has no contact with an email address to keep sending it to, so moving it would change who receives the email. Add the person to the invoice first.")
      }
    }
  }
  const isTestChanged = targetIsTest !== null && targetIsTest !== Boolean(pay.is_test)

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
    emailKeptWith: pinned ? (pinned.name ?? "the company's owner") : null,
  }

  if (plan.account_id === pay.account_id && newEntityId === pay.billing_entity_id) {
    return { ...result, changed: false }
  }

  const now = new Date().toISOString()
  const byText = pinned ? `${input.by}; the invoice email stays with ${pinned.name ?? "the company's owner"}` : input.by
  const notes = appendNote(pay.notes, billToChangeNote({ date: billToNoteDate(new Date(now)), from, to, by: byText }))
  const patch: Record<string, unknown> = { account_id: plan.account_id, billing_entity_id: newEntityId, notes, updated_at: now }
  if (pinned) patch.contact_id = pinned.id
  if (isTestChanged) patch.is_test = targetIsTest
  let update = supabaseAdmin.from("payments").update(patch).eq("id", pay.id)
  // Compare-and-swap: refuse if somebody else changed the invoice since we read it.
  update = pay.updated_at ? update.eq("updated_at", pay.updated_at) : update.is("updated_at", null)
  const { data: written, error: wErr } = await update.select("id, updated_at")
  if (wErr) throw new Error(`Could not save the change: ${wErr.message}`)
  if (!written || written.length === 0) throw new Error("The invoice was changed by someone else a moment ago. Reload and try again.")
  // PRODUCTION stamps updated_at itself on every update (trigger trg_payments_updated_at); the sandbox does not. So the value to
  // compare against when undoing is the one the database REPORTS back, never the one we sent.
  const wroteAt = (written[0] as { updated_at: string | null }).updated_at

  if (plan.accountChanged) {
    // The client's own copy of this invoice must follow the company, or the invoice would stay
    // in the old company's portal. If this fails, put the invoice back — never leave them apart.
    const mirrorPatch: Record<string, unknown> = { account_id: plan.account_id }
    if (isTestChanged) mirrorPatch.is_test = targetIsTest
    const { error: mErr } = await supabaseAdmin
      .from("client_expenses")
      .update(mirrorPatch)
      .eq("td_payment_id", pay.id)
      .eq("source", "td_invoice")
    if (mErr) {
      const back: Record<string, unknown> = { account_id: pay.account_id, billing_entity_id: pay.billing_entity_id, notes: pay.notes, contact_id: pay.contact_id, updated_at: new Date().toISOString() }
      if (isTestChanged) back.is_test = pay.is_test
      // Only undo OUR write (updated_at is still the value our write left) and CHECK that it worked.
      let undoQuery = supabaseAdmin.from("payments").update(back).eq("id", pay.id)
      undoQuery = wroteAt ? undoQuery.eq("updated_at", wroteAt) : undoQuery.is("updated_at", null)
      const { data: undone, error: undoErr } = await undoQuery.select("id")
      if (undoErr || !undone || undone.length === 0) {
        console.error(`[invoice-bill-to] ${pay.invoice_number}: client copy move failed (${mErr.message}) AND the roll-back failed (${undoErr?.message ?? "invoice changed meanwhile"})`)
        throw new Error(
          `Could not move the client's copy of ${pay.invoice_number ?? "the invoice"}, and putting the invoice back failed too: the invoice and the client's copy now sit on different companies. Do not change it again — tell the developer. (${mErr.message})`,
        )
      }
      throw new Error(`Could not move the client's copy of the invoice, so nothing was changed: ${mErr.message}`)
    }
  }
  return result
}
