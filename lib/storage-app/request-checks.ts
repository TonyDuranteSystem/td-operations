/**
 * Checks for the COOKIE routes under /api/store-devices (approve, revoke): the browser sends the login cookie by itself, so the request must
 * also prove it came from our own page (same origin, JSON body) — a link or form on another site cannot forge it.
 */
export function isSameOriginJson(headers: { get(name: string): string | null }, requestHost: string): boolean {
  const ct = (headers.get("content-type") ?? "").toLowerCase()
  if (!ct.startsWith("application/json")) return false
  const origin = headers.get("origin")
  if (!origin) return headers.get("sec-fetch-site") === "same-origin"       // some same-origin fetches send no Origin; they do send this
  try { return new URL(origin).host === requestHost } catch { return false }
}

/** The CRM lets a remembered browser through its two-step check at the lower level. Approving a Mac asks for the real thing. */
export function needsFreshSecondStep(p: { hasVerifiedFactor: boolean; aal: string | null | undefined }): boolean {
  return p.hasVerifiedFactor && p.aal !== "aal2"
}
