/**
 * Signed passes for the ANNUAL RENEWAL agreement page (N0, dev job f907220c).
 *
 * Renewal agreements have no access code — the portal is the only way in: the
 * logged-in client opens /portal/sign/msa, which frames the public contract page.
 * Until N0 that framed page read and wrote `annual_agreements` with the public key
 * and the bare token (guessable: renewal-<slug>-<year>). Now:
 *
 *   1. The portal page, AFTER it has resolved the logged-in client and confirmed
 *      the agreement is theirs, mints a 'portal' pass (2 minutes — it rides in the
 *      iframe URL and lands in access logs, so it is a throwaway handoff).
 *   2. The contract page's first server call exchanges it for a 'grant' (4 hours,
 *      held only in page memory) so a client who takes their time to read and sign
 *      is not bounced by the 2-minute handoff.
 *
 * Every pass BINDS the agreement id — the routes resolve the agreement by token and
 * must check `pass.agreementId === agreement.id`, or a pass for one client's
 * agreement would replay on another's token. Same crypto stack as the OA portal pass
 * and View-as (lib/crypto/signed-token.ts); `purpose` keeps these tokens from ever
 * being accepted in place of one of those.
 */

import { signSignedTokenWithTtl, verifySignedToken } from '@/lib/crypto/signed-token'

export const RENEWAL_PORTAL_PASS_TTL_MS = 2 * 60 * 1000
export const RENEWAL_GRANT_TTL_MS = 4 * 60 * 60 * 1000

export type RenewalPassKind = 'portal' | 'grant'

export interface RenewalPassPayload {
  purpose: 'renewal_agreement'
  agreementId: string
  kind: RenewalPassKind
  exp: number
}

function getSecret(): string {
  const secret = process.env.API_SECRET_TOKEN?.trim()
  if (!secret) throw new Error('RENEWAL_PASS: API_SECRET_TOKEN is not configured')
  return secret
}

export async function signRenewalPass(
  data: { agreementId: string; kind: RenewalPassKind },
  now: number = Date.now(),
): Promise<string> {
  const ttl = data.kind === 'portal' ? RENEWAL_PORTAL_PASS_TTL_MS : RENEWAL_GRANT_TTL_MS
  return signSignedTokenWithTtl(
    getSecret(),
    { purpose: 'renewal_agreement', agreementId: data.agreementId, kind: data.kind },
    ttl,
    now,
  )
}

/** Payload when valid, unexpired and bound to THIS agreement; otherwise null. Never throws. */
export async function verifyRenewalPass(
  token: string | undefined | null,
  expectedAgreementId: string,
  now: number = Date.now(),
): Promise<RenewalPassPayload | null> {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return null
  }
  const payload = await verifySignedToken(secret, token, { now, requireExp: true })
  if (
    !payload ||
    payload.purpose !== 'renewal_agreement' ||
    typeof payload.agreementId !== 'string' ||
    (payload.kind !== 'portal' && payload.kind !== 'grant') ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  if (payload.agreementId !== expectedAgreementId) return null
  return payload as unknown as RenewalPassPayload
}
