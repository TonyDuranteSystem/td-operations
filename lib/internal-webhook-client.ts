/**
 * Client-safe helper: the header our first-party signing pages attach when
 * POSTing the internal `offer-signed` / `agreement-signed` webhooks.
 *
 * The server side (`lib/webhook-internal-auth.ts`) verifies this header against
 * `INTERNAL_WEBHOOK_SECRET` and fails closed when it is unset. The browser value
 * comes from `NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET`, which must be set to the same
 * value on every deployment (security audit 2026-06-13, H4).
 *
 * This is intentionally a separate, dependency-free module so client bundles
 * don't pull in the server-side verifier.
 */

export const INTERNAL_WEBHOOK_HEADER = 'x-internal-webhook-secret'

/** Returns the secret header to merge into a webhook fetch (empty if unconfigured). */
export function internalWebhookHeaders(): Record<string, string> {
  const secret = process.env.NEXT_PUBLIC_INTERNAL_WEBHOOK_SECRET || ''
  return secret ? { [INTERNAL_WEBHOOK_HEADER]: secret } : {}
}
