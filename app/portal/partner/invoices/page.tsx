export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'

const STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Pending: 'bg-amber-100 text-amber-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
  Draft: 'bg-zinc-100 text-zinc-600',
  'Not Invoiced': 'bg-zinc-100 text-zinc-500',
}

export default async function PartnerInvoicesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name')
    .eq('contact_id', contactId)
    .single()

  const { data: invoices } = await supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, status, invoice_status, invoice_number, paid_date, due_date, created_at, account_id, accounts:account_id(company_name)')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })

  const rows = invoices ?? []

  // Summary totals
  const totalBilled = rows.reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const totalPaid = rows.filter(i => i.status === 'Paid').reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const totalOutstanding = rows
    .filter(i => i.status !== 'Paid' && i.status !== 'Cancelled' && i.status !== 'Not Invoiced')
    .reduce((s, i) => s + (Number(i.amount) || 0), 0)

  // Group by client account
  const groups = new Map<string, { companyName: string; items: typeof rows }>()
  for (const inv of rows) {
    const acct = inv.accounts as unknown as { company_name: string } | null
    const key = inv.account_id ?? '__none__'
    const companyName = acct?.company_name ?? 'General'
    if (!groups.has(key)) groups.set(key, { companyName, items: [] })
    groups.get(key)!.items.push(inv)
  }

  const currency = rows[0]?.amount_currency ?? 'USD'
  const fmt = (n: number) => `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 0 })}`

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">Invoices</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {partner ? `Invoices for ${partner.partner_name}` : 'Your invoices from Tony Durante LLC'}
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <div className="text-lg font-bold text-zinc-900">{fmt(totalBilled)}</div>
          <div className="text-xs text-zinc-500 mt-0.5">Total Billed</div>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <div className="text-lg font-bold text-emerald-700">{fmt(totalPaid)}</div>
          <div className="text-xs text-zinc-500 mt-0.5">Paid</div>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <div className={`text-lg font-bold ${totalOutstanding > 0 ? 'text-amber-700' : 'text-zinc-400'}`}>
            {fmt(totalOutstanding)}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">Outstanding</div>
        </div>
      </div>

      {/* Grouped by client */}
      {groups.size === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-10 text-center text-sm text-zinc-400">
          No invoices yet. Invoices will appear here when services are billed.
        </div>
      ) : (
        Array.from(groups.entries()).map(([key, group]) => (
          <div key={key} className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b bg-zinc-50">
              <h2 className="text-sm font-semibold text-zinc-700">{group.companyName}</h2>
            </div>
            <div className="divide-y">
              {group.items.map(inv => (
                <div key={inv.id} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="text-sm font-medium text-zinc-900 truncate">
                      {inv.invoice_number ?? inv.description ?? 'Invoice'}
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2 ${STATUS_COLORS[inv.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {inv.status}
                    </span>
                  </div>
                  {inv.description && inv.invoice_number && (
                    <p className="text-xs text-zinc-500 truncate">{inv.description}</p>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <div className="text-[10px] text-zinc-400">
                      {inv.due_date && <span>Due: {inv.due_date} · </span>}
                      {inv.paid_date && <span>Paid: {inv.paid_date} · </span>}
                      {inv.created_at?.split('T')[0]}
                    </div>
                    <div className="text-sm font-semibold text-zinc-900">
                      {inv.amount_currency ?? currency} {Number(inv.amount).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
