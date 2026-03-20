import { createClient } from '@/lib/supabase/server'
import { Calendar, PartyPopper } from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO } from 'date-fns'
import Link from 'next/link'

export async function UpcomingDeadlinesCard() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]

  // Get overdue + next 7 days
  const { data: deadlines } = await supabase
    .from('deadlines')
    .select('id, deadline_type, due_date, status, account_id, accounts!inner(company_name)')
    .in('status', ['Pending', 'Overdue'])
    .lte('due_date', nextWeek)
    .order('due_date', { ascending: true })
    .limit(8)

  if (!deadlines || deadlines.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Upcoming Deadlines
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <PartyPopper className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">No deadlines this week</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Upcoming Deadlines
        </h3>
        <span className="text-xs text-muted-foreground">Next 7 days</span>
      </div>
      <div className="space-y-2">
        {deadlines.map(d => {
          const daysUntil = differenceInDays(parseISO(d.due_date), parseISO(today))
          const isOverdue = daysUntil < 0
          const isUrgent = daysUntil <= 3 && !isOverdue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const accounts = d.accounts as any
          const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'

          const href = d.account_id
            ? `/accounts/${d.account_id}`
            : d.deadline_type?.toLowerCase().includes('tax')
              ? '/tax-returns'
              : '/payments'

          return (
            <Link
              key={d.id}
              href={href}
              className={cn(
                'flex items-center gap-2 py-1.5 px-3 rounded-lg text-sm hover:bg-zinc-50 cursor-pointer transition-colors',
                isOverdue ? 'bg-red-50' : isUrgent ? 'bg-orange-50' : 'bg-yellow-50'
              )}
            >
              <Calendar className={cn(
                'h-4 w-4 shrink-0',
                isOverdue ? 'text-red-500' : isUrgent ? 'text-orange-500' : 'text-yellow-500'
              )} />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate text-xs">{d.deadline_type}</p>
                <p className="text-xs text-muted-foreground truncate">{companyName}</p>
              </div>
              <span className={cn(
                'text-xs font-medium shrink-0',
                isOverdue ? 'text-red-600' : isUrgent ? 'text-orange-600' : 'text-yellow-600'
              )}>
                {isOverdue
                  ? `${Math.abs(daysUntil)}d overdue`
                  : daysUntil === 0
                    ? 'Today'
                    : `${daysUntil}d`
                }
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
