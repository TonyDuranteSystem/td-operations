/**
 * Shared-secret check for INTERNAL webhooks that are triggered by our own
 * first-party pages (not by a third-party signing provider).
 *
 * `offer-signed` and `agreement-signed` are POSTed by our contract / renewal
 * client pages after a client signs. They sit on the public `/api/webhooks/*`
 * path (no session) and previously accepted ANY caller that knew a valid token,
 * so anyone who learned a token could POST to mint a real TD invoice / flip
 * agreement state (security audit 2026-06-13, H4).
 *
 * This adds a fail-CLOSED shared-secret gate, matching the Stripe/Whop/Slack
 * pattern: if `INTERNAL_WEBHOOK_SECRET` is unset we REJECT (we cannot prove the
 * caller), and when it is set we require a constant-time-matching
 * `x-internal-webhook-secret` header.
 *
 * ⚠️ DEPLOY COUPLING: because these webhooks are browser-triggered, the caller
 * must send the secret. The matching value is exposed to the first-party page
 * via `NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET`. This blocks blind/no-page direct
 * POSTs to the raw webhook (the "reachable without login" vector) but is NOT a
 * cryptographic proof of the signer — the complete fix is to move the signing
 * trigger fully server-side. BOTH env vars must be set on every deployment
 * BEFORE this gate goes live, or signing will fail closed.
 */

const HEADER = 'x-internal-webhook-secret'

/** Constant-time string compare (length-leaking but value-safe). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * @returns true when the request carries the valid internal secret.
 * Fail closed: returns false when `INTERNAL_WEBHOOK_SECRET` is unset.
 */
export function verifyInternalWebhookSecret(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET?.trim()
  if (!secret) {
    // No configured secret → cannot verify the caller → reject.
    console.error('[internal-webhook] INTERNAL_WEBHOOK_SECRET not set — rejecting (fail closed)')
    return false
  }
  const provided = (req.headers.get(HEADER) ?? '').trim()
  if (!provided) return false
  return timingSafeEqualStr(provided, secret)
}

export const INTERNAL_WEBHOOK_HEADER = HEADER

/**
 * Header a SERVER-side caller attaches to reach an internal-secret-gated webhook
 * (e.g. /api/oa-signed) from another server route. Uses the server-only
 * INTERNAL_WEBHOOK_SECRET (never the NEXT_PUBLIC one — this never runs in a
 * browser bundle). Returns {} when unset, so the call still goes out and the
 * receiver's own fail-closed check produces the (loud) 401 rather than throwing here.
 */
export function internalWebhookServerHeaders(): Record<string, string> {
  const secret = process.env.INTERNAL_WEBHOOK_SECRET?.trim()
  return secret ? { [HEADER]: secret } : {}
}
