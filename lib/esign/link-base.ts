/**
 * Choose the base URL for e-sign signing links.
 *
 * Production MUST use the stable public client domain (APP_BASE_URL =
 * app.tonydurante.us) — never the internal CRM host the request arrived on (R005).
 * On preview/sandbox there is no fixed domain carrying this code, so links use the
 * request origin to stay on the same deployment (so QA links actually open).
 *
 * Pure (isProduction passed in) so it's unit-testable.
 */
import { APP_BASE_URL } from "@/lib/config"

export function chooseLinkBase(requestOrigin: string | null | undefined, isProduction: boolean): string {
  if (isProduction) return APP_BASE_URL
  return requestOrigin || APP_BASE_URL
}

/** Build the origin string (proto + host) from forwarded headers, or null. */
export function originFromHeaders(get: (name: string) => string | null): string | null {
  const proto = get("x-forwarded-proto") || "https"
  const host = get("x-forwarded-host") || get("host")
  return host ? `${proto}://${host}` : null
}
