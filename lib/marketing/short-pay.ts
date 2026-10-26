/**
 * TD Marketing — the short payment address (Rocco, 2026-10-26: "the Stripe link is endless, can we make it short?").
 * The short address is /pay/s/<12 characters> on the client-facing domain. The 12 characters are the first twelve hex digits of the sale's own id (48 bits, random,
 * never shown anywhere else), so nothing new is stored: the redirect finds the sale by the id range that starts with them, then sends the client to the same Stripe page
 * as before. It works only while that Stripe page does (about 23 hours), exactly like the long link. Pure; no database here.
 */
export const SHORT_CODE_LENGTH = 12

/** The code that stands for a sale id, or null when the id is not a uuid. */
export function shortCodeFor(saleId: string): string | null {
  const hex = saleId.replace(/-/g, "").toLowerCase()
  return /^[0-9a-f]{32}$/.test(hex) ? hex.slice(0, SHORT_CODE_LENGTH) : null
}

/** The smallest and the largest sale id that start with this code, or null when the code is not 12 hex digits. */
export function idRangeFor(code: string): { lo: string; hi: string } | null {
  const c = code.toLowerCase()
  if (!/^[0-9a-f]{12}$/.test(c)) return null
  const head = `${c.slice(0, 8)}-${c.slice(8, 12)}`
  return { lo: `${head}-0000-0000-000000000000`, hi: `${head}-ffff-ffff-ffffffffffff` }
}

/** The address to give the client: `base` is the client-facing domain (APP_BASE_URL), given by the server. */
export function shortPayUrl(base: string, saleId: string): string | null {
  const code = shortCodeFor(saleId)
  return code ? `${base.replace(/\/+$/, "")}/pay/s/${code}` : null
}
