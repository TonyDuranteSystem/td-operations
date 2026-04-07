import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function PartnerInvoicesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  // Fetch partner info
  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name')
    .eq('contact_id', contactId)
    .single()

  // Fetch invoices addressed to this partner (via contact_id on payments)
  const { data: invoices } = await supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, status, invoice_status, invoice_number, paid_date, due_date, created_at, account_id, accounts:account_id(company_name)')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })

  const totalPaid = (invoices ?? []).filter(i => i.status === 'Paid').reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const totalOutstanding = (invoices ?? []).filter(i => i.status !== 'Paid' && i.status !== 'Cancelled').reduce((s, i) => s + (Number(i.amount) || 0), 0)

  const STATUS_COLORS: Record<string, string> = {
    Paid: 'bg-emerald-100 text-emerald-700',
    Pending: 'bg-amber-100 text-amber-700',
    Overdue: 'bg-red-100 text-red-700',
    Cancelled: 'bg-zinc-100 text-zinc-500',
    Draft: 'bg-zinc-100 text-zinc-600',
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold">Invoices</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {partner ? `Invoices for ${partner.partner_name}` : 'Your invoices from Tony Durante LLC'}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border p-4 text-center">
          <div className="text-2xl font-bold text-emerald-700">${totalPaid.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">Total Paid</div>
        </div>
        <div className={`bg-white rounded-lg border p-4 text-center ${totalOutstanding > 0 ? '' : ''}`}>
          <div className={`text-2xl font-bold ${totalOutstanding > 0 ? 'text-amber-700' : 'text-zinc-400'}`}>
            ${totalOutstanding.toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">Outstanding</div>
        </div>
      </div>

      {/* Invoice list */}
      <div className="space-y-3">
        {(invoices ?? []).map(inv => {
          const acct = inv.accounts as unknown as { company_name: string } | null
          return (
            <div key={inv.id} className="bg-white rounded-lg border p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium text-sm">{inv.invoice_number ?? inv.description ?? 'Invoice'}</div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[inv.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                  {inv.status}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {acct?.company_name && <span>{acct.company_name} · </span>}
                  {inv.description && <span>{inv.description}</span>}
                </div>
                <div className="text-sm font-semibold">
                  {inv.amount_currency ?? 'USD'} {Number(inv.amount).toLocaleString()}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {inv.due_date && <span>Due: {inv.due_date} · </span>}
                {inv.paid_date && <span>Paid: {inv.paid_date} · </span>}
                Created: {inv.created_at?.split('T')[0]}
              </div>
            </div>
          )
        })}
        {(invoices ?? []).length === 0 && (
          <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
            No invoices yet. Invoices will appear here when services are billed.
          </div>
        )}
      </div>
    </div>
  )
}
