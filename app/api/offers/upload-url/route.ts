import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { signKindFor, signedPdfPathFor, wireReceiptPathFor } from '@/lib/offers/public-signing'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/upload-url — a one-time upload link for the signed contract PDF or
 * the wire-transfer receipt (N0, dev job f907220c).
 *
 * Body: { token, code | pass, purpose: 'signed_pdf' | 'wire_receipt', file_name? }
 * Returns { signedUrl, path } — the browser PUTs the file straight to storage (so a
 * large PDF or a phone photo of a receipt never hits the ~4.5 MB server request
 * limit) and then reports `path` to the sign / receipt route, which checks the path is
 * one this route issued for this offer and that the object really exists.
 *
 * The SERVER chooses the path (always under the offer's own folder); the browser no
 * longer writes to either bucket with the public key.
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { offerColumns: 'id, token, access_code, status, contract_type', clientAction: true })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

  const token = access.kind === 'offer' ? String(access.offer.token) : String(access.agreement.token)
  const purpose = r.body.purpose
  let bucket: string
  let path: string | null
  if (purpose === 'signed_pdf') {
    bucket = 'signed-contracts'
    path = signedPdfPathFor(token, access.kind === 'renewal' ? 'renewal' : signKindFor(access.offer.contract_type))
  } else if (purpose === 'wire_receipt') {
    if (access.kind === 'offer' && access.offer.status !== 'signed' && access.offer.status !== 'completed') {
      return NextResponse.json({ error: 'Please sign the contract first.' }, { status: 409 })
    }
    bucket = 'wire-receipts'
    path = wireReceiptPathFor(token, r.body.file_name)
    if (!path) return NextResponse.json({ error: 'Please upload a PDF or an image (JPG, PNG, HEIC).' }, { status: 400 })
  } else {
    return NextResponse.json({ error: 'Unknown upload.' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(path)
  if (error || !data) {
    console.error('[offers/upload-url] could not create upload URL:', error?.message)
    return NextResponse.json({ error: 'Could not prepare the upload. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ signedUrl: data.signedUrl, path })
}
