import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const STATUS_COLORS: Record<string, string> = {
  Active: 'bg-emerald-100 text-emerald-700',
  Inactive: 'bg-zinc-100 text-zinc-600',
  Closed: 'bg-red-100 text-red-700',
  Suspended: 'bg-amber-100 text-amber-700',
}

export default async function PartnerDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect('/login')

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

  const servicesByAccount = new Map<string, typeof services>()
  for (const s of services) {
    const existing = servicesByAccount.get(s.account_id) ?? []
    existing.push(s)
    servicesByAccount.set(s.account_id, existing)
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

  const priceList = (partner.price_list ?? {}) as Record<string, number>

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/partners" className="text-zinc-400 hover:text-zinc-600">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{partner.partner_name}</h1>
          <p className="text-sm text-muted-foreground">
            {contact?.full_name ?? 'No contact'} · {partner.partner_email ?? contact?.email ?? '—'}
          </p>
        </div>
        <span className={`ml-auto text-xs font-medium px-3 py-1 rounded-full ${
          partner.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-600'
        }`}>
          {partner.status}
        </span>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-emerald-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-emerald-700">${totalPaid.toLocaleString()}</div>
              <div className="text-xs text-emerald-600">Total Paid</div>
            </div>
            <div className={`rounded-lg p-3 text-center ${totalOutstanding > 0 ? 'bg-amber-50' : 'bg-zinc-50'}`}>
              <div className={`text-2xl font-bold ${totalOutstanding > 0 ? 'text-amber-700' : 'text-zinc-400'}`}>
                ${totalOutstanding.toLocaleString()}
              </div>
              <div className={`text-xs ${totalOutstanding > 0 ? 'text-amber-600' : 'text-zinc-400'}`}>Outstanding</div>
            </div>
          </div>

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

      {/* Managed Clients */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <div className="px-5 py-3 border-b bg-zinc-50">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Managed Clients ({accounts?.length ?? 0})
          </h3>
        </div>
        <div className="hidden md:grid md:grid-cols-[1fr,120px,120px,100px,1fr] gap-3 px-4 py-2 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Company</span>
          <span>Type</span>
          <span>State</span>
          <span>Status</span>
          <span>Active Services</span>
        </div>
        {(accounts ?? []).map(a => {
          const acctServices = servicesByAccount.get(a.id) ?? []
          return (
            <Link
              key={a.id}
              href={`/accounts/${a.id}`}
              className="grid grid-cols-1 md:grid-cols-[1fr,120px,120px,100px,1fr] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center"
            >
              <div>
                <div className="font-medium text-sm">{a.company_name}</div>
                {a.ein_number && <div className="text-xs text-muted-foreground">EIN: {a.ein_number}</div>}
              </div>
              <div className="text-xs text-muted-foreground">{a.entity_type ?? '—'}</div>
              <div className="text-xs text-muted-foreground">{a.state_of_formation ?? '—'}</div>
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded w-fit ${STATUS_COLORS[a.status ?? ''] ?? 'bg-zinc-100 text-zinc-600'}`}>
                {a.status ?? '—'}
              </span>
              <div className="flex flex-wrap gap-1">
                {acctServices.map((s, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                    {s.service_type}: {s.stage}
                  </span>
                ))}
                {acctServices.length === 0 && <span className="text-xs text-zinc-400">No active services</span>}
              </div>
            </Link>
          )
        })}
        {(accounts ?? []).length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No managed clients yet</div>
        )}
      </div>
    </div>
  )
}
