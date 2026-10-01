/**
 * What the public lease page should draw. Pure so the order of the checks is unit-tested.
 *
 * Bug fixed 2026-10-01 (found by the production end-to-end QA): the server answers a first-time visitor with
 * `{ requiresEmail: true }` and NO lease. The page used to bail out with `if (!lease) return null` BEFORE it
 * reached the email box, so anyone opening the bare lease link (outside the portal) saw a completely blank page. The email gate
 * must be decided first — it does not need the lease.
 */
export type LeasePageView = 'loading' | 'error' | 'email_gate' | 'empty' | 'lease'

export function leasePageView(s: {
  loading: boolean
  error: string
  hasLease: boolean
  verified: boolean
  isAdminPreview: boolean
  isPortal: boolean
}): LeasePageView {
  if (s.loading) return 'loading'
  if (s.error) return 'error'
  if (!s.verified && !s.isAdminPreview && !s.isPortal) return 'email_gate'
  if (!s.hasLease) return 'empty'
  return 'lease'
}
