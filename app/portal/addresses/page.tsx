import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { MapPin, Building2, ShieldCheck, Mail } from 'lucide-react'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatAddressString, type MailingAddressRow } from '@/lib/addresses'
import { getLocale } from '@/lib/portal/i18n'

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
 *   3. Their mailing / CMRA address (the account's business_mailing_address_id).
 *
 * Read-only. Access is account-scoped: a client contact resolves via their
 * accounts; a teammate via their granted account.
 */
export default async function PortalAddressesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const locale = getLocale(user)
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
  // mailing address (business_mailing_address_id = their CMRA mailing address).
  let raAddress: string | null = null
  let raProvider: string | null = null
  let cmra: AddrRow | null = null
  let companyName: string | null = null
  if (selectedAccountId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: acct } = await (supabaseAdmin as any)
      .from('accounts')
      .select('company_name, registered_agent_address, registered_agent_provider, mailing:addresses!business_mailing_address_id(name, agent_name, provider, address_line1, address_line2, city, state, zip, country)')
      .eq('id', selectedAccountId)
      .maybeSingle()
    raAddress = (acct?.registered_agent_address as string | null) ?? null
    raProvider = (acct?.registered_agent_provider as string | null) ?? null
    cmra = (acct?.mailing as AddrRow | null) ?? null
    companyName = (acct?.company_name as string | null) ?? null
  }

  const it = locale === 'it'
  const tdLine = formatAddressString(tdAddr as MailingAddressRow | null)
  const cmraLine = formatAddressString(cmra as MailingAddressRow | null)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {it ? 'Indirizzi' : 'Addresses'}
        </h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {it
            ? 'Gli indirizzi importanti per la tua azienda.'
            : 'The key addresses for your company.'}
        </p>
      </div>

      {/* TD mailing address */}
      <AddressCard
        icon={Building2}
        accent="blue"
        title={it ? 'Indirizzo postale di Tony Durante' : 'Tony Durante Mailing Address'}
        subtitle={it
          ? 'Usa questo indirizzo per inviarci documenti o posta fisica.'
          : 'Use this address to send us documents or physical mail.'}
        name={(tdAddr?.name as string | null) ?? 'Tony Durante LLC'}
        line={tdLine}
        country={(tdAddr?.country as string | null) ?? null}
        empty={it ? 'Non disponibile.' : 'Not available.'}
      />

      {/* Registered Agent address */}
      <AddressCard
        icon={ShieldCheck}
        accent="emerald"
        title={it ? 'Agente Registrato' : 'Registered Agent'}
        subtitle={raProvider
          ? (it ? `Provider: ${raProvider}` : `Provider: ${raProvider}`)
          : (it ? "L'indirizzo del tuo agente registrato." : 'Your registered agent address.')}
        name={companyName}
        line={raAddress}
        country={null}
        empty={it ? 'Nessun agente registrato in archivio.' : 'No registered agent on file.'}
      />

      {/* Mailing / CMRA address */}
      <AddressCard
        icon={Mail}
        accent="violet"
        title={it ? 'Indirizzo postale (CMRA)' : 'Mailing Address (CMRA)'}
        subtitle={it
          ? "L'indirizzo postale della tua azienda."
          : "Your company's mailing address."}
        name={(cmra?.name as string | null) ?? companyName}
        line={cmraLine}
        country={(cmra?.country as string | null) ?? null}
        empty={it ? 'Nessun indirizzo postale in archivio.' : 'No mailing address on file.'}
      />
    </div>
  )
}

const ACCENTS: Record<string, string> = {
  blue: 'text-blue-600 bg-blue-50',
  emerald: 'text-emerald-600 bg-emerald-50',
  violet: 'text-violet-600 bg-violet-50',
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
