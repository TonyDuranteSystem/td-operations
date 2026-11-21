/**
 * Portal logins for the people linked to a company — the loop inside the welcome-package job (step "portal_members"),
 * pulled out so its rules can be tested (dev job beb43385, delivery B).
 *
 * The rules:
 *   - A link that carries the "no portal access" mark gets NO login. The person stays an owner (membership is a legal
 *     fact); the company simply stays out of the portal. (Unticked in the form, or taken away by the team.)
 *   - Every other link gets a login, as it always did (an existing login is left alone; only its tier is re-confirmed).
 *   - While the member-portal-access switch is on for this company, a login created here is followed by the welcome email
 *     with the temporary password. Before, the login was made silently and the member never learned the password. With the
 *     switch off nothing is emailed — exactly as before.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PortalTier } from '@/lib/portal/tier-config'
import { localeFromLanguage } from '@/lib/locale'

export interface MemberLoginResult {
  success: boolean
  alreadyExists: boolean
  email?: string
  tempPassword?: string
  error?: string
}

export interface MemberLoginDeps {
  /** The contacts whose link to this company does NOT carry the no-access mark. */
  listOpenLinks: (accountId: string) => Promise<string[]>
  createLogin: (p: { accountId: string; contactId: string; tier: PortalTier }) => Promise<MemberLoginResult>
  contactInfo: (contactId: string) => Promise<{ fullName: string | null; language: string | null }>
  sendWelcome: (p: { email: string; fullName: string; tempPassword: string; language: string }) => Promise<{ success: boolean; error?: string }>
}

export interface MemberLoginCounts {
  created: number
  existing: number
  errors: number
  emailed: number
  /** Logins that were created but whose welcome email could not be sent: the person has a password nobody has told them. */
  emailFailures: Array<{ name: string; email: string; reason: string }>
}

/** The default dependencies: the real database and the real login / email helpers. */
export function realMemberLoginDeps(): MemberLoginDeps {
  return {
    listOpenLinks: async (accountId) => {
      const { data } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .is('access_revoked_at', null)
        .eq('account_id', accountId)
      return (data ?? []).map((l) => l.contact_id)
    },
    createLogin: async (p) => {
      const { autoCreatePortalUser } = await import('@/lib/portal/auto-create')
      return autoCreatePortalUser({ accountId: p.accountId, contactId: p.contactId, tier: p.tier, autoCreated: true })
    },
    contactInfo: async (contactId) => {
      const { data } = await supabaseAdmin.from('contacts').select('full_name, language').eq('id', contactId).maybeSingle()
      return { fullName: data?.full_name ?? null, language: data?.language ?? null }
    },
    sendWelcome: async (p) => {
      const { sendPortalWelcomeEmail } = await import('@/lib/portal/auto-create')
      return sendPortalWelcomeEmail(p)
    },
  }
}

export async function createLoginsForLinkedMembers(
  p: { accountId: string; tier: PortalTier; welcomeEmailOn: boolean },
  deps: MemberLoginDeps = realMemberLoginDeps(),
): Promise<MemberLoginCounts> {
  const counts: MemberLoginCounts = { created: 0, existing: 0, errors: 0, emailed: 0, emailFailures: [] }
  const contactIds = await deps.listOpenLinks(p.accountId)

  for (const contactId of contactIds) {
    try {
      const pr = await deps.createLogin({ accountId: p.accountId, contactId, tier: p.tier })
      if (!pr.success) {
        counts.errors++
        console.warn('[welcome-package] portal user failed:', pr.error)
        continue
      }
      if (pr.alreadyExists) {
        counts.existing++
        continue
      }
      counts.created++
      if (p.welcomeEmailOn && pr.tempPassword && pr.email) {
        const info = await deps.contactInfo(contactId)
        const language = localeFromLanguage(info.language)
        const mail = await deps.sendWelcome({
          email: pr.email,
          fullName: info.fullName || pr.email,
          tempPassword: pr.tempPassword,
          language,
        })
        if (mail.success) counts.emailed++
        else {
          // The login exists but its password never reached the person. Counted, not swallowed: the job step turns red and names them
          // (before, this was only a console line and the step said "ok" — QA 21 Nov 2026, dev job beb43385).
          console.warn('[welcome-package] welcome email failed:', mail.error)
          counts.emailFailures.push({ name: info.fullName || pr.email, email: pr.email, reason: mail.error || 'unknown error' })
        }
      } else if (p.welcomeEmailOn) {
        // A login was created but there is no address or password to send the welcome email with.
        const info = await deps.contactInfo(contactId)
        counts.emailFailures.push({ name: info.fullName || pr.email || contactId, email: pr.email ?? '(no email)', reason: pr.tempPassword ? 'no email address' : 'no temporary password was returned' })
      }
    } catch (memberErr) {
      counts.errors++
      console.warn('[welcome-package] portal user error:', memberErr instanceof Error ? memberErr.message : memberErr)
    }
  }
  return counts
}
