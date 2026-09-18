import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { MapPin, ShieldCheck, Mail, FileText, Package } from 'lucide-react'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { type MailingAddressRow } from '@/lib/addresses'
import { t, getLocale, type Locale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'

export const dynamic = 'force-dynamic'

type AddrRow = MailingAddressRow & {
  name?: string | null
  agent_name?: string | null
  provider?: string | null
  country?: string | null
}

/**
 * Portal Addresses — the client's key addresses in one place, exactly four,
 * all set per-account in the CRM (Antonio, dev job 254834cc, 2026-09-17) —
 * nothing here is hardcoded:
 *   1. Registered Agent address (registered_agent_address/_provider).
 *   2. Legal address (business_legal_address_id) — from the Articles of
 *      Organization.
 *   3. CMRA Office address (business_mailing_address_id) — normally Tony
 *      Durante's own Largo office, but a per-account link set in the CRM
 *      like every other field here, not a code-level constant.
 *   4. Mailing/Shipping address (shipping_address_id) — normally Tony
 *      Durante's Seminole office; also where clients mail original
 *      documents to TD (folds in what used to be a separate "Tony Durante
 *      Mailing Address" card — same address, same purpose, one section).
 *
 * None of these fall back to the account's legacy free-text `physical_address`
 * column. If a link isn't set in the CRM yet, the card says so — showing a
 * stale or wrong address instead would be worse than "not on file."
 *
 * Read-only. Access is account-scoped: a client contact resolves via their
 * accounts; a teammate via their granted account.
 */
export default async function PortalAddressesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)
  const contactId = getClientContactId(user)

  let selectedAccountId: string | undefined
  if (contactId) {
    const accounts = await getPortalAccounts(contactId)
    const cookieStore = cookies()
    const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
    selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  } else {
    // Teammate (Portal Team Access) — scoped to their one account.
    const tmAccountId = await getTeammateScopeOrNull(user, 'documents')
    if (!tmAccountId) redirect('/portal')
    selectedAccountId = tmAccountId
  }

  // The client's account: RA (FK-joined, falls back to the legacy free-text
  // columns for accounts never migrated) + the FK-joined legal / mailing
  // (CMRA) / shipping addresses. Every field here is set per-account in the
  // CRM — CMRA/Legal/Mailing never fall back to legacy free-text data; RA
  // does, because unlike CMRA its legacy text and FK represent the exact
  // same fact (just two storage locations for it), not two different
  // addresses. Dev job 254834cc, 2026-09-18.
  let raRow: AddrRow | null = null
  let raLegacyAddress: string | null = null
  let raProvider: string | null = null
  let legal: AddrRow | null = null
  let cmra: AddrRow | null = null
  let shipping: AddrRow | null = null
  let companyName: string | null = null
  if (selectedAccountId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: acct } = await (supabaseAdmin as any)
      .from('accounts')
      .select('company_name, registered_agent_address, registered_agent_provider, registered_agent:addresses!registered_agent_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country), legal:addresses!business_legal_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country), mailing:addresses!business_mailing_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country), shipping:addresses!shipping_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country)')
      .eq('id', selectedAccountId)
      .maybeSingle()
    // The CRM's RA picker (components/shared/ra-picker.tsx) only ever writes
    // registered_agent_id, never the legacy free-text columns — so an
    // account set up through it has a real, verified RA the CRM can see, but
    // these columns stay null. Prefer the linked row; fall back to the
    // legacy text only for accounts never migrated. Dev job 254834cc, 2026-09-18.
    raRow = (acct?.registered_agent as AddrRow | null) ?? null
    raLegacyAddress = raRow?.address_line1 ? null : ((acct?.registered_agent_address as string | null) ?? null)
    raProvider = (raRow?.provider as string | null) ?? (acct?.registered_agent_provider as string | null) ?? null
    legal = (acct?.legal as AddrRow | null) ?? null
    cmra = (acct?.mailing as AddrRow | null) ?? null
    shipping = (acct?.shipping as AddrRow | null) ?? null
    companyName = (acct?.company_name as string | null) ?? null
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {t('addresses.title', locale, translations)}
        </h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {t('addresses.subtitle', locale, translations)}
        </p>
      </div>

      {/* Registered Agent address */}
      <AddressCard
        icon={ShieldCheck}
        accent="emerald"
        title={t('addresses.raTitle', locale, translations)}
        subtitle={raProvider ? `Provider: ${raProvider}` : t('addresses.raSubtitleDefault', locale, translations)}
        name={companyName}
        addr={raRow}
        legacyText={raLegacyAddress}
        country={null}
        empty={t('addresses.raEmpty', locale, translations)}
        locale={locale}
        translations={translations}
      />

      {/* Legal address */}
      <AddressCard
        icon={FileText}
        accent="amber"
        title={t('addresses.legalTitle', locale, translations)}
        subtitle={t('addresses.legalSubtitle', locale, translations)}
        name={(legal?.name as string | null) ?? companyName}
        addr={legal}
        legacyText={null}
        country={(legal?.country as string | null) ?? null}
        empty={t('addresses.legalEmpty', locale, translations)}
        locale={locale}
        translations={translations}
      />

      {/* Mailing / CMRA address */}
      <AddressCard
        icon={Mail}
        accent="violet"
        title={t('addresses.cmraTitle', locale, translations)}
        subtitle={t('addresses.cmraSubtitle', locale, translations)}
        name={(cmra?.name as string | null) ?? companyName}
        addr={cmra}
        legacyText={null}
        country={(cmra?.country as string | null) ?? null}
        empty={t('addresses.cmraEmpty', locale, translations)}
        locale={locale}
        translations={translations}
      />

      {/* Shipping address */}
      <AddressCard
        icon={Package}
        accent="rose"
        title={t('addresses.shippingTitle', locale, translations)}
        subtitle={t('addresses.shippingSubtitle', locale, translations)}
        name={(shipping?.name as string | null) ?? companyName}
        addr={shipping}
        legacyText={null}
        country={(shipping?.country as string | null) ?? null}
        empty={t('addresses.shippingEmpty', locale, translations)}
        locale={locale}
        translations={translations}
      />
    </div>
  )
}

