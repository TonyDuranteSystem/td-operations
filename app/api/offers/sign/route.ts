import { NextRequest, NextResponse } from 'next/server'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { resolvePublicOfferAccess } from '@/lib/offers/public-offer-access'
import { signPublicOffer, signRenewalAgreement } from '@/lib/offers/sign-public-offer'
import { realSignDeps } from '@/lib/offers/sign-deps'

export const dynamic = 'force-dynamic'
// The in-process follow-up (activation, invoice, PDF archive) can take a while.
export const maxDuration = 60

/**
 * POST /api/offers/sign — sign an offer or an annual renewal agreement ON THE SERVER
 * (N0, dev job f907220c). Replaces the four signing components' browser-side writes
 * (contracts insert, status flip, webhook call with a shipped secret).
 *
 * Body: { token, code | pass, pdf_path, fields }
 *   pdf_path — the path /api/offers/upload-url issued; the PDF must already be uploaded
 *   fields   — the client's typed details for the contracts row (whitelisted per kind)
 *
 * A staff preview on its own can never sign — only the client's access code / renewal pass
 * can (clientAction). Errors carry a short machine code ('document_upload',
 * 'record', 'status') for the pages' existing client-facing signing messages, or a
 * sentence the page shows as-is. A retry after a lost response returns the same
 * success (see lib/offers/sign-public-offer.ts).
 */
export async function POST(req: NextRequest) {
  const r = await readOfferRequest(req)
  const access = await resolvePublicOfferAccess(req, r, { clientAction: true })
  if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

  const fields = r.body.fields && typeof r.body.fields === 'object' ? (r.body.fields as Record<string, unknown>) : {}
  const result = access.kind === 'renewal'
    ? await signRenewalAgreement({ agreement: access.agreement, fields, pdfPath: r.body.pdf_path }, realSignDeps)
    : await signPublicOffer({ offer: access.offer, fields, pdfPath: r.body.pdf_path }, realSignDeps)

  if (result.error) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({
    ok: true,
    alreadySigned: result.alreadySigned,
    bankAmount: result.bankAmount,
    planRefusal: result.planRefusal,
    invoiceNumber: result.invoiceNumber,
  })
}
