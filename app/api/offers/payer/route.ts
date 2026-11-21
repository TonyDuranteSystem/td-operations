import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { sanitizeClientPayer } from '@/lib/offers/client-payer'
import { CLIENT_NAMED_BY } from '@/lib/invoices/bill-to-change'
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
 * the person who signed. The offer's own "Invoice to" is updated too, so later invoices of
 * the same offer carry the same payer.
 */

const OPEN_STATUSES = new Set(['Draft', 'Sent', 'Overdue', 'Partial'])

export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { clientAction: true })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
  if (access.kind !== 'offer') {
    return NextResponse.json({ error: 'This is not available here. Please tell us in the portal chat who is paying.' }, { status: 400 })
  }
  const token = String(access.offer.token)

  // The offer's invoice of record (created at signing) and who it is billed to now.
  const { data: act } = await supabaseAdmin
    .from('pending_activations')
    .select('portal_invoice_id')
    .eq('offer_token', token)
    .maybeSingle()
  const invoiceId = act?.portal_invoice_id ?? null
  let invoice: { id: string; invoice_status: string | null; billing_entity_id: string | null } | null = null
  if (invoiceId) {
    const { data } = await supabaseAdmin.from('payments').select('id, invoice_status, billing_entity_id').eq('id', invoiceId).maybeSingle()
    invoice = data ?? null
  }
  const paid = invoice ? !OPEN_STATUSES.has(invoice.invoice_status ?? '') : false

  if (r.body.action === 'get') {
    let payer: { name: string; address: string | null; country: string | null; vat_number: string | null } | null = null
    if (invoice?.billing_entity_id) {
      const { data: be } = await supabaseAdmin
        .from('billing_entities')
        .select('entity_name, billing_address, country, vat_number')
        .eq('id', invoice.billing_entity_id)
        .maybeSingle()
      if (be) payer = { name: be.entity_name, address: be.billing_address, country: be.country, vat_number: be.vat_number }
    }
    return NextResponse.json({ ok: true, available: access.offer.status === 'signed', editable: !paid, payer })
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
    // Later invoices of this offer follow the same payer (the offer's own "Invoice to").
    const { error: offerErr } = await supabaseAdmin
      .from('offers')
      .update({ bill_to: { type: 'entity', entity: clean.details } } as never)
      .eq('token', token)
    if (offerErr) throw new Error('offer update failed')
  } catch (e) {
    console.error('[offers/payer] could not save the payer:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'We could not save this right now. Please try again, or tell us in the portal chat who is paying.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
