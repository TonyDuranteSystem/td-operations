export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Building2, Mail, Phone, User, PlusCircle } from 'lucide-react'

const STATUS_COLORS: Record<string, string> = {
  Active: 'bg-emerald-100 text-emerald-700',
  Inactive: 'bg-zinc-100 text-zinc-600',
  Closed: 'bg-red-100 text-red-700',
  Onboarding: 'bg-blue-100 text-blue-700',
}

export default async function PartnerClientDetailPage({
  params,
}: {
  params: Promise<{ accountId: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  const { accountId } = await params

  // Verify this account belongs to the partner
  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name')
    .eq('contact_id', contactId)
    .single()

  if (!partner) redirect('/portal/partner/clients')

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, status, entity_type, state_of_formation, ein_number, partner_id')
    .eq('id', accountId)
    .eq('partner_id', partner.id)
    .single()

  if (!account) redirect('/portal/partner/clients')

  // Contacts linked to this account
  const { data: accountContacts } = await supabaseAdmin
    .from('account_contacts')
    .select('contacts(id, first_name, last_name, full_name, email, phone)')
    .eq('account_id', accountId)

  const contacts = (accountContacts ?? []).map(
    row => (row as unknown as { contacts: { id: string; first_name: string | null; last_name: string | null; full_name: string | null; email: string | null; phone: string | null } }).contacts
  ).filter(Boolean)

  // Active services. The catalog_entries join resolves service_type via the
  // service_type_entry_id FK (Phase A read migration); display falls back to
  // the raw text when no FK row is found.
  const { data: servicesRaw } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, stage, status, service_type_entry:catalog_entries!service_deliveries_service_type_entry_id_fkey(display_name)')
    .eq('account_id', accountId)
    .eq('status', 'active')

  const services = ((servicesRaw ?? []) as Array<{
    id: string
    service_type: string
    stage: string | null
    status: string
    service_type_entry: { display_name: string } | null
  }>).map(s => ({
    id: s.id,
    service_type: s.service_type_entry?.display_name ?? s.service_type,
    stage: s.stage,
    status: s.status,
  }))

  const encodedName = encodeURIComponent(account.company_name ?? '')

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Back */}
      <Link
        href="/portal/partner/clients"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700"
      >
        <ArrowLeft className="h-4 w-4" />
        My Clients
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
            <Building2 className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{account.company_name}</h1>
            <p className="text-sm text-muted-foreground">
              {[account.entity_type, account.state_of_formation].filter(Boolean).join(' · ')}
              {account.ein_number ? ` · EIN: ${account.ein_number}` : ''}
            </p>
          </div>
        </div>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${STATUS_COLORS[account.status ?? ''] ?? 'bg-zinc-100 text-zinc-600'}`}>
          {account.status}
        </span>
      </div>

      {/* New Request CTA */}
      <Link
        href={`/portal/partner/new-request?accountId=${accountId}&accountName=${encodedName}`}
        className="flex items-center gap-2 w-full px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors justify-center"
      >
        <PlusCircle className="h-4 w-4" />
        New Request for this Client
      </Link>

      {/* Contacts */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b bg-zinc-50">
          <h2 className="text-sm font-semibold text-zinc-700">Contacts</h2>
        </div>
        {contacts.length === 0 ? (
          <p className="text-sm text-zinc-400 px-5 py-6 text-center">No contacts on file yet.</p>
        ) : (
          <div className="divide-y">
            {contacts.map(c => {
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.full_name || '—'
              return (
                <div key={c.id} className="px-5 py-4 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0 mt-0.5">
                    <User className="h-4 w-4 text-zinc-500" />
                  </div>
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{name}</p>
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-blue-600">
                        <Mail className="h-3 w-3 shrink-0" />
                        {c.email}
                      </a>
                    )}
                    {c.phone && (
                      <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-blue-600">
                        <Phone className="h-3 w-3 shrink-0" />
                        {c.phone}
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Active Services */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b bg-zinc-50">
          <h2 className="text-sm font-semibold text-zinc-700">Active Services</h2>
        </div>
        {(services ?? []).length === 0 ? (
          <p className="text-sm text-zinc-400 px-5 py-6 text-center">No active services.</p>
        ) : (
          <div className="divide-y">
            {(services ?? []).map(s => (
              <div key={s.id} className="px-5 py-3.5 flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-900">{s.service_type}</p>
                {s.stage && (
                  <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                    {s.stage}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
