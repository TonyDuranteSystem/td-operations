/**
 * The team's two buttons on the company page: "Take away access" and "Give access" (dev job beb43385, delivery C).
 *
 * Both only touch the "no portal access" mark on the person's link to the company (account_contacts.access_revoked_at /
 * access_revoked_by). Membership is never touched: the person stays a member and an owner on every document, and a login
 * they already have, and their other companies, stay exactly as they are — the mark hides the COMPANY, never the login.
 *
 *   Take away — puts the mark on, with the team member's id in access_revoked_by (so the wizard form never lifts it).
 *               Refused when this person is the last one who still has access, the company's primary contact, the person
 *               chosen to sign the SS-4 (until it is signed), or when nobody who would still have access can actually open
 *               the company (has a portal login — or is about to get one, for a company still being formed). The check is
 *               repeated right after the write: two clicks at the same moment cannot both pass (QA 21 Nov 2026).
 *               The person's phone-alert subscription is NOT deleted: a subscription row belongs to one browser of one login (one company
 *               stamp per row), so deleting it would silence their OTHER companies too. The company's alerts leave it out at send time
 *               instead (`sendPushToAccount` filters marked contacts).
 *   Give      — takes the mark off (whoever put it there) but KEEPS the team member's id in access_revoked_by, so a re-run of
 *               the form's job with the old answers never puts the mark back (QA 21 Nov 2026). Then, if the person has no login yet:
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
  /** The team member who last decided on this link (Take away or Give), if any. Put back as it was when a write is undone. */
  access_revoked_by?: string | null
}

