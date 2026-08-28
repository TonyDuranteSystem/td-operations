/**
 * Opens the client-facing Operating Agreement page as staff.
 *
 * The client-facing host has no staff dashboard session, and the bare
 * `?preview=td` flag no longer skips the OA's email gate on its own (2026-08-11
 * security close — see docs/systems/lease-oa.md). So this mints a short-lived
 * signed pass HERE, on the CRM host where the staff session exists
 * (`/api/crm/oa-preview-pass`), and carries it on the link. Falls back to the
 * plain coded link if minting fails — staff can then enter the client email.
 *
 * Shared by the Documents-to-Sign panel's existing "View" button and the
 * Generate Operating Agreement dialog's "Preview OA" link, so both stay in sync.
 */
export async function openOaPreview(appBaseUrl: string, token: string, accessCode: string | null | undefined) {
  const previewBase = (() => {
    if (typeof window === "undefined") return appBaseUrl
    const host = window.location.hostname
    if (host.includes("sandbox") || host === "localhost" || host.startsWith("127.")) {
      return window.location.origin
    }
    return appBaseUrl
  })()
  const base = accessCode
    ? `${previewBase}/operating-agreement/${token}/${accessCode}?preview=td`
    : `${previewBase}/operating-agreement/${token}?preview=td`
  try {
    const res = await fetch(`/api/crm/oa-preview-pass?token=${encodeURIComponent(token)}`)
    const data = await res.json().catch(() => ({}))
    const url = res.ok && data.pass ? `${base}&pass=${encodeURIComponent(data.pass)}` : base
    window.open(url, "_blank", "noopener,noreferrer")
  } catch {
    window.open(base, "_blank", "noopener,noreferrer")
  }
}
