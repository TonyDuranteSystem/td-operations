/**
 * The team's two buttons on the company page: "Take away access" and "Give access" (dev job beb43385, delivery C).
 *
 * Both only touch the "no portal access" mark on the person's link to the company (account_contacts.access_revoked_at /
 * access_revoked_by). Membership is never touched: the person stays a member and an owner on every document, and a login
 * they already have, and their other companies, stay exactly as they are — the mark hides the COMPANY, never the login.
 *
 *   Take away — puts the mark on, with the team member's id in access_revoked_by (so the wizard form never lifts it).
 *               Refused when this person is the last one who still has access: somebody must be able to open the company.
 *   Give      — takes the mark off (whoever put it there). Then, if the person has no login yet:
 *                 · company still being formed → nothing more; the welcome package makes the login once the EIN is in
 *                 · otherwise → creates the login and sends the welcome email with the temporary password
 *
 * After either, the person's portal tier is recomputed (a company they cannot open no longer counts for their tier).
 * The core takes its database and mail helpers as `deps`, so the rules are unit-tested without a database.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { localeFromLanguage } from '@/lib/locale'
import { PORTAL_TIERS, type PortalTier } from '@/lib/portal/tier-config'

export interface StaffAccessLink {
  contact_id: string
  access_revoked_at: string | null
}

export interface StaffAccessDeps {
  listLinks: (accountId: string) => Promise<StaffAccessLink[]>
  /** Sets (at/by given) or clears (both null) the mark. `onlyIfOpen` / `onlyIfMarked` guard against a double click or a race. */
  setMark: (p: { accountId: string; contactId: string; at: string | null; by: string | null }) => Promise<{ error?: string }>
  /** The person is this company's primary contact (members.is_primary, or the link's is_primary). */
  isPrimary: (accountId: string, contactId: string) => Promise<boolean>
  accountTier: (accountId: string) => Promise<string | null>
  contactInfo: (contactId: string) => Promise<{ fullName: string | null; email: string | null; language: string | null } | null>
  hasLogin: (email: string) => Promise<boolean>
  createLogin: (p: { accountId: string; contactId: string; tier: PortalTier }) => Promise<{ success: boolean; tempPassword?: string; error?: string }>
  sendWelcome: (p: { email: string; fullName: string; tempPassword: string; language: string }) => Promise<{ success: boolean; error?: string }>
  resyncTier: (accountId: string, reason: string) => Promise<void>
}

export interface StaffAccessResult {
  success: boolean
  /** Plain-English line for the toast. */
  message: string
  error?: string
  /** Give only: what happened about the login. */
  login?: 'already_had' | 'created_and_emailed' | 'created_email_failed' | 'after_ein' | 'no_email' | 'needs_admin' | 'failed'
}

export function realStaffAccessDeps(): StaffAccessDeps {
  return {
    listLinks: async (accountId) => {
      // portal-access-ok: staff roster of every link, marked or not
      const { data } = await supabaseAdmin.from('account_contacts').select('contact_id, access_revoked_at').eq('account_id', accountId)
      return (data ?? []) as StaffAccessLink[]
    },
    setMark: async ({ accountId, contactId, at, by }) => {
      // portal-access-ok: write
      const base = supabaseAdmin.from('account_contacts')
      if (at) {
        const { error } = await base
          .update({ access_revoked_at: at, access_revoked_by: by })
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .is('access_revoked_at', null)
        return error ? { error: error.message } : {}
      }
      const { error } = await base
        .update({ access_revoked_at: null, access_revoked_by: null })
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .not('access_revoked_at', 'is', null)
      return error ? { error: error.message } : {}
    },
    isPrimary: async (accountId, contactId) => {
      const [{ data: m }, { data: l }] = await Promise.all([
        supabaseAdmin.from('members').select('is_primary').eq('account_id', accountId).eq('contact_id', contactId).eq('is_primary', true).limit(1),
        // portal-access-ok: asks about one named link
        supabaseAdmin.from('account_contacts').select('is_primary').eq('account_id', accountId).eq('contact_id', contactId).eq('is_primary', true).limit(1),
      ])
      return (m ?? []).length > 0 || (l ?? []).length > 0
    },
    accountTier: async (accountId) => {
      const { data } = await supabaseAdmin.from('accounts').select('portal_tier').eq('id', accountId).maybeSingle()
      return (data?.portal_tier as string | null) ?? null
    },
    contactInfo: async (contactId) => {
      const { data } = await supabaseAdmin.from('contacts').select('full_name, email, language').eq('id', contactId).maybeSingle()
      return data ? { fullName: data.full_name ?? null, email: data.email ?? null, language: data.language ?? null } : null
    },
    hasLogin: async (email) => Boolean(await findAuthUserByEmail(email)),
    createLogin: async (p) => {
      const { autoCreatePortalUser } = await import('@/lib/portal/auto-create')
      const r = await autoCreatePortalUser({ accountId: p.accountId, contactId: p.contactId, tier: p.tier, autoCreated: false })
      return { success: r.success, tempPassword: r.tempPassword, error: r.error }
    },
    sendWelcome: async (p) => {
      const { sendPortalWelcomeEmail } = await import('@/lib/portal/auto-create')
      return sendPortalWelcomeEmail(p)
    },
    resyncTier: async (accountId, reason) => {
      const { data } = await supabaseAdmin.from('accounts').select('portal_tier').eq('id', accountId).maybeSingle()
      const tier = data?.portal_tier as string | null | undefined
      if (!tier || !PORTAL_TIERS.includes(tier as PortalTier)) return // a lifecycle marker (inactive / suspended): nothing to recompute
      const { syncTier } = await import('@/lib/operations/sync-tier')
      await syncTier({ accountId, newTier: tier as PortalTier, reason, actor: 'dashboard:staff-portal-access' })
    },
  }
}

