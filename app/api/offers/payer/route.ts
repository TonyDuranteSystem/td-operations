import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { sanitizeClientPayer } from '@/lib/offers/client-payer'
import { resolveInvoiceTarget } from '@/lib/offers/bill-to'
import { CLIENT_NAMED_BY, lastBillToChangeWasByStaff } from '@/lib/invoices/bill-to-change'
import { changeInvoiceBillTo } from '@/lib/operations/invoice-bill-to'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/payer — "someone else is paying" on the client's payment page
 * (dev job e62bc2b6, Antonio 2026-11-21).
 *
 * Body: { token, code, action: 'get' | 'set', payer?: { name, address?, country?, vat_number? } }
 *
 * The client can only TYPE a payer (a company or a person): name, address, country, VAT.
 * They can never pick one of our companies — linking a typed name to a CRM company is
 * staff-only (Finance → Bill to). Allowed only on a SIGNED offer and only until the
 * invoice is paid. It changes the name printed as Bill To; the invoice email still goes to
 * the person who signed.
 *
 * The offer's own "Invoice to" is updated too, so later parts of a payment plan carry the same
 * payer — BUT ONLY when the invoice sits on the person (no company). On a company's invoice the
 * later parts must follow part 1 (same company, same payer); writing a payer into the offer
 * would send them to the person instead (bug-hunter pass, job e62bc2b6, 2026-11-22).
 * (Only when the offer has NO explicit "Invoice to": later parts then follow part 1. If staff set an explicit "Invoice to" on the
 * offer, later parts follow THAT, whatever payer the client names on part 1 — a known, deliberate limit, see lib/plan-invoices/raise.ts.)
 * Once STAFF have changed the Bill to in Finance, this box is closed for that invoice (the client is sent to the chat).
 * A database read that fails is an error, never an empty answer: the client must not be told
 * "Saved" when it was not.
 */

const OPEN_STATUSES = new Set(['Draft', 'Sent', 'Overdue', 'Partial'])

/** A failed database read: log the real reason, answer plainly, never pretend it worked. */
function failed(what: string, reason: string) {
  console.error(`[offers/payer] could not ${what}:`, reason)
  return NextResponse.json({ error: 'We could not load this right now. Please try again in a moment, or tell us in the portal chat who is paying.' }, { status: 500 })
}

export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { clientAction: true })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
  if (access.kind !== 'offer') {
    return NextResponse.json({ error: 'This is not available here. Please tell us in the portal chat who is paying.' }, { status: 400 })
  }
  const token = String(access.offer.token)

  // The offer's invoice of record (created at signing) and who it is billed to now.
  const { data: act, error: actErr } = await supabaseAdmin
    .from('pending_activations')
    .select('portal_invoice_id')
    .eq('offer_token', token)
    .maybeSingle()
  if (actErr) return failed('read the offer', actErr.message)
  const invoiceId = act?.portal_invoice_id ?? null
  let invoice: { id: string; invoice_status: string | null; billing_entity_id: string | null; account_id: string | null; notes: string | null } | null = null
  if (invoiceId) {
    const { data, error } = await supabaseAdmin.from('payments').select('id, invoice_status, billing_entity_id, account_id, notes').eq('id', invoiceId).maybeSingle()
    if (error) return failed('read the invoice', error.message)
    invoice = data ?? null
  }
  const paid = invoice ? !OPEN_STATUSES.has(invoice.invoice_status ?? '') : false
  // Once STAFF have set who is billed (Finance → Bill to), the client's box must not undo it: the last Bill to change in the
  // invoice's notes was made by staff. The client is told to use the chat instead (bug-hunter follow-up, job e62bc2b6).
  const lockedByStaff = invoice ? lastBillToChangeWasByStaff(invoice.notes) : false

  if (r.body.action === 'get') {
    let payer: { name: string; address: string | null; country: string | null; vat_number: string | null } | null = null
    if (invoice?.billing_entity_id) {
      const { data: be, error: beErr } = await supabaseAdmin
        .from('billing_entities')
        .select('entity_name, billing_address, country, vat_number')
        .eq('id', invoice.billing_entity_id)
        .maybeSingle()
      if (beErr) return failed('read the payer', beErr.message)
      if (be) payer = { name: be.entity_name, address: be.billing_address, country: be.country, vat_number: be.vat_number }
    }
    return NextResponse.json({ ok: true, available: access.offer.status === 'signed', editable: !paid && !lockedByStaff, payer })
  }

  if (r.body.action !== 'set') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  if (access.offer.status !== 'signed') {
    return NextResponse.json({ error: 'Please sign the contract first.' }, { status: 409 })
  }
  if (paid) {
    return NextResponse.json(
      { error: 'This invoice is already paid, so it can no longer be changed here. Please tell us in the portal chat and we will update it.' },
      { status: 409 },
    )
  }
  if (lockedByStaff) {
    return NextResponse.json(
      { error: 'We have already set who this invoice is billed to, so it can no longer be changed here. Please tell us in the portal chat and we will update it.' },
      { status: 409 },
    )
  }
  const clean = sanitizeClientPayer(r.body.payer)
  if ('error' in clean) return NextResponse.json({ error: clean.error }, { status: 400 })

  try {
    if (invoice) {
      await changeInvoiceBillTo({
        paymentId: invoice.id,
        billTo: { type: 'entity', entity: clean.details },
        by: CLIENT_NAMED_BY,
      })
    }
    // Later parts of a payment plan follow the same payer (the offer's own "Invoice to") — only while the invoice sits on the person.
    // On a company's invoice they follow part 1 as it is (same company, same payer), so the offer's "Invoice to" is left alone.
    const sitsOnCompany = invoice
      ? invoice.account_id !== null
      : resolveInvoiceTarget({ billTo: access.offer.bill_to ?? null, offerAccountId: access.offer.account_id ?? null, contactId: access.offer.contact_id ?? null }).account_id !== null
    if (!sitsOnCompany) {
      const { error: offerErr } = await supabaseAdmin
        .from('offers')
        .update({ bill_to: { type: 'entity', entity: clean.details } } as never)
        .eq('token', token)
      if (offerErr) throw new Error('offer update failed')
    }
  } catch (e) {
    console.error('[offers/payer] could not save the payer:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'We could not save this right now. Please try again, or tell us in the portal chat who is paying.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
