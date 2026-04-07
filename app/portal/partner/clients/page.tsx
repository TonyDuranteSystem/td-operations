import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function PartnerClientsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  // Find partner record for this contact
  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name')
    .eq('contact_id', contactId)
    .single()

  if (!partner) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold mb-2">My Clients</h1>
        <p className="text-sm text-muted-foreground">No partner account found. Contact support if you believe this is an error.</p>
      </div>
    )
  }

  // Fetch managed accounts
  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, status, entity_type, state_of_formation, ein_number')
    .eq('partner_id', partner.id)
    .order('company_name')

  // Fetch active services for all accounts
  const accountIds = (accounts ?? []).map(a => a.id)
  let services: Array<{ account_id: string; service_type: string; stage: string | null; status: string }> = []
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
    const list = servicesByAccount.get(s.account_id) ?? []
    list.push(s)
    servicesByAccount.set(s.account_id, list)
  }

  const STATUS_COLORS: Record<string, string> = {
    Active: 'bg-emerald-100 text-emerald-700',
    Inactive: 'bg-zinc-100 text-zinc-600',
    Closed: 'bg-red-100 text-red-700',
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">My Clients</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {accounts?.length ?? 0} companies managed by {partner.partner_name}
        </p>
      </div>

      <div className="space-y-3">
        {(accounts ?? []).map(a => {
          const acctServices = servicesByAccount.get(a.id) ?? []
          return (
            <div key={a.id} className="bg-white rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{a.company_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.entity_type ?? ''} · {a.state_of_formation ?? ''}{a.ein_number ? ` · EIN: ${a.ein_number}` : ''}
                  </div>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status ?? ''] ?? 'bg-zinc-100 text-zinc-600'}`}>
                  {a.status}
                </span>
              </div>
              {acctServices.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {acctServices.map((s, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                      {s.service_type}{s.stage ? `: ${s.stage}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {(accounts ?? []).length === 0 && (
          <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
            No clients yet. New clients will appear here when they are onboarded.
          </div>
        )}
      </div>
    </div>
  )
}