export async function takeAwayPortalAccess(
  p: { accountId: string; contactId: string; staffUserId: string; now?: string },
  deps: StaffAccessDeps = realStaffAccessDeps(),
): Promise<StaffAccessResult> {
  const links = await deps.listLinks(p.accountId)
  const link = links.find((l) => l.contact_id === p.contactId)
  if (!link) return { success: false, message: 'This person is not linked to the company.', error: 'not_linked' }
  if (link.access_revoked_at) return { success: true, message: 'This person already has no portal access to the company.' }

  const stillOpen = links.filter((l) => !l.access_revoked_at)
  if (stillOpen.length <= 1) {
    return {
      success: false,
      message: 'Someone must keep portal access to this company, so the last person cannot be taken away.',
      error: 'last_person',
    }
  }

  // The primary contact is who the business writes to; a company must never lose its main person from the portal.
  if (await deps.isPrimary(p.accountId, p.contactId)) {
    return {
      success: false,
      message: "This is the company's primary contact, so their portal access cannot be taken away. Change the primary contact first.",
      error: 'primary',
    }
  }

  const r = await deps.setMark({ accountId: p.accountId, contactId: p.contactId, at: p.now ?? new Date().toISOString(), by: p.staffUserId })
  if (r.error) return { success: false, message: 'Could not take the access away.', error: r.error }
  await deps.resyncTier(p.accountId, 'portal access taken away for one member')
  return { success: true, message: 'Portal access taken away. They stay an owner; their login and other companies are untouched.' }
}

export async function givePortalAccess(
  p: {
    accountId: string
    contactId: string
    /** Only an admin may create a login and send a temporary password (same rule as the Create Portal Account route). Default true. */
    canCreateLogin?: boolean
  },
  deps: StaffAccessDeps = realStaffAccessDeps(),
): Promise<StaffAccessResult> {
  const links = await deps.listLinks(p.accountId)
  const link = links.find((l) => l.contact_id === p.contactId)
  if (!link) return { success: false, message: 'This person is not linked to the company.', error: 'not_linked' }
  if (!link.access_revoked_at) return { success: true, message: 'This person already has portal access to the company.', login: undefined }

  const r = await deps.setMark({ accountId: p.accountId, contactId: p.contactId, at: null, by: null })
  if (r.error) return { success: false, message: 'Could not give the access.', error: r.error }

  const info = await deps.contactInfo(p.contactId)
  let result: StaffAccessResult
  if (!info?.email) {
    result = { success: true, message: 'Access given. This person has no email on file, so no login could be created yet.', login: 'no_email' }
  } else if (await deps.hasLogin(info.email)) {
    result = { success: true, message: 'Access given. They already have a portal login and will now see this company.', login: 'already_had' }
  } else {
    const tier = await deps.accountTier(p.accountId)
    if (tier === 'formation') {
      result = { success: true, message: 'Access given. Their login is made automatically once the EIN is in.', login: 'after_ein' }
    } else if (p.canCreateLogin === false) {
      result = { success: true, message: 'Access given. They have no portal login yet — an admin needs to create it (their Contact page, Portal tab).', login: 'needs_admin' }
    } else {
      const createTier = (PORTAL_TIERS.includes(tier as PortalTier) ? tier : 'active') as PortalTier
      const created = await deps.createLogin({ accountId: p.accountId, contactId: p.contactId, tier: createTier })
      if (!created.success) {
        result = { success: true, message: `Access given, but the login could not be created: ${created.error ?? 'unknown error'}.`, login: 'failed' }
      } else if (!created.tempPassword) {
        result = { success: true, message: 'Access given. They already have a portal login.', login: 'already_had' }
      } else {
        const mail = await deps.sendWelcome({
          email: info.email,
          fullName: info.fullName || info.email,
          tempPassword: created.tempPassword,
          language: localeFromLanguage(info.language),
        })
        result = mail.success
          ? { success: true, message: 'Access given. A portal login was created and the welcome email was sent.', login: 'created_and_emailed' }
          : { success: true, message: `Access given and the login was created, but the welcome email failed: ${mail.error ?? 'unknown error'}.`, login: 'created_email_failed' }
      }
    }
  }
  await deps.resyncTier(p.accountId, 'portal access given back to one member')
  return result
}
