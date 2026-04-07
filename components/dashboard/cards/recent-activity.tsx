import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  CreditCard,
  FileText,
  PenTool,
  ArrowRight,
  Mail,
  Activity,
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import Link from 'next/link'

interface ActivityEvent {
  id: string
  icon: 'payment' | 'form' | 'signed' | 'stage' | 'email' | 'other'
  title: string
  subtitle: string
  time: string
  link: string
}

const ICON_MAP = {
  payment: { Icon: CreditCard, color: 'text-emerald-500', bg: 'bg-emerald-50' },
  form: { Icon: FileText, color: 'text-blue-500', bg: 'bg-blue-50' },
  signed: { Icon: PenTool, color: 'text-violet-500', bg: 'bg-violet-50' },
  stage: { Icon: ArrowRight, color: 'text-amber-500', bg: 'bg-amber-50' },
  email: { Icon: Mail, color: 'text-sky-500', bg: 'bg-sky-50' },
  other: { Icon: Activity, color: 'text-zinc-500', bg: 'bg-zinc-50' },
}

export async function RecentActivityCard() {
  const since = new Date(Date.now() - 48 * 3600000).toISOString()

  // Fetch recent events from action_log
  const [actionsResult, paymentsResult, signaturesResult] = await Promise.all([
    // Action log entries (emails, form submissions, stage advances)
    supabaseAdmin
      .from('action_log')
      .select('id, action_type, table_name, summary, account_id, created_at')
      .gte('created_at', since)
      .neq('action_type', 'cron_error')
      .order('created_at', { ascending: false })
      .limit(20),

    // Recent payments received (last 48h)
    supabaseAdmin
      .from('payments')
      .select('id, amount, currency, payment_date, account_id, accounts(company_name)')
      .eq('status', 'paid')
      .gte('payment_date', since.split('T')[0])
      .order('payment_date', { ascending: false })
      .limit(10),

    // Recent signatures (last 48h)
    supabaseAdmin
      .from('pending_activations')
      .select('id, contact_id, signed_at, contacts(full_name)')
      .not('signed_at', 'is', null)
      .gte('signed_at', since)
      .order('signed_at', { ascending: false })
      .limit(10),
  ])

  const events: ActivityEvent[] = []

  // Process payments
  for (const p of paymentsResult.data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = p.accounts as any
    const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
    const amount = Number(p.amount)
    const formatted = p.currency === 'EUR'
      ? `\u20AC${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    events.push({
      id: `pay-${p.id}`,
      icon: 'payment',
      title: `Payment received: ${formatted}`,
      subtitle: companyName,
      time: p.payment_date ?? '',
      link: '/finance',
    })
  }

  // Process signatures
  for (const s of signaturesResult.data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact = s.contacts as any
    const name = contact?.full_name ?? 'Unknown'
    events.push({
      id: `sig-${s.id}`,
      icon: 'signed',
      title: `Contract signed`,
      subtitle: name,
      time: s.signed_at ?? '',
      link: s.contact_id ? `/contacts/${s.contact_id}` : '/',
    })
  }

  // Process action log entries
  for (const a of actionsResult.data ?? []) {
    let icon: ActivityEvent['icon'] = 'other'
    if (a.action_type === 'email' || a.action_type === 'email_sent') icon = 'email'
    else if (a.action_type === 'form_submitted' || a.action_type === 'form_completed') icon = 'form'
    else if (a.action_type === 'stage_advance' || a.action_type === 'stage_advanced') icon = 'stage'

    events.push({
      id: `act-${a.id}`,
      icon,
      title: a.summary?.slice(0, 80) || a.action_type,
      subtitle: a.table_name ?? '',
      time: a.created_at,
      link: a.account_id ? `/accounts/${a.account_id}` : '/',
    })
  }

  // Sort by time (newest first) and deduplicate
  events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  const uniqueEvents = events.slice(0, 15)

  if (uniqueEvents.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Recent Activity
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Activity className="h-8 w-8 mb-2 text-zinc-300" />
          <p className="text-sm">No recent activity</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Recent Activity
        </h3>
        <span className="text-xs text-muted-foreground">Last 48h</span>
      </div>
      <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
        {uniqueEvents.map(event => {
          const { Icon, color, bg } = ICON_MAP[event.icon]
          const timeStr = event.time
            ? formatDistanceToNow(parseISO(event.time), { addSuffix: true })
            : ''
          return (
            <Link
              key={event.id}
              href={event.link}
              className="flex items-start gap-2.5 py-1.5 px-2 rounded-lg hover:bg-zinc-50 transition-colors"
            >
              <div className={`flex items-center justify-center h-6 w-6 rounded-full shrink-0 ${bg}`}>
                <Icon className={`h-3 w-3 ${color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-800 truncate">{event.title}</p>
                {event.subtitle && (
                  <p className="text-[10px] text-zinc-400 truncate">{event.subtitle}</p>
                )}
              </div>
              <span className="text-[10px] text-zinc-400 shrink-0 mt-0.5">{timeStr}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
