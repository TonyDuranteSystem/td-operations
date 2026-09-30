/**
 * The credential fields every public /api/offers/* request carries, read one way.
 * `code` = the offer's access code; `pass` = a renewal portal pass or grant;
 * `preview` = the client ASKS for staff preview (only a real staff session grants it).
 */

import type { NextRequest } from 'next/server'

export interface OfferRequest {
  body: Record<string, unknown>
  token: string
  code: string
  pass: string
  preview: boolean
}

export async function readOfferRequest(req: NextRequest): Promise<OfferRequest> {
  const raw = await req.json().catch(() => ({}))
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    body,
    token: str(body.token).trim(),
    code: str(body.code),
    pass: str(body.pass),
    preview: body.preview === 'td' || body.preview === true,
  }
}
