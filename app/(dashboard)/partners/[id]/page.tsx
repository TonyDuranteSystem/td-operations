import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { PartnerHeaderActions, type PartnerData, type ManagedAccount } from './components/partner-actions'
import { ManagedClientsSection } from './components/managed-clients-section'
import { BackButton } from '@/components/ui/back-button'

export const dynamic = 'force-dynamic'

export default async function PartnerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) redirect('/login')

  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select(`
      id, partner_name, partner_email, status, commission_model, price_list, agreed_services, notes, created_at,
      contact:contacts!client_partners_contact_id_fkey(id, full_name, email, phone, language, citizenship)
    `)
    .eq('id', params.id)
    .single()

  if (!partner) notFound()

  const contact = partner.contact as unknown as {
    id: string; full_name: string; email: string; phone: string; language: string; citizenship: string
  } | null

  // Fetch managed accounts
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, status, entity_type, state_of_formation, ein_number, account_type')
    .eq('partner_id', params.id)
    .order('company_name')

  // Fetch active service deliveries for managed accounts
  const accountIds = (accounts ?? []).map(a => a.id)
  let services: Array<{ account_id: string; service_type: string; stage: string; status: string }> = []
  if (accountIds.length > 0) {
    const { data: sds } = await supabaseAdmin
      .from('service_deliveries')
      .select('account_id, service_type, stage, status')
      .in('account_id', accountIds)
      .eq('status', 'active')
    services = (sds ?? []) as typeof services
  }

  const servicesByAccount: Record<string, typeof services> = {}
  for (const s of services) {
    if (!servicesByAccount[s.account_id]) servicesByAccount[s.account_id] = []
    servicesByAccount[s.account_id].push(s)
  }

  // Fetch payments made by partner (contact_id)
  let totalPaid = 0
  let totalOutstanding = 0
  if (contact?.id) {
    const { data: payments } = await supabaseAdmin
      .from('payments')
      .select('amount, amount_currency, status')
      .eq('contact_id', contact.id)

    for (const p of payments ?? []) {
      if (p.status === 'Paid') totalPaid += Number(p.amount) || 0
      else totalOutstanding += Number(p.amount) || 0
    }
  }

  // Fetch referrals where this partner is the referrer
  interface ReferralRow {
    id: string
    referred_name: string
    status: string
    commission_amount: number | null
    commission_currency: string | null
    commission_type: string | null
    commission_pct: number | null
    paid_amount: number | null
    created_at: string
    referred_account: { company_name: string } | null
  }
  let referrals: ReferralRow[] = []
  let totalCommission = 0
  let totalCommissionPaid = 0
  if (contact?.id) {
    const { data: refs } = await supabaseAdmin
      .from('referrals')
      .select('id, referred_name, status, commission_amount, commission_currency, commission_type, commission_pct, paid_amount, created_at, referred_account:accounts!referrals_referred_account_id_fkey(company_name)')
      .eq('referrer_contact_id', contact.id)
      .order('created_at', { ascending: false })
    referrals = (refs ?? []) as unknown as ReferralRow[]
    for (const r of referrals) {
      totalCommission += Number(r.commission_amount) || 0
      totalCommissionPaid += Number(r.paid_amount) || 0
    }
  }

  const priceList = (partner.price_list ?? {}) as Record<string, number>

  // Serialize partner data for client components
  const partnerData: PartnerData = {
    id: partner.id,
    partner_name: partner.partner_name,
    partner_email: partner.partner_email,
    status: partner.status,
    commission_model: partner.commission_model,
    agreed_services: partner.agreed_services,
    price_list: priceList,
    notes: partner.notes,
    contact: contact ? {
      id: contact.id,
      full_name: contact.full_name,
      email: contact.email,
      phone: contact.phone,
      language: contact.language,
    } : null,
  }

  const managedAccounts: ManagedAccount[] = (accounts ?? []).map(a => ({
    id: a.id,
    company_name: a.company_name,
    status: a.status,
    entity_type: a.entity_type,
    state_of_formation: a.state_of_formation,
  }))

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <BackButton />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{partner.partner_name}</h1>
          <p className="text-sm text-muted-foreground">
            {contact?.full_name ?? 'No contact'} · {partner.partner_email ?? contact?.email ?? '—'}
          </p>
        </div>
        <span className={`text-xs font-medium px-3 py-1 rounded-full ${
          partner.status === 'active' ? 'bg-emerald-100 text-emerald-700'
            : partner.status === 'suspended' ? 'bg-amber-100 text-amber-700'
            : 'bg-zinc-100 text-zinc-600'
        }`}>
          {partner.status}
        </span>
        <PartnerHeaderActions partner={partnerData} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Partner Info */}
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Partner Info</h3>
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Commission Model</span>
              <span className="font-medium capitalize">{partner.commission_model?.replace('_', ' ') ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Contact</span>
              {contact ? (
                <Link href={`/contacts/${contact.id}`} className="text-blue-600 hover:underline font-medium">
                  {contact.full_name}
                </Link>
              ) : <span>—</span>}
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Phone</span>
              <span>{contact?.phone ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Services</span>
              <div className="flex flex-wrap gap-1 justify-end">
                {(partner.agreed_services ?? []).map((s: string) => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">{s}</span>
                ))}
              </div>
            </div>
          </div>
          {partner.notes && (
            <div className="border-t pt-3 mt-2">
              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{partner.notes}</p>
            </div>
          )}
        </div>

        {/* Financials */}
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Financials</h3>

          {/* Invoices — what partner pays TD */}
          {(totalPaid > 0 || totalOutstanding > 0) && (
            <>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Invoices</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-emerald-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-700">${totalPaid.toLocaleString()}</div>
                  <div className="text-xs text-emerald-600">Paid to TD</div>
                </div>
                <div className={`rounded-lg p-3 text-center ${totalOutstanding > 0 ? 'bg-amber-50' : 'bg-zinc-50'}`}>
                  <div className={`text-2xl font-bold ${totalOutstanding > 0 ? 'text-amber-700' : 'text-zinc-400'}`}>
                    ${totalOutstanding.toLocaleString()}
                  </div>
                  <div className={`text-xs ${totalOutstanding > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>Outstanding</div>
                </div>
              </div>
            </>
          )}

          {/* Referral Commissions — what TD owes the partner */}
          {referrals.length > 0 && (
            <div className={totalPaid > 0 || totalOutstanding > 0 ? 'border-t pt-3 mt-2' : ''}>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Referral Commissions</p>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-blue-50 rounded-lg p-2.5 text-center">
                  <div className="text-lg font-bold text-blue-700">{referrals.length}</div>
                  <div className="text-[10px] text-blue-600">Referrals</div>
                </div>
                <div className={`rounded-lg p-2.5 text-center ${totalCommission - totalCommissionPaid > 0 ? 'bg-amber-50' : 'bg-zinc-50'}`}>
                  <div className={`text-lg font-bold ${totalCommission - totalCommissionPaid > 0 ? 'text-amber-700' : 'text-zinc-400'}`}>
                    &euro;{(totalCommission - totalCommissionPaid).toLocaleString()}
                  </div>
                  <div className={`text-[10px] ${totalCommission - totalCommissionPaid > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>TD Owes</div>
                </div>
                <div className="bg-emerald-50 rounded-lg p-2.5 text-center">
                  <div className="text-lg font-bold text-emerald-700">&euro;{totalCommissionPaid.toLocaleString()}</div>
                  <div className="text-[10px] text-emerald-600">Paid Out</div>
                </div>
              </div>
              <div className="space-y-1.5">
                {referrals.map(r => {
                  const statusColor = r.status === 'converted' ? 'bg-blue-100 text-blue-700'
                    : r.status === 'paid' ? 'bg-emerald-100 text-emerald-700'
                    : r.status === 'credited' ? 'bg-violet-100 text-violet-700'
                    : 'bg-amber-100 text-amber-700'
                  return (
                    <div key={r.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColor}`}>{r.status}</span>
                        <span className="text-muted-foreground">{r.referred_name}</span>
                      </div>
                      <span className="font-medium">
                        {r.commission_amount ? `€${r.commission_amount}` : r.commission_pct ? `${r.commission_pct}%` : 'TBD'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* No financial data at all */}
          {totalPaid === 0 && totalOutstanding === 0 && referrals.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-4">No financial data yet</div>
          )}

          {Object.keys(priceList).length > 0 && (
            <div className="border-t pt-3 mt-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Price List</p>
              <div className="grid gap-1">
                {Object.entries(priceList).map(([service, price]) => (
                  <div key={service} className="flex justify-between text-sm">
                    <span className="text-muted-foreground capitalize">{service.replace('_', ' ')}</span>
                    <span className="font-medium">${price}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Managed Clients — interactive */}
      <ManagedClientsSection
        partner={partnerData}
        accounts={managedAccounts}
        servicesByAccount={servicesByAccount}
      />
    </div>
  )
}