export interface StaffAccessDeps {
  listLinks: (accountId: string) => Promise<StaffAccessLink[]>
  /** Sets (at/by given) or clears (both null) the mark. `onlyIfOpen` / `onlyIfMarked` guard against a double click or a race. */
  setMark: (p: { accountId: string; contactId: string; at: string | null; by: string | null }) => Promise<{ error?: string }>
  /** The person is this company's primary contact (members.is_primary, or the link's is_primary). */
  isPrimary: (accountId: string, contactId: string) => Promise<boolean>
  /** The person is the SS-4 Responsible Party and the SS-4 is not signed yet: they sign it in the portal, so they must keep access. */
  isSs4Signer: (accountId: string, contactId: string) => Promise<boolean>
  accountTier: (accountId: string) => Promise<string | null>
  contactInfo: (contactId: string) => Promise<{ fullName: string | null; email: string | null; language: string | null } | null>
  hasLogin: (email: string) => Promise<boolean>
  /** The person has a WORKING portal login that opens THEIR link to a company (see `loginOpensLink`). Throws when the logins cannot be read, so a guard never passes on a guess. */
  canSignIn: (email: string, contactId: string) => Promise<boolean>
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

/**
 * Does this login open THIS person's link? Yes when it exists, is not banned, and points at this contact (or at no contact at all).
 * No when it points at SOMEONE ELSE: co-members who share one email share one login, and that login opens the links of the contact it is
 * keyed to, not of the other member (Bug Hunter, QA 21 Nov 2026). Pure, so it can be tested without the auth system.
 */
export function loginOpensLink(user: { banned_until?: string | null; app_metadata?: Record<string, unknown> | null } | null | undefined, contactId: string): boolean {
  if (!user) return false
  if (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) return false
  const pointsAt = user.app_metadata?.contact_id
  return !pointsAt || pointsAt === contactId
}

export function realStaffAccessDeps(): StaffAccessDeps {
  return {
    listLinks: async (accountId) => {
      // portal-access-ok: staff roster of every link, marked or not
      const { data } = await supabaseAdmin.from('account_contacts').select('contact_id, access_revoked_at, access_revoked_by').eq('account_id', accountId)
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
      // Clearing the mark KEEPS the deciding team member's id (`by`): the link is then "decided by the team", and the form's job
      // never puts a mark on it again. `by` null clears both, as before.
      const { error } = await base
        .update({ access_revoked_at: null, access_revoked_by: by })
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
    isSs4Signer: async (accountId, contactId) => {
      // Any read error THROWS: a legal guard never passes on a guess (the server action shows the error).
      // An SS-4 that names this person and is not signed yet (draft or waiting for the signature) …
      const { data: open, error: openErr } = await supabaseAdmin.from('ss4_applications').select('id').eq('account_id', accountId).eq('contact_id', contactId).in('status', ['draft', 'awaiting_signature']).limit(1)
      if (openErr) throw new Error(`Could not check the SS-4: ${openErr.message}`)
      if ((open ?? []).length > 0) return true
      // … or the form chose them as the Responsible Party and no SS-4 has been made for the company yet. A company member's signer is
      // its representative, who has no members row of their own: match the representative's email too.
      const { data: person } = await supabaseAdmin.from('contacts').select('email').eq('id', contactId).maybeSingle()
      const mail = (person?.email ?? '').toLowerCase().trim()
      const { data: chosen, error: chosenErr } = await supabaseAdmin.from('members').select('contact_id, representative_email').eq('account_id', accountId).eq('is_signer', true)
      if (chosenErr) throw new Error(`Could not check the members: ${chosenErr.message}`)
      const isChosen = (chosen ?? []).some(m => m.contact_id === contactId || (mail !== '' && (m.representative_email ?? '').toLowerCase().trim() === mail))
      if (!isChosen) return false
      const { data: existing, error: existingErr } = await supabaseAdmin.from('ss4_applications').select('id').eq('account_id', accountId).limit(1)
      if (existingErr) throw new Error(`Could not check the SS-4: ${existingErr.message}`)
      return (existing ?? []).length === 0
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
    canSignIn: async (email, contactId) => {
      if (loginOpensLink(await findAuthUserByEmail(email), contactId)) return true
      // A login can point at this contact under a different address; the company page's chips count that as a login too.
      const { getClientLoginContactIds } = await import('@/lib/portal/client-login-index')
      return (await getClientLoginContactIds()).has(contactId)
    },
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

const NOBODY_CAN_OPEN_MESSAGE =
  'Nobody else who would still have access can open this company: none of them has a portal login yet. Create a login for one of them first (their Contact page, Portal tab), then take this access away.'

/**
 * Could somebody in this list actually open the company? A person can when they have a portal login, or — for a company still
 * being formed — when they have an email (their login is made once the EIN is in). Someone with neither is on the list but
 * cannot get in, so counting them as "keeping access" would leave the company unreachable.
 */
async function someoneCanOpen(accountId: string, contactIds: string[], deps: StaffAccessDeps): Promise<boolean> {
  if (contactIds.length === 0) return false
  const tier = await deps.accountTier(accountId)
  for (const id of contactIds) {
    const info = await deps.contactInfo(id)
    if (!info?.email) continue
    if (tier === 'formation') return true
    if (await deps.canSignIn(info.email, id)) return true
  }
  return false
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

  // The SS-4 Responsible Party signs the SS-4 in the portal: without the company they cannot, and the EIN stalls.
  if (await deps.isSs4Signer(p.accountId, p.contactId)) {
    return {
      success: false,
      message: 'This person is the SS-4 signer, so their portal access cannot be taken away until the SS-4 is signed.',
      error: 'signer',
    }
  }

  // Somebody who would still have access must be able to open the company (a link with no login behind it cannot).
  const keepers = stillOpen.filter((l) => l.contact_id !== p.contactId).map((l) => l.contact_id)
  if (!(await someoneCanOpen(p.accountId, keepers, deps))) {
    return { success: false, message: NOBODY_CAN_OPEN_MESSAGE, error: 'nobody_can_open' }
  }

  const r = await deps.setMark({ accountId: p.accountId, contactId: p.contactId, at: p.now ?? new Date().toISOString(), by: p.staffUserId })
  if (r.error) return { success: false, message: 'Could not take the access away.', error: r.error }

  // The check above and the write above are two steps. Check again against what the database holds NOW: if another click removed
  // the person who could open the company in between, put this one back as it was and say so. Two clicks at the same moment can
  // both be undone (nothing changes, try again) but can never both stand.
  // The undo's own result is read: if it fails, staff are told the truth ("the mark is still on"), never "nothing was changed".
  const undo = async () => deps.setMark({ accountId: p.accountId, contactId: p.contactId, at: null, by: link.access_revoked_by ?? null })
  let stillOk: boolean
  try {
    const fresh = await deps.listLinks(p.accountId)
    const keepersNow = fresh.filter((l) => !l.access_revoked_at && l.contact_id !== p.contactId).map((l) => l.contact_id)
    stillOk = await someoneCanOpen(p.accountId, keepersNow, deps)
  } catch (e) {
    // The re-check could not be completed: do not leave a write standing that was never confirmed.
    const undone = await undo()
    return {
      success: false,
      message: undone.error
        ? `Could not confirm the change and could not undo it (${undone.error}) — check this person's access on the company page.`
        : `Could not confirm the change (${e instanceof Error ? e.message : String(e)}), so nothing was changed. Try again.`,
      error: 'check_failed',
    }
  }
  if (!stillOk) {
    const undone = await undo()
    return {
      success: false,
      message: undone.error
        ? `Someone else changed this company's access at the same moment and the change could not be undone (${undone.error}) — check this person's access on the company page.`
        : "Someone else changed this company's access at the same moment, so nothing was changed. Try again.",
      error: 'race',
    }
  }

  await deps.resyncTier(p.accountId, 'portal access taken away for one member')
  return { success: true, message: 'Portal access taken away. They stay an owner; their login and other companies are untouched.' }
}

export async function givePortalAccess(
  p: {
    accountId: string
    contactId: string
    /** Only an admin may create a login and send a temporary password (same rule as the Create Portal Account route). Default true. */
    canCreateLogin?: boolean
    /** The team member giving the access. Kept on the link so the form's job never marks it again. Omitted = clears both fields, as before. */
    staffUserId?: string | null
  },
  deps: StaffAccessDeps = realStaffAccessDeps(),
): Promise<StaffAccessResult> {
  const links = await deps.listLinks(p.accountId)
  const link = links.find((l) => l.contact_id === p.contactId)
  if (!link) return { success: false, message: 'This person is not linked to the company.', error: 'not_linked' }
  if (!link.access_revoked_at) return { success: true, message: 'This person already has portal access to the company.', login: undefined }

  const r = await deps.setMark({ accountId: p.accountId, contactId: p.contactId, at: null, by: p.staffUserId ?? null })
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
