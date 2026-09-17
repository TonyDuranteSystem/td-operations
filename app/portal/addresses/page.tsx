import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { MapPin, Building2, ShieldCheck, Mail, FileText, Package } from 'lucide-react'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatAddressString, resolveMailingAddress, type MailingAddressRow } from '@/lib/addresses'
import { t, getLocale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'

export const dynamic = 'force-dynamic'

type AddrRow = MailingAddressRow & {
  name?: string | null
  agent_name?: string | null
  provider?: string | null
  country?: string | null
}

/**
 * Portal Addresses — the client's key addresses in one place:
 *   1. Tony Durante's mailing address (TD-provided business_mailing) — where the
 *      client sends physical mail / signed originals to TD.
 *   2. Their Registered Agent address.
 *   3. Their Legal address (the account's business_legal_address_id).
 *   4. Their Mailing / CMRA address (the account's business_mailing_address_id).
 *   5. Their Shipping address (the account's shipping_address_id) — a separate,
 *      stable slot from Legal (which can be TD's own office for a company TD
 *      formed, or a client's old pre-existing address for one onboarded from
 *      elsewhere — dev job 254834cc, 2026-09-16).
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

  // TD-provided mailing address (where the client mails things to TD).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tdAddr } = await (supabaseAdmin as any)
    .from('addresses')
    .select('name, agent_name, provider, address_line1, address_line2, city, state, zip, country')
    .eq('is_td_provided', true)
    .eq('kind', 'business_mailing')
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  // The client's account: RA address (free-text + provider) + the FK-joined
  // legal / mailing (CMRA) / shipping addresses.
  let raAddress: string | null = null
  let raProvider: string | null = null
  let legal: AddrRow | null = null
  let cmra: AddrRow | null = null
  let shipping: AddrRow | null = null
  let companyName: string | null = null
  let legacyMailing: string | null = null
  if (selectedAccountId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: acct } = await (supabaseAdmin as any)
      .from('accounts')
      .select('company_name, physical_address, registered_agent_address, registered_agent_provider, legal:addresses!business_legal_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country), mailing:addresses!business_mailing_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country), shipping:addresses!shipping_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country)')
      .eq('id', selectedAccountId)
      .maybeSingle()
    raAddress = (acct?.registered_agent_address as string | null) ?? null
    raProvider = (acct?.registered_agent_provider as string | null) ?? null
    legal = (acct?.legal as AddrRow | null) ?? null
    cmra = (acct?.mailing as AddrRow | null) ?? null
    shipping = (acct?.shipping as AddrRow | null) ?? null
    companyName = (acct?.company_name as string | null) ?? null
    legacyMailing = (acct?.physical_address as string | null) ?? null
  }

  const tdLine = formatAddressString(tdAddr as MailingAddressRow | null)
  const legalLine = formatAddressString(legal as MailingAddressRow | null)
  // Accounts predating the address registry only ever got the free-text
  // `physical_address` column set, never the linked `mailing` row — without
  // this fallback (the same one lib/portal/queries.ts::getPortalAccountDetail
  // already uses for the dashboard) this card would wrongly claim "not on
  // file" for an address the rest of the system already resolves and relies
  // on. Dev job 254834cc, 2026-09-17.
  const cmraLine = resolveMailingAddress(cmra as MailingAddressRow | null, legacyMailing)
  const shippingLine = formatAddressString(shipping as MailingAddressRow | null)

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

      {/* TD mailing address */}
      <AddressCard
        icon={Building2}
        accent="blue"
        title={t('addresses.tdTitle', locale, translations)}
        subtitle={t('addresses.tdSubtitle', locale, translations)}
        name={(tdAddr?.name as string | null) ?? 'Tony Durante LLC'}
        line={tdLine}
        country={(tdAddr?.country as string | null) ?? null}
        empty={t('addresses.tdEmpty', locale, translations)}
      />

      {/* Registered Agent address */}
      <AddressCard
        icon={ShieldCheck}
        accent="emerald"
        title={t('addresses.raTitle', locale, translations)}
        subtitle={raProvider ? `Provider: ${raProvider}` : t('addresses.raSubtitleDefault', locale, translations)}
        name={companyName}
        line={raAddress}
        country={null}
        empty={t('addresses.raEmpty', locale, translations)}
      />

      {/* Legal address */}
      <AddressCard
        icon={FileText}
        accent="amber"
        title={t('addresses.legalTitle', locale, translations)}
        subtitle={t('addresses.legalSubtitle', locale, translations)}
        name={(legal?.name as string | null) ?? companyName}
        line={legalLine}
        country={(legal?.country as string | null) ?? null}
        empty={t('addresses.legalEmpty', locale, translations)}
      />

      {/* Mailing / CMRA address */}
      <AddressCard
        icon={Mail}
        accent="violet"
        title={t('addresses.cmraTitle', locale, translations)}
        subtitle={t('addresses.cmraSubtitle', locale, translations)}
        name={(cmra?.name as string | null) ?? companyName}
        line={cmraLine}
        country={(cmra?.country as string | null) ?? null}
        empty={t('addresses.cmraEmpty', locale, translations)}
      />

      {/* Shipping address */}
      <AddressCard
        icon={Package}
        accent="rose"
        title={t('addresses.shippingTitle', locale, translations)}
        subtitle={t('addresses.shippingSubtitle', locale, translations)}
        name={(shipping?.name as string | null) ?? companyName}
        line={shippingLine}
        country={(shipping?.country as string | null) ?? null}
        empty={t('addresses.shippingEmpty', locale, translations)}
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

function AddressCard({
  icon: Icon, accent, title, subtitle, name, line, country, empty,
}: {
  icon: React.ElementType
  accent: string
  title: string
  subtitle: string
  name: string | null
  line: string | null
  country: string | null
  empty: string
}) {
  const showCountry = country && !['US', 'USA', 'United States'].includes(country.trim())
  return (
    <div className="bg-white rounded-xl border shadow-sm p-5">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${ACCENTS[accent] ?? ACCENTS.blue}`}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
          {line ? (
            <div className="mt-3 text-sm text-zinc-800 leading-relaxed select-all">
              {name && <div className="font-medium">{name}</div>}
              <div>{line}</div>
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
