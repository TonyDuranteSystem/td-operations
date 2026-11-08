/**
 * Client iPhone app — who this login is and what the portal knows about them (server; dev job 056a70d0, Step 2).
 *
 * The portal's page shell (`app/portal/layout.tsx`) works out the facts the side menu needs, one request at a time. The app needs
 * the same facts as an answer, so this module gathers them with the SAME helpers and the SAME order of decisions: the contact, the
 * companies and the ones being formed or onboarded, the company cookies, the tier, the portal mode, the menu flags, the counters.
 * The layout itself is deliberately NOT touched by this change (it serves every client; the app's answer is switched off). A later
 * job can make the layout call this module too, so the two can never drift; until then `tests/unit/portal-app-load.test.ts` pins the
 * decisions that matter, and its drift guard fails when the layout stops using one of these helpers or one of the company cookies.
 *
 * Who the app is for (Antonio, 8 Nov 2026): clients and the team members they added. Staff logins use TD Social, and partners stay on
 * the website; both are refused here with a plain answer, never an error page.
 */
import type { User } from '@supabase/supabase-js'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import {
  getContactOnlyNavVisibility,
  getInProgressFormations,
  getInProgressOnboardings,
  getPortalAccountById,
  getPortalAccounts,
  getPortalNavVisibility,
  getPortalRoleByContact,
  getPortalTierByContact,
  getUnpaidInvoiceCount,
  getUnreadChatCount,
  type InProgressFormation,
  type InProgressOnboarding,
} from '@/lib/portal/queries'
import { resolveSelectedEntity, type SelectedEntity } from '@/lib/portal/select-entity'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { computeHasWizardPending } from '@/lib/portal/wizard-visibility'
import { getLocale, t as portalT } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import { getUnopenedDocsCount } from '@/lib/portal/document-alerts'
import { getToSignCount } from '@/lib/portal/signable-documents'
import { resolvePortalMode } from '@/lib/portal/portal-mode'
import { isPartnerPortal } from '@/lib/portal/tier-config'
import type { PortalAccount } from '@/lib/types'
import type { AppMeInput } from '@/lib/portal-app/assemble'
import { getBarPref } from '@/lib/portal-app/bar-pref'
import { isClientAppPayEnabled } from '@/lib/portal-app/enabled'

/** The helpers this module calls, so the decisions below can be tested without a database. */
export interface AppLoadDeps {
  getAccounts: typeof getPortalAccounts
  getInProgressFormations: typeof getInProgressFormations
  getInProgressOnboardings: typeof getInProgressOnboardings
  getTierByContact: typeof getPortalTierByContact
  getRoleByContact: typeof getPortalRoleByContact
  resolveMode: typeof resolvePortalMode
  getAccountById: typeof getPortalAccountById
  resolveIdentity: typeof resolvePortalIdentity
  getNavVisibility: typeof getPortalNavVisibility
  getContactOnlyNavVisibility: typeof getContactOnlyNavVisibility
  getUnreadChatCount: typeof getUnreadChatCount
  getUnopenedDocsCount: typeof getUnopenedDocsCount
  getToSignCount: typeof getToSignCount
  getUnpaidInvoiceCount: typeof getUnpaidInvoiceCount
  computeHasWizardPending: typeof computeHasWizardPending
  isAccountAdmin: typeof isAccountAdmin
  loadTranslations: typeof loadTranslationsForLocale
  getBarPref: typeof getBarPref
  isPayEnabled: typeof isClientAppPayEnabled
}

export const defaultAppLoadDeps: AppLoadDeps = {
  getAccounts: getPortalAccounts,
  getInProgressFormations,
  getInProgressOnboardings,
  getTierByContact: getPortalTierByContact,
  getRoleByContact: getPortalRoleByContact,
  resolveMode: resolvePortalMode,
  getAccountById: getPortalAccountById,
  resolveIdentity: resolvePortalIdentity,
  getNavVisibility: getPortalNavVisibility,
  getContactOnlyNavVisibility,
  getUnreadChatCount,
  getUnopenedDocsCount,
  getToSignCount,
  getUnpaidInvoiceCount,
  computeHasWizardPending,
  isAccountAdmin,
  loadTranslations: loadTranslationsForLocale,
  getBarPref,
  isPayEnabled: isClientAppPayEnabled,
}

