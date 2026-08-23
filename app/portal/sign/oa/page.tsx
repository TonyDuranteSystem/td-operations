/**
 * Portal OA Signing Page — Embeds the existing OA page inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the OA linked to that account
 * 3. For MMLLC: resolves the current user's oa_signatures record
 * 4. Embeds the existing OA page in an iframe with auto-verification
 *
 * The iframe reuses the existing OA signing page without duplication.
 * Access code is passed directly — no email gate needed.
 * ?portal=true tells the embedded page to hide external chrome and
 * send postMessage on sign completion.
 * ?signer={access_code} identifies which MMLLC member is signing.
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts } from '@/lib/portal/queries'
import { APP_BASE_URL } from '@/lib/config'
import { PortalOAClient } from './portal-oa-client'
import { cookies } from 'next/headers'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { signOaPass } from '@/lib/oa/portal-pass'
import { signerLinkExpiryISO } from '@/lib/oa/public-view'
import { t, getLocale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import { interpolateString } from '@/lib/template-interpolation'

/**
 * `?account=` selects the company (validated against the caller's own accounts).
 *
 * `?oa=` may also be present. This page deliberately IGNORES it and always shows
 * the company's most recent agreement, which is the only one that can be signed —
 * a regenerate deletes and replaces the previous row. The id is in the link
 * purely so the notification's duplicate-suppression scope changes when the
 * agreement is replaced: without it, a client regenerating within ten minutes had
 * the replacement notification suppressed while the old emailed link had already
 * been invalidated, leaving a co-signer with a dead link and no warning.
 */