const ACCENTS: Record<string, string> = {
  blue: 'text-blue-600 bg-blue-50',
  emerald: 'text-emerald-600 bg-emerald-50',
  violet: 'text-violet-600 bg-violet-50',
  amber: 'text-amber-600 bg-amber-50',
  rose: 'text-rose-600 bg-rose-50',
}

// Antonio, 2026-09-18: each field on its own labeled line (Address / Suite /
// City / State / Zip Code), not one joined string. Only possible when the
// address is a CRM-linked structured row (`addr`) — the RA card's legacy
// free-text fallback (`legacyText`) has no fields to split, so it renders as
// one plain line instead.
function AddressCard({
  icon: Icon, accent, title, subtitle, name, addr, legacyText, country, empty, locale, translations,
}: {
  icon: React.ElementType
  accent: string
  title: string
  subtitle: string
  name: string | null
  addr: AddrRow | null
  legacyText: string | null
  country: string | null
  empty: string
  locale: Locale
  translations: Record<string, string>
}) {
  const showCountry = country && !['US', 'USA', 'United States'].includes(country.trim())
  // Only render labeled fields when every field is actually present — a
  // partial structured row (e.g. address_line1 set but city/state/zip blank
  // from an incomplete edit) falls back to the legacy text instead of
  // showing a labeled row with nothing after the colon.
  const hasStructured = !!(addr?.address_line1?.trim() && addr?.city?.trim() && addr?.state?.trim() && addr?.zip?.trim())
  const hasAny = hasStructured || !!legacyText
  return (
    <div className="bg-white rounded-xl border shadow-sm p-5">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${ACCENTS[accent] ?? ACCENTS.blue}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>
          {hasAny ? (
            <div className="mt-3 text-sm text-zinc-800 leading-relaxed select-all space-y-0.5">
              {name && <div className="font-medium">{name}</div>}
              {hasStructured ? (
                <>
                  <div><span className="text-zinc-500">{t('addresses.labelAddress', locale, translations)}:</span> {addr!.address_line1}</div>
                  {addr!.address_line2 && <div><span className="text-zinc-500">{t('addresses.labelSuite', locale, translations)}:</span> {addr!.address_line2}</div>}
                  <div><span className="text-zinc-500">{t('addresses.labelCity', locale, translations)}:</span> {addr!.city}</div>
                  <div><span className="text-zinc-500">{t('addresses.labelState', locale, translations)}:</span> {addr!.state}</div>
                  <div><span className="text-zinc-500">{t('addresses.labelZip', locale, translations)}:</span> {addr!.zip}</div>
                </>
              ) : (
                <div>{legacyText}</div>
              )}
              {showCountry && <div>{country}</div>}
            </div>
          ) : (
            <div className="mt-3 inline-flex items-center gap-1.5 text-sm text-zinc-400">
              <MapPin className="h-3.5 w-3.5" /> {empty}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
