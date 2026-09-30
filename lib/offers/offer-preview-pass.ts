/**
 * Staff preview of a client offer from the CRM (N0, dev job f907220c).
 *
 * The offer pages live on the client-facing host, where the staff CRM session cookie
 * does not exist — so "is this a staff member?" cannot be answered there. Before N0 the
 * `?preview=td` query flag was simply trusted in the browser. Now a CRM route (which DOES
 * see the staff session) mints this short-lived pass bound to ONE offer token and sends
 * staff to the offer with it. The offer routes accept it as proof of a staff preview:
 * no access-code prompt needed, and the view is NOT counted (so a staff look never flips
 * an offer to "viewed").
 *
 * Same crypto stack as the renewal/OA passes; `purpose` keeps it from being accepted
 * anywhere else.
 */

import { signSignedTokenWithTtl, verifySignedToken } from '@/lib/crypto/signed-token'

export const OFFER_PREVIEW_PASS_TTL_MS = 30 * 60 * 1000

function getSecret(): string {
  const secret = process.env.API_SECRET_TOKEN?.trim()
  if (!secret) throw new Error('OFFER_PREVIEW_PASS: API_SECRET_TOKEN is not configured')
  return secret
}

export async function signOfferPreviewPass(offerToken: string, staffUserId: string, now: number = Date.now()): Promise<string> {
  return signSignedTokenWithTtl(getSecret(), { purpose: 'offer_preview', token: offerToken, sub: staffUserId }, OFFER_PREVIEW_PASS_TTL_MS, now)
}

/** True only for an unexpired pass minted for THIS offer token. Never throws. */
export async function verifyOfferPreviewPass(pass: string | null | undefined, offerToken: string, now: number = Date.now()): Promise<boolean> {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return false
  }
  const payload = await verifySignedToken(secret, pass, { now, requireExp: true })
  return !!payload && payload.purpose === 'offer_preview' && payload.token === offerToken
}
