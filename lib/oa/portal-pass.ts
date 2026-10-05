/**
 * Short-lived signed pass that lets the CONTACT-GATED portal wrapper prove to the
 * public OA fetch route "a logged-in member of this company is opening this
 * specific agreement" — so the wrapper's embedded iframe can skip the EMAIL gate
 * (only the email gate; the shared access code in the URL path is still required)
 * without the spoofable `?portal=true` flag.
 *
 * Two mint sites, both server-side and privileged:
 *   1. the portal OA sign page (app/portal/sign/oa/page.tsx) — after it has
 *      resolved the logged-in contact and confirmed the account is theirs.
 *   2. staff preview from the CRM — a preview pass, so the `?preview=td` links in
 *      support emails / the documents panel keep working on the client-facing
 *      host where the staff session cookie does not exist.
 *
 * ⛔ BINDS `oaId`. The fetch route resolves the agreement by TOKEN, so it MUST
 * check `pass.oaId === agreement.id`. Without that, a pass minted for company A's
 * agreement would replay on company B's token to skip B's email gate. `kind`
 * distinguishes a portal-member pass from a staff-preview pass (staff preview
 * additionally suppresses view-tracking, a member view counts).
 *
 * TTL is 2 minutes — this rides in the iframe src query string and therefore
 * lands in access logs, so it is a throwaway handoff, never a durable credential.
 * It only skips the email gate; it can never skip the access code or authorize a
 * signature.
 */

import { signSignedTokenWithTtl, verifySignedToken } from '@/lib/crypto/signed-token'

/** 2 minutes — matches the view-as single-use handoff window. */
export const OA_PASS_TTL_MS = 2 * 60 * 1000

export type OaPassKind = 'portal' | 'staff_preview'

export interface OaPassPayload {
  /** oa_agreements.id this pass is valid for — the fetch route MUST match it. */
  oaId: string
  /** 'portal' = a logged-in member; 'staff_preview' = CRM preview (also skips tracking). */
  kind: OaPassKind
  /** contacts.id of the opener (portal) or the staff user id (preview) — audit only. */
  sub?: string
  /** epoch ms after which the pass is invalid. */
  exp: number
}

function getSecret(): string {
  const secret = process.env.API_SECRET_TOKEN?.trim()
  if (!secret) throw new Error('OA_PASS: API_SECRET_TOKEN is not configured')
  return secret
}

/** Mint a pass bound to one agreement. `now` injectable for tests. */
export async function signOaPass(
  data: { oaId: string; kind: OaPassKind; sub?: string },
  now: number = Date.now(),
): Promise<string> {
  return signSignedTokenWithTtl(
    getSecret(),
    { oaId: data.oaId, kind: data.kind, ...(data.sub ? { sub: data.sub } : {}) },
    OA_PASS_TTL_MS,
    now,
  )
}

/**
 * Verify a pass and that it is for THIS agreement. Returns the payload or null.
 * Never throws. `expectedOaId` is the agreement the route resolved from the
 * token — a pass whose `oaId` differs is rejected (cross-agreement replay).
 */
export async function verifyOaPass(
  token: string | undefined | null,
  expectedOaId: string,
  now: number = Date.now(),
): Promise<OaPassPayload | null> {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return null
  }
  const payload = await verifySignedToken(secret, token, { now, requireExp: true })
  if (
    !payload ||
    typeof payload.oaId !== 'string' ||
    (payload.kind !== 'portal' && payload.kind !== 'staff_preview') ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  // The binding check — a pass for a different agreement never passes here.
  if (payload.oaId !== expectedOaId) return null
  return payload as unknown as OaPassPayload
}

// ─────────────────────────────────────────────────────────────── signed-PDF ticket
//
// The 2-minute pass above is a handoff for LOADING the page. A member can read the
// executed agreement for longer than that before pressing "Download Signed PDF", and
// by then the pass in the URL is dead — the download route would then ask for an
// e-mail the portal member never typed (the portal skips that gate), a dead end.
//
// So the data route, AFTER the visitor has passed every gate and only for a SIGNED
// agreement, hands the page a download TICKET: bound to this one agreement, good for
// 30 minutes, usable ONLY on the signed-PDF route, and carried in a request header
// (never the URL). It is a different `kind`, so `verifyOaPass` rejects it — it can
// never skip the e-mail gate on the data route or authorise anything else.

/** 30 minutes. */
export const OA_DOWNLOAD_TICKET_TTL_MS = 30 * 60 * 1000

const DOWNLOAD_KIND = 'signed_pdf_download'

export async function signOaDownloadTicket(oaId: string, now: number = Date.now()): Promise<string> {
  return signSignedTokenWithTtl(getSecret(), { oaId, kind: DOWNLOAD_KIND }, OA_DOWNLOAD_TICKET_TTL_MS, now)
}

/** True only for an unexpired ticket minted for THIS agreement. Never throws. */
export async function verifyOaDownloadTicket(
  token: string | undefined | null,
  expectedOaId: string,
  now: number = Date.now(),
): Promise<boolean> {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return false
  }
  const payload = await verifySignedToken(secret, token, { now, requireExp: true })
  return !!payload && payload.kind === DOWNLOAD_KIND && payload.oaId === expectedOaId && typeof payload.exp === 'number'
}