export type AppRefusal = { ok: false; status: 403; code: 'NOT_A_CLIENT' | 'NOT_FOR_PARTNERS' | 'NO_ACCESS'; error: string }

const refuse = (code: AppRefusal['code'], error: string): AppRefusal => ({ ok: false, status: 403, code, error })

export type AppAudience =
  | {
      ok: true
      kind: 'teammate'
      user: User
      account: PortalAccount
      capabilities: Record<string, boolean>
      displayName: string
      email: string | null
    }
  | {
      ok: true
      kind: 'client'
      user: User
      contactId: string
      accounts: PortalAccount[]
      inProgress: InProgressFormation[]
      inProgressOnboardings: InProgressOnboarding[]
      selected: SelectedEntity
      /** The portal role after the Client / Partner switch is applied (a dual-role person in partner mode counts as a partner). */
      effectiveRole: string | null
    }

/** Who is this login, for the app? A client, a team member a client added, or a refusal. Staff and partners are refused. */
export async function resolveAppAudience(
  user: User,
  getCookie: (name: string) => string | undefined,
  deps: AppLoadDeps = defaultAppLoadDeps,
): Promise<AppAudience | AppRefusal> {
  // A team member a client added (Portal Team Access): scoped to ONE company, the menu follows what the owner granted.
  if ((user.app_metadata as Record<string, unknown> | undefined)?.kind === 'team_member') {
    const identity = await deps.resolveIdentity(user)
    if (identity.kind !== 'teammate') return refuse('NO_ACCESS', 'Your access has been removed. Please contact the company owner.')
    const account = await deps.getAccountById(identity.accountId)
    if (!account) return refuse('NO_ACCESS', 'Your access has been removed. Please contact the company owner.')
    return {
      ok: true,
      kind: 'teammate',
      user,
      account,
      capabilities: identity.capabilities as Record<string, boolean>,
      displayName: identity.displayName,
      email: identity.email,
    }
  }

  // Everyone else must be a client login. Staff (admin / team) use TD Social; the portal's "debugging mode" for staff is not for the app.
  if (!isClient(user)) return refuse('NOT_A_CLIENT', 'This app is for clients. Staff use TD Social.')
  const contactId = getClientContactId(user)
  if (!contactId) return refuse('NO_ACCESS', 'Your login is not linked to a client record. Please contact support.')

  const accounts = await deps.getAccounts(contactId)
  const inProgress = await deps.getInProgressFormations(contactId)
  const inProgressOnboardings = await deps.getInProgressOnboardings(contactId)
  const [contactTier, portalRole] = await Promise.all([deps.getTierByContact(contactId), deps.getRoleByContact(contactId)])

  // Dual-role (client AND partner): the portal's own switch decides which one this request is. Partner mode = not for the app.
  const modeCtx = await deps.resolveMode(
    contactId,
    accounts.length > 0 || inProgress.length > 0 || inProgressOnboardings.length > 0,
    getCookie('portal_mode'),
  )
  const effectiveRole = modeCtx.mode === 'partner' ? 'partner' : modeCtx.dual ? 'client' : portalRole
  if (isPartnerPortal(effectiveRole)) return refuse('NOT_FOR_PARTNERS', 'Partners use the website for now.')

  const selected = resolveSelectedEntity({
    accounts,
    inProgress,
    accountCookie: getCookie('portal_account_id'),
    formationCookie: getCookie('portal_formation'),
    inProgressOnboardings,
    onboardingCookie: getCookie('portal_onboarding'),
    fallbackTier: contactTier,
  })
  return { ok: true, kind: 'client', user, contactId, accounts, inProgress, inProgressOnboardings, selected, effectiveRole }
}

const userName = (user: User) => String((user.user_metadata as Record<string, unknown> | undefined)?.full_name ?? '').trim() || null

