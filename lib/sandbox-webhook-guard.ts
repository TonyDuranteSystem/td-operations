/**
 * Sandbox guard for inbound webhooks (middleware, SANDBOX_MODE=1): outside
 * providers must not mutate sandbox data, so every /api/webhooks/* call is
 * refused — EXCEPT offer-signed, which is our own signing step (called by the
 * offer page, protected by the internal secret). Without it a client signing
 * on sandbox never got the signing invoice or activation (Antonio 2026-09-27).
 * Its outside effects (Drive, email) are already blocked by SANDBOX_MODE in
 * their own helpers.
 */
const SANDBOX_ALLOWED_WEBHOOKS = new Set(["/api/webhooks/offer-signed"])

export function isSandboxBlockedWebhook(pathname: string): boolean {
  if (!pathname.startsWith("/api/webhooks")) return false
  const clean = pathname.replace(/\/+$/, "")
  return !SANDBOX_ALLOWED_WEBHOOKS.has(clean)
}
