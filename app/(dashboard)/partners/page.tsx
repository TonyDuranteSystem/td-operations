import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PartnersHeader } from './components/partners-header'

export const dynamic = 'force-dynamic'

export default async function PartnersPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) redirect('/login')

  const { data: partners } = await supabaseAdmin
    .from('client_partners')
    .select(`
      id, partner_name, partner_email, status, commission_model, agreed_services, notes, created_at,
      contact:contacts!client_partners_contact_id_fkey(full_name, email, phone)
    `)
    .order('partner_name')

  // Count clients per partner
  const { data: accountCounts } = await supabaseAdmin
    .from('accounts')
    .select('partner_id')
    .not('partner_id', 'is', null)

  const countMap = new Map<string, number>()
  for (const a of accountCounts ?? []) {
    countMap.set(a.partner_id, (countMap.get(a.partner_id) ?? 0) + 1)
  }

  const STATUS_COLORS: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-700',
    suspended: 'bg-amber-100 text-amber-700',
    inactive: 'bg-zinc-100 text-zinc-600',
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PartnersHeader count={partners?.length ?? 0} />

      <div className="bg-white rounded-lg border overflow-hidden">
        <div className="hidden md:grid md:grid-cols-[1fr,1fr,120px,120px,1fr,100px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Partner</span>
          <span>Contact</span>
          <span>Model</span>
          <span>Clients</span>
          <span>Services</span>
          <span>Status</span>
        </div>
        {(partners ?? []).map(p => {
          const contact = p.contact as unknown as { full_name: string; email: string; phone: string } | null
          const clientCount = countMap.get(p.id) ?? 0
          return (
            <Link
              key={p.id}
              href={`/partners/${p.id}`}
              className="grid grid-cols-1 md:grid-cols-[1fr,1fr,120px,120px,1fr,100px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center"
            >
              <div>
                <div className="font-medium text-sm">{p.partner_name}</div>
                {p.partner_email && <div className="text-xs text-muted-foreground">{p.partner_email}</div>}
              </div>
              <div className="text-sm text-muted-foreground">{contact?.full_name ?? '—'}</div>
              <div className="text-xs text-muted-foreground capitalize">{p.commission_model?.replace('_', ' ') ?? '—'}</div>
              <div className="text-sm font-medium">{clientCount}</div>
              <div className="flex flex-wrap gap-1">
                {(p.agreed_services ?? []).map((s: string) => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">{s}</span>
                ))}
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${STATUS_COLORS[p.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                {p.status}
              </span>
            </Link>
          )
        })}
        {(partners ?? []).length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No partners found</div>
        )}
      </div>
    </div>
  )
}
