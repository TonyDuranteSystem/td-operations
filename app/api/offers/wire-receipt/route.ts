import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { isOwnWireReceiptPath } from '@/lib/offers/public-signing'
import { verifyStoredUpload } from '@/lib/offers/sign-deps'
import { MAX_WIRE_RECEIPT_BYTES } from '@/lib/offers/upload-sniff'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/wire-receipt — record the wire-transfer receipt the client just
 * uploaded through a one-time link (N0, dev job f907220c).
 *
 * Body: { token, code | pass, path } — `path` must be one /api/offers/upload-url issued
 * for this offer, the object must exist and really be a PDF or an image (checked by its
 * first bytes; anything else is deleted). Then contracts.wire_receipt_path is set, as
 * the pages used to do from the browser.
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, { ...r, preview: false })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

  const token = access.kind === 'offer' ? String(access.offer.token) : String(access.agreement.token)
  const path = r.body.path
  if (!isOwnWireReceiptPath(token, path)) {
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 400 })
  }
  const ok = await verifyStoredUpload('wire-receipts', path, ['pdf', 'png', 'jpeg', 'gif', 'webp', 'heic'], MAX_WIRE_RECEIPT_BYTES)
  if (!ok) {
    return NextResponse.json(
      { error: 'This file could not be accepted. Please upload the receipt as a PDF or an image (max 25 MB).' },
      { status: 400 },
    )
  }
  const { error } = await supabaseAdmin
    .from('contracts')
    .update({ wire_receipt_path: path })
    .eq('offer_token', token)
  if (error) return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
