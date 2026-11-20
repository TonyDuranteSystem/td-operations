/**
 * What the company page says about each person's portal access (dev job beb43385, delivery C).
 *
 * One person, one company, four possible answers:
 *   no_portal_access — the link carries the "no portal access" mark: the person is still an owner on every document,
 *                      but the company stays out of their portal (unticked in the form, or taken away by the team).
 *   login_active     — not marked, and the person already has a portal login.
 *   login_after_ein  — not marked, no login yet, and the company is still being formed: the login is made by the welcome
 *                      package once the EIN is in.
 *   no_login_yet     — not marked, no login yet, company already past formation (the team can make one).
 *
 * Pure, no I/O — the page gathers the inputs, this decides.
 */

export type PortalAccessChip = 'no_portal_access' | 'login_active' | 'login_after_ein' | 'no_login_yet'

export interface PortalAccessInputs {
  /** account_contacts.access_revoked_at is set for this person on this company. */
  marked: boolean
  /** The person has a portal login (any company). */
  hasLogin: boolean
  /** accounts.portal_tier of the company. */
  accountTier: string | null | undefined
}

export function portalAccessChip(i: PortalAccessInputs): PortalAccessChip {
  if (i.marked) return 'no_portal_access'
  if (i.hasLogin) return 'login_active'
  if (i.accountTier === 'formation') return 'login_after_ein'
  return 'no_login_yet'
}

export const PORTAL_ACCESS_CHIP_TEXT: Record<PortalAccessChip, { label: string; hint: string }> = {
  no_portal_access: {
    label: 'No portal access',
    hint: 'Still an owner on every document. This company is not shown in their portal and they are not told about it.',
  },
  login_active: {
    label: 'Portal login active',
    hint: 'Has a portal login and can open this company.',
  },
  login_after_ein: {
    label: 'Login after EIN',
    hint: 'Gets a portal login (and the welcome email) when the EIN is in and the welcome package runs.',
  },
  no_login_yet: {
    label: 'No login yet',
    hint: 'Can open this company as soon as they have a portal login. An admin creates it from their Contact page (Portal tab).',
  },
}

/**
 * The staff buttons. "Take away" is shown for a person who is not marked; "Give" for one who is.
 * A person who is the last one still holding access cannot be taken away (somebody must be able to open the company).
 */
export function staffAccessButtons(p: { marked: boolean; openLinkCount: number }): { takeAway: boolean; give: boolean; takeAwayBlockedReason: string | null } {
  if (p.marked) return { takeAway: false, give: true, takeAwayBlockedReason: null }
  if (p.openLinkCount <= 1) {
    return { takeAway: false, give: false, takeAwayBlockedReason: 'Someone must keep portal access to this company.' }
  }
  return { takeAway: true, give: false, takeAwayBlockedReason: null }
}
