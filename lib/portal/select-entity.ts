/**
 * Resolve which "entity" the portal is showing for a logged-in client.
 *
 * The portal is per-ENTITY, not per-person: a client can hold several real
 * companies (accounts, each with its own stage) AND in-progress formations
 * (paid, being formed, not yet a company — no account exists yet, by design).
 * This pure function turns the available entities + the two selection cookies
 * into one typed selection and its effective portal tier.
 *
 * Selection precedence:
 *  1. An explicit in-progress-formation selection (`formationCookie`, only ever
 *     set by the company switcher) — but only if that formation still exists.
 *  2. A real company: the account matching `accountCookie`, else the first.
 *  3. No account but a formation in progress → default to that formation.
 *  4. Nothing → fall back to the contact-level / auth tier (`fallbackTier`).
 *
 * Pure (no I/O) so it is exhaustively unit-tested; the layout/page do the I/O
 * and pass the data in.
 */
import type { PortalAccount } from '@/lib/types'
import type { InProgressFormation } from '@/lib/portal/queries'

export type SelectedEntity =
  | { kind: 'account'; accountId: string; tier: string; account: PortalAccount }
  | { kind: 'formation'; formationId: string; sdId: string; label: string; tier: 'formation' }
  | { kind: 'none'; tier: string }

export function resolveSelectedEntity(params: {
  accounts: PortalAccount[]
  inProgress: InProgressFormation[]
  accountCookie?: string | null
  formationCookie?: string | null
  /** Tier to use when the contact has neither an account nor an in-progress formation. */
  fallbackTier: string
}): SelectedEntity {
  const { accounts, inProgress, accountCookie, formationCookie, fallbackTier } = params

  // 1. Explicit in-progress-formation selection wins (only set via the switcher).
  if (formationCookie) {
    const f = inProgress.find(x => x.id === formationCookie)
    if (f) return { kind: 'formation', formationId: f.id, sdId: f.sdId, label: f.label, tier: 'formation' }
    // stale/invalid formation cookie → ignore, fall through to account/default
  }

  // 2. Real company selection (cookie match, else first account).
  if (accounts.length > 0) {
    const acct = accounts.find(a => a.id === accountCookie) ?? accounts[0]
    return { kind: 'account', accountId: acct.id, tier: acct.portal_tier ?? 'active', account: acct }
  }

  // 3. No account but a formation in progress → show it (contact-scoped).
  if (inProgress.length > 0) {
    const f = inProgress[0]
    return { kind: 'formation', formationId: f.id, sdId: f.sdId, label: f.label, tier: 'formation' }
  }

  // 4. Nothing yet → contact-level / auth tier.
  return { kind: 'none', tier: fallbackTier }
}
