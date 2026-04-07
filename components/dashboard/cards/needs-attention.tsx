'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Clock,
  CreditCard,
  Cog,
  DollarSign,
  MessageSquare,
  Calendar,
  Tag,
  UserPlus,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import type { AttentionItem } from '@/app/api/crm/dashboard-attention/route'

const TYPE_CONFIG: Record<AttentionItem['type'], { icon: React.ElementType; label: string }> = {
  awaiting_payment: { icon: Clock, label: 'Payment' },
  ready_to_onboard: { icon: Cog, label: 'Onboard' },
  overdue_invoice: { icon: CreditCard, label: 'Overdue' },
  stuck_service: { icon: AlertTriangle, label: 'Stuck' },
  unmatched_payment: { icon: DollarSign, label: 'Unmatched' },
  unanswered_message: { icon: MessageSquare, label: 'Message' },
  deadline: { icon: Calendar, label: 'Deadline' },
  action_item: { icon: Tag, label: 'Action' },
  lead_followup: { icon: UserPlus, label: 'Lead' },
}

const URGENCY_STYLES = {
  red: { bg: 'bg-red-50', text: 'text-red-600', dot: 'bg-red-500' },
  amber: { bg: 'bg-amber-50', text: 'text-amber-600', dot: 'bg-amber-500' },
  green: { bg: 'bg-emerald-50', text: 'text-emerald-600', dot: 'bg-emerald-500' },
}

export function NeedsAttentionCard() {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<AttentionItem['type'] | 'all'>('all')

  const fetchItems = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch('/api/crm/dashboard-attention')
      if (!res.ok) return
      const data = await res.json()
      setItems(data.items ?? [])
    } catch {
      // Non-critical widget
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchItems()
    // Auto-refresh every 60 seconds
    const interval = setInterval(() => fetchItems(), 60_000)
    return () => clearInterval(interval)
  }, [fetchItems])

  const filtered = filter === 'all' ? items : items.filter(i => i.type === filter)

  // Count by type for filter badges
  const typeCounts = items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const activeTypes = Object.keys(typeCounts) as AttentionItem['type'][]

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5 animate-pulse">
        <div className="h-4 bg-zinc-100 rounded w-40 mb-4" />
        <div className="space-y-3">
          <div className="h-12 bg-zinc-50 rounded" />
          <div className="h-12 bg-zinc-50 rounded" />
          <div className="h-12 bg-zinc-50 rounded" />
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Needs Attention
        </h3>
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <CheckCircle2 className="h-10 w-10 mb-2 text-emerald-400" />
          <p className="text-sm font-medium">All clear</p>
          <p className="text-xs text-zinc-400 mt-1">No items need attention right now</p>
        </div>
      </div>
    )
  }

  const redCount = items.filter(i => i.urgency === 'red').length
  const amberCount = items.filter(i => i.urgency === 'amber').length

  return (
    <div className="bg-white rounded-lg border p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Needs Attention
          </h3>
          <div className="flex items-center gap-1">
            {redCount > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                {redCount}
              </span>
            )}
            {amberCount > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                {amberCount}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => fetchItems(true)}
          disabled={refreshing}
          className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-colors"
          title="Refresh"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Type filters */}
      {activeTypes.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-3">
          <button
            onClick={() => setFilter('all')}
            className={`text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors ${
              filter === 'all'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            All ({items.length})
          </button>
          {activeTypes.map(type => {
            const cfg = TYPE_CONFIG[type]
            return (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={`text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors ${
                  filter === type
                    ? 'bg-zinc-900 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {cfg.label} ({typeCounts[type]})
              </button>
            )
          })}
        </div>
      )}

      {/* Items list */}
      <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
        {filtered.map(item => {
          const cfg = TYPE_CONFIG[item.type]
          const urgency = URGENCY_STYLES[item.urgency]
          const Icon = cfg.icon

          return (
            <Link
              key={item.id}
              href={item.link}
              className={`flex items-start gap-3 p-2.5 rounded-lg hover:bg-zinc-50 transition-colors -mx-1 group`}
            >
              <div className={`flex items-center justify-center h-7 w-7 rounded-full shrink-0 ${urgency.bg}`}>
                <Icon className={`h-3.5 w-3.5 ${urgency.text}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900 truncate">{item.title}</p>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${urgency.bg} ${urgency.text}`}>
                    {item.age}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 truncate mt-0.5">{item.subtitle}</p>
              </div>
              <div className={`h-2 w-2 rounded-full shrink-0 mt-2 ${urgency.dot}`} />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