export default async function PortalSignOAPage({ searchParams }: { searchParams?: Promise<{ account?: string; oa?: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">{t('signDocs.notLoggedIn')}</p>
      </div>
    )
  }

  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)

  const contactId = getClientContactId(user)
  if (!contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">{t('signDocs.noContact', locale, translations)}</p>
      </div>
    )
  }

  // Get selected account — from cookie or fallback to first account
  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  // ?account= wins over the cookie. A client with more than one company reaches
  // this page from a notification about ONE of them; without it they land on
  // whichever company the switcher last left in the cookie — potentially a
  // "You have already signed" screen for the wrong company, right after being
  // told to sign. The id is only honoured if it is genuinely theirs (it is
  // matched against getPortalAccounts), so it cannot be used to reach another
  // client's company.
  const requestedAccountId = (await searchParams)?.account
  const selectedAccountId = accounts.length > 0
    ? (accounts.find(a => a.id === requestedAccountId)?.id
        ?? accounts.find(a => a.id === cookieAccountId)?.id
        ?? accounts[0].id)
    : ''

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">{t('signDocs.noCompany', locale, translations)}</p>
          <p className="text-zinc-400 text-sm">{t('signSubpages.oa.noCompanyDesc', locale, translations)}</p>
        </div>
      </div>
    )
  }

  // Find the OA for this account (most recent)
  const { data: oa } = await supabaseAdmin
    .from('oa_agreements')
    .select('token, access_code, status, company_name, entity_type, total_signers, signed_count, id')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!oa) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-3 max-w-md px-4">
          <p className="text-zinc-500 text-lg">{t('signSubpages.oa.notFoundTitle', locale, translations)}</p>
          <p className="text-zinc-400 text-sm">
            {t('signSubpages.oa.notFoundDescPrefix', locale, translations)}{' '}
            <a href="/portal/documents/generate" className="text-blue-500 hover:text-blue-400 underline">
              {t('signSubpages.documentsGenerateLink', locale, translations)}
            </a>
            {' '}{t('signSubpages.oa.notFoundDescSuffix', locale, translations)}
          </p>
        </div>
      </div>
    )
  }

  // Voided OA — show same helpful message
  if (oa.status === 'voided') {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-3 max-w-md px-4">
          <p className="text-zinc-500 text-lg">{t('signSubpages.oa.voidedTitle', locale, translations)}</p>
          <p className="text-zinc-400 text-sm">
            {t('signSubpages.oa.voidedDescPrefix', locale, translations)}{' '}
            <a href="/portal/documents/generate" className="text-blue-500 hover:text-blue-400 underline">
              {t('signSubpages.documentsGenerateLink', locale, translations)}
            </a>
            {' '}{t('signSubpages.oa.voidedDescSuffix', locale, translations)}
          </p>
        </div>
      </div>
    )
  }

  // Per-member signing is decided by whether signature RECORDS exist, not by
  // the expected count — see the note in the sign route. With the count, a
  // multi-member agreement expecting one signature produced no `?signer=` on
  // the link, and the document page then accepted a signature from anyone
  // holding the shared access code.
  const { count: sigRowCount } = await supabaseAdmin
    .from('oa_signatures')
    .select('id', { count: 'exact', head: true })
    .eq('oa_id', oa.id)
  const isMultiSigner = normalizeEntityType(oa.entity_type) === 'MMLLC' && (sigRowCount ?? 0) > 0

  // For MMLLC: find this user's signature record
  let signerParam = ''
  let memberStatus: string | null = null
  let signedCount = oa.signed_count || 0
  const totalSigners = oa.total_signers || 1

  if (isMultiSigner) {
    // ONE PERSON CAN HOLD SEVERAL SIGNATURE ROWS on the same agreement, and it
    // is not a duplicate: Umberto Moretti is both the 1% individual member of
    // Azarexa LLC and the contact behind its 99% corporate member, so he signs
    // twice — once for himself, once for the company.
    //
    // This used to be `.maybeSingle()`, which supabase-js resolves to an ERROR
    // (data null) when more than one row matches. The effect was silent and
    // total: no access code, no signing link, and a member who is legally
    // required to sign simply could not — the page offered him nothing.
    //
    // Ordered by member_index so he is walked through his capacities in the
    // same order they appear on the agreement, and the first UNSIGNED row is
    // handed to him; once every one is signed the last row's status drives the
    // "already signed" screen below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new columns not yet in generated DB types
    const { data: memberSigs } = await (supabaseAdmin as any)
      .from('oa_signatures')
      .select('id, access_code, status, member_name, member_index, link_expires_at, revoked_at')
      .eq('oa_id', oa.id)
      .eq('contact_id', contactId)
      .order('member_index')

    const rows = memberSigs ?? []
    const nextUnsigned = rows.find(r => r.status !== 'signed')
    const memberSig = nextUnsigned ?? rows[rows.length - 1] ?? null

    if (memberSig) {
      // A REVOKED link (the membership changed under a partially-signed agreement)
      // is NOT auto-healed — the roster changed and staff must reissue. Show the
      // logged-in member a clear message instead of a signing pad.
      if (memberSig.revoked_at && memberSig.status !== 'signed') {
        return (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="text-center space-y-3 max-w-md px-4">
              <p className="text-zinc-700 text-lg font-medium">{t('signSubpages.oa.revokedTitle', locale, translations)}</p>
              <p className="text-zinc-500 text-sm">
                {interpolateString(t('signSubpages.oa.revokedDescPrefix', locale, translations), { company: oa.company_name })}{' '}
                <a href="mailto:support@tonydurante.us" className="text-blue-500 hover:text-blue-400 underline">support@tonydurante.us</a>.
              </p>
            </div>
          </div>
        )
      }

      // AUTO-HEAL an EXPIRED own link for a logged-in member: they proved their
      // identity by signing in, so silently re-stamp a fresh 15-day window on THIS
      // row (never touches another member's row, never un-revokes, never un-signs).
      // The row's code is unchanged — the wrapper embeds the current one live — so
      // no previously-dead emailed link is revived elsewhere.
      if (
        memberSig.status !== 'signed' &&
        !memberSig.revoked_at &&
        memberSig.link_expires_at &&
        new Date(memberSig.link_expires_at).getTime() <= Date.now()
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new columns not yet in generated DB types
        await (supabaseAdmin as any)
          .from('oa_signatures')
          .update({ link_expires_at: signerLinkExpiryISO(), updated_at: new Date().toISOString() })
          .eq('id', memberSig.id)
          .is('revoked_at', null)
          .neq('status', 'signed')
      }

      signerParam = `&signer=${memberSig.access_code}`
      memberStatus = memberSig.status
    }

    // Get up-to-date signed count
    const { data: sigs } = await supabaseAdmin
      .from('oa_signatures')
      .select('status')
      .eq('oa_id', oa.id)
    signedCount = sigs?.filter(s => s.status === 'signed').length ?? 0
  }

  // If member already signed and OA not fully signed, show progress
  if (isMultiSigner && memberStatus === 'signed' && oa.status !== 'signed') {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-3 max-w-md">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-zinc-700 text-lg font-medium">{t('signSubpages.oa.alreadySignedTitle', locale, translations)}</p>
          <p className="text-zinc-500 text-sm">
            {interpolateString(t('signSubpages.oa.alreadySignedDesc', locale, translations), { signedCount, totalSigners, company: oa.company_name })}
          </p>
          <div className="w-full bg-zinc-200 rounded-full h-2 mt-4">
            <div
              className="bg-emerald-500 h-2 rounded-full transition-all"
              style={{ width: `${(signedCount / totalSigners) * 100}%` }}
            />
          </div>
          <p className="text-zinc-400 text-xs">{interpolateString(t('signSubpages.oa.signedCountOf', locale, translations), { signedCount, totalSigners })}</p>
        </div>
      </div>
    )
  }

  // A short-lived pass, bound to THIS agreement, that proves to the public fetch
  // route "a logged-in member of this company opened it" — so the embedded iframe
  // skips the email gate without the spoofable bare ?portal=true flag. ?portal=true
  // stays only for the page's layout / postMessage behaviour, no longer for auth.
  const portalPass = await signOaPass({ oaId: oa.id, kind: 'portal', sub: contactId })

  // Construct URL with portal=true (and signer param for MMLLC) + the bound pass.
  const oaUrl = `${APP_BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?portal=true${signerParam}&pass=${encodeURIComponent(portalPass)}`

  return (
    <div>
      {/* Progress banner for MMLLC */}
      {isMultiSigner && oa.status !== 'signed' && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-center text-sm text-blue-700">
          <strong>{interpolateString(t('signSubpages.oa.progressCount', locale, translations), { signedCount, totalSigners })}</strong>
          {t('signSubpages.oa.progressSuffix', locale, translations)}
          {memberStatus !== 'signed' && t('signSubpages.oa.progressNeedsYou', locale, translations)}
        </div>
      )}
      <PortalOAClient
        oaUrl={oaUrl}
        status={oa.status}
        companyName={oa.company_name}
        accountId={selectedAccountId}
        canResend={isMultiSigner}
      />
    </div>
  )
}