/** Everything `assembleAppMe` needs for one login. */
export async function loadAppMeInput(
  user: User,
  getCookie: (name: string) => string | undefined,
  deps: AppLoadDeps = defaultAppLoadDeps,
): Promise<{ ok: true; input: AppMeInput } | AppRefusal> {
  const who = await resolveAppAudience(user, getCookie, deps)
  if (who.ok === false) return who
  const locale = getLocale(user)
  const [translations, savedBar, payEnabled] = await Promise.all([
    deps.loadTranslations(locale),
    deps.getBarPref(user.id),
    deps.isPayEnabled(),
  ])
  const t = (key: string) => translations[key] ?? portalT(key, locale)

  if (who.kind === 'teammate') {
    const navVisibility = await deps.getNavVisibility(who.account.id)
    return {
      ok: true,
      input: {
        user: { name: who.displayName || null, email: who.email },
        kind: 'teammate',
        locale,
        t,
        ctx: {
          navVisibility,
          portalTier: who.account.portal_tier ?? 'active',
          accountType: who.account.account_type ?? null,
          hasWizardPending: false,
          canManageTeam: false,
          isTeammate: true,
          teammateCapabilities: who.capabilities,
          hasCompany: true,
        },
        selection: { inProgress: [], inProgressOnboardings: [] },
        company: { id: who.account.id, name: who.account.company_name },
        // The side menu shows a team member no counters.
        counts: { chat: 0, documents: 0, sign: 0, billing: 0 },
        savedBar,
        payEnabled,
      },
    }
  }

  const { contactId, accounts, selected, effectiveRole } = who
  const selectedAccountId = selected.kind === 'account' ? selected.accountId : ''
  const portalTier = selected.tier
  const navVisibility = selectedAccountId ? await deps.getNavVisibility(selectedAccountId) : await deps.getContactOnlyNavVisibility()

  // Each counter fails to 0 on its own: one dropped connection must not blank the whole answer (same as the page shell).
  const [chat, documents, sign, billing, hasWizardPending, canManageTeam] = await Promise.all([
    deps.getUnreadChatCount(contactId).catch(() => 0),
    deps.getUnopenedDocsCount(contactId, accounts.map(a => a.id)).catch(() => 0),
    selectedAccountId ? deps.getToSignCount({ selectedAccountId, contactId, userEmail: user.email }).catch(() => 0) : Promise.resolve(0),
    selectedAccountId ? deps.getUnpaidInvoiceCount(selectedAccountId).catch(() => 0) : Promise.resolve(0),
    deps.computeHasWizardPending({
      contactId,
      selectedAccountId,
      portalTier,
      onboardingOfferId: selected.kind === 'onboarding' ? selected.offerId : undefined,
    }),
    selectedAccountId ? deps.isAccountAdmin(contactId, selectedAccountId) : Promise.resolve(false),
  ])

  const company =
    selected.kind === 'account'
      ? { id: selected.accountId, name: selected.account.company_name }
      : selected.kind === 'formation'
        ? { id: selected.formationId, name: selected.label }
        : selected.kind === 'onboarding'
          ? { id: selected.onboardingId, name: selected.label }
          : null

  return {
    ok: true,
    input: {
      user: { name: userName(user), email: user.email ?? null },
      kind: 'client',
      locale,
      t,
      ctx: {
        navVisibility,
        portalTier,
        accountType: accounts.find(a => a.id === selectedAccountId)?.account_type ?? null,
        portalRole: effectiveRole,
        hasWizardPending,
        canManageTeam,
        isTeammate: false,
        teammateCapabilities: {},
        hasCompany: accounts.length > 0,
      },
      selection: {
        selectedOnboardingId: selected.kind === 'onboarding' ? selected.onboardingId : undefined,
        selectedFormationId: selected.kind === 'formation' ? selected.formationId : undefined,
        inProgress: who.inProgress,
        inProgressOnboardings: who.inProgressOnboardings,
      },
      company,
      counts: { chat, documents, sign, billing },
      savedBar,
      payEnabled,
    },
  }
}
