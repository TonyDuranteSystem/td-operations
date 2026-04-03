'use client'

import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'

interface ClientSummary {
  id: string
  company_name: string
  outstanding: number
  overdue: number
  overdue_count: number
  invoice_count: number
}

interface AgingBuckets {
  current: { amount: number; count: number }
  d1_30: { amount: number; count: number }
  d31_60: { amount: number; count: number }
  d60plus: { amount: number; count: number }
}

interface Props {
  stats: { totalOutstanding: number; totalOverdue: number; overdueCount: number; clientCount: number; cashThisMonth: number; avgDaysToPay: number }
  clientList: ClientSummary[]
  agingBuckets: AgingBuckets
  recentAuditLog: Array<Record<string, unknown>>
}

function fmt(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, h:mm a') } catch { return d }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAuditDescription(entry: any): string {
  const action = entry.action ?? entry.event ?? ''
  const inv = entry.client_invoices
  const invNum = inv?.invoice_number ?? ''
  const company = inv?.accounts?.company_name ?? ''
  const parts: string[] = []
  if (invNum) parts.push(invNum)
  if (action) parts.push(action)
  if (company) parts.push(`— ${company}`)
  return parts.join(' ') || 'Invoice activity'
}

export function OverviewTab({ stats, clientList, agingBuckets, recentAuditLog }: Props) {
  const router = useRouter()

  // Top overdue clients
  const overdueClients = clientList
    .filter(c => c.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 10)

  // Aging total for bar widths
  const agingTotal = agingBuckets.current.amount + agingBuckets.d1_30.amount + agingBuckets.d31_60.amount + agingBuckets.d60plus.amount

  return (
    <div className="p-6 space-y-6 overflow-y-auto max-h-[calc(100vh-200px)]">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Outstanding</p>
          <p className="text-2xl font-bold">{fmt(stats.totalOutstanding)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Overdue</p>
          <p className="text-2xl font-bold text-red-600">{fmt(stats.totalOverdue)}</p>
          {stats.overdueCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1">{stats.overdueCount} invoice{stats.overdueCount !== 1 ? 's' : ''}</p>
          )}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Cash Received (This Month)</p>
          <p className="text-2xl font-bold text-emerald-600">{fmt(stats.cashThisMonth)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Avg Days to Pay</p>
          <p className="text-2xl font-bold">{stats.avgDaysToPay}<span className="text-sm font-normal text-muted-foreground ml-1">days</span></p>
        </div>
      </div>

      {/* Aging breakdown */}
      <div className="rounded-lg border">
        <div className="px-4 py-3 border-b">
          <h3 className="font-medium">Aging Breakdown</h3>
        </div>
        <div className="p-4 space-y-3">
          {[
            { label: 'Current (not yet due)', ...agingBuckets.current, color: 'bg-emerald-500', text: 'text-emerald-700' },
            { label: '1–30 days overdue', ...agingBuckets.d1_30, color: 'bg-amber-400', text: 'text-amber-700' },
            { label: '31–60 days overdue', ...agingBuckets.d31_60, color: 'bg-orange-500', text: 'text-orange-700' },
            { label: '60+ days overdue', ...agingBuckets.d60plus, color: 'bg-red-500', text: 'text-red-700' },
          ].map(bucket => {
            const pct = agingTotal > 0 ? (bucket.amount / agingTotal) * 100 : 0
            return (
              <div key={bucket.label} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-36 shrink-0">{bucket.label}</span>
                <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                  {pct > 0 && (
                    <div
                      className={cn('h-full rounded-full transition-all', bucket.color)}
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  )}
                </div>
                <span className={cn('text-sm font-semibold w-28 text-right shrink-0', bucket.text)}>
                  {fmt(bucket.amount)}
                </span>
                <span className="text-xs text-muted-foreground w-20 text-right shrink-0">
                  {bucket.count} inv{bucket.count !== 1 ? 's' : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent activity feed */}
        <div className="rounded-lg border">
          <div className="px-4 py-3 border-b">
            <h3 className="font-medium">Recent Activity</h3>
          </div>
          <div className="divide-y max-h-80 overflow-y-auto">
            {recentAuditLog.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">No recent activity</p>
            ) : (
              recentAuditLog.map((entry, i) => (
                <div key={(entry.id as string) ?? i} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{getAuditDescription(entry)}</p>
                    {entry.details && (
                      <p className="text-xs text-muted-foreground truncate">{String(entry.details)}</p>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                    {formatDate(entry.performed_at as string)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Overdue clients (compact, clickable) */}
        <div className="rounded-lg border">
          <div className="px-4 py-3 border-b bg-red-50">
            <h3 className="font-medium text-red-800">Top Overdue Clients</h3>
          </div>
          <div className="divide-y">
            {overdueClients.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">No overdue invoices</p>
            ) : (
              overdueClients.map(c => (
                <button
                  key={c.id}
                  onClick={() => router.push(`/finance?tab=clients&client=${c.id}`)}
                  className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-red-50/50 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-medium">{c.company_name}</p>
                    <p className="text-xs text-muted-foreground">{c.overdue_count} overdue invoice{c.overdue_count !== 1 ? 's' : ''}</p>
                  </div>
                  <span className="text-sm font-bold text-red-600">{fmt(c.overdue)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
