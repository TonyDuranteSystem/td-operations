import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PartnersHeader } from './components/partners-header'
import { labelForServiceStatic } from '@/lib/services'
import { KEEP_WHOLE } from '@/lib/ui/table-cells'

export const dynamic = 'force-dynamic'

// Every row is its own grid, so the columns need FIXED minimums (a plain 1fr is "as small as its longest word", which differs row by row:
// one row squeezed Contact to 45px while the next one did not). The box scrolls sideways below this width instead of squeezing.
const PARTNER_COLS = 'md:grid-cols-[minmax(14rem,1fr),minmax(10rem,1fr),120px,120px,minmax(11rem,1fr),100px]'

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

      <div className="bg-white rounded-lg border overflow-x-auto">
        <div className="md:min-w-[62rem]">
        <div className={`hidden md:grid ${PARTNER_COLS} gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider`}>
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
              className={`grid grid-cols-1 ${PARTNER_COLS} gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center`}
            >
              <div className="min-w-0">
                <div className="font-medium text-sm">{p.partner_name}</div>
                {p.partner_email && <div className="text-xs text-muted-foreground truncate" title={p.partner_email}>{p.partner_email}</div>}
              </div>
              <div className="text-sm text-muted-foreground">{contact?.full_name ?? '—'}</div>
              <div className={`text-xs text-muted-foreground capitalize ${KEEP_WHOLE}`}>{p.commission_model?.replace('_', ' ') ?? '—'}</div>
              <div className="text-sm font-medium">{clientCount}</div>
              <div className="flex flex-wrap gap-1">
                {(p.agreed_services ?? []).map((s: string) => (
                  <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 ${KEEP_WHOLE}`}>{labelForServiceStatic(s)}</span>
                ))}
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${KEEP_WHOLE} ${STATUS_COLORS[p.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
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
    </div>
  )
}
