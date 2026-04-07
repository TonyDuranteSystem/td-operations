import { supabaseAdmin } from '@/lib/supabase-admin'
import { Calendar, Clock, AlertCircle, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'

export async function TodayEventsCard() {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  // Fetch today's deadlines and any recently failed cron jobs in parallel
  const [deadlinesResult, cronResult] = await Promise.all([
    supabaseAdmin
      .from('deadlines')
      .select('id, deadline_type, due_date, status, account_id, accounts(company_name)')
      .eq('due_date', today)
      .in('status', ['Pending', 'Overdue'])
      .order('deadline_type')
      .limit(10),

    // Check for cron failures in last 24h
    supabaseAdmin
      .from('action_log')
      .select('id, action_type, summary, created_at')
      .eq('action_type', 'cron_error')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  // Also fetch tomorrow's deadlines as a heads-up
  const { data: tomorrowDeadlines } = await supabaseAdmin
    .from('deadlines')
    .select('id, deadline_type, due_date, status, account_id, accounts(company_name)')
    .eq('due_date', tomorrow)
    .in('status', ['Pending', 'Overdue'])
    .order('deadline_type')
    .limit(5)

  const todayDeadlines = deadlinesResult.data ?? []
  const cronErrors = cronResult.data ?? []
  const upcomingTomorrow = tomorrowDeadlines ?? []
  const hasItems = todayDeadlines.length > 0 || cronErrors.length > 0 || upcomingTomorrow.length > 0

  if (!hasItems) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Today
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Sun className="h-8 w-8 mb-2 text-amber-400" />
          <p className="text-sm">Clear day ahead</p>
          <p className="text-xs text-zinc-400 mt-0.5">No deadlines or events</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Today &mdash; {format(new Date(), 'MMM d')}
        </h3>
        {todayDeadlines.length > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
            {todayDeadlines.length} due
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        {/* Cron errors first */}
        {cronErrors.map(err => (
          <div key={err.id} className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-red-50 text-sm">
            <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate text-xs text-red-800">Cron Error</p>
              <p className="text-xs text-red-600 truncate">{err.summary}</p>
            </div>
            <span className="text-[10px] text-red-500 shrink-0">
              {format(parseISO(err.created_at), 'HH:mm')}
            </span>
          </div>
        ))}

        {/* Today's deadlines */}
        {todayDeadlines.map(dl => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const accounts = dl.accounts as any
          const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
          return (
            <Link
              key={dl.id}
              href={dl.account_id ? `/accounts/${dl.account_id}` : '/tax-returns'}
              className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-blue-50 text-sm hover:bg-blue-100 transition-colors"
            >
              <Calendar className={cn('h-4 w-4 shrink-0', dl.status === 'Overdue' ? 'text-red-500' : 'text-blue-500')} />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate text-xs">{dl.deadline_type}</p>
                <p className="text-xs text-muted-foreground truncate">{companyName}</p>
              </div>
              <span className="text-[10px] font-medium text-blue-600 shrink-0">Today</span>
            </Link>
          )
        })}

        {/* Tomorrow preview */}
        {upcomingTomorrow.length > 0 && (
          <>
            <div className="pt-1.5">
              <p className="text-[10px] text-zinc-400 uppercase tracking-wide px-1">Tomorrow</p>
            </div>
            {upcomingTomorrow.map(dl => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const accounts = dl.accounts as any
              const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
              return (
                <Link
                  key={dl.id}
                  href={dl.account_id ? `/accounts/${dl.account_id}` : '/tax-returns'}
                  className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-zinc-50 text-sm hover:bg-zinc-100 transition-colors"
                >
                  <Clock className="h-4 w-4 text-zinc-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate text-xs text-zinc-600">{dl.deadline_type}</p>
                    <p className="text-xs text-zinc-400 truncate">{companyName}</p>
                  </div>
                </Link>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
