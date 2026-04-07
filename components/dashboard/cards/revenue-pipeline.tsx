'use client'

import { useState, useEffect, useCallback } from 'react'
import { DollarSign, TrendingUp, Clock, Loader2, RefreshCw, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RevenueData {
  pendingOffersValue: number
  pendingOffersCount: number
  awaitingPaymentValue: number
  awaitingPaymentCount: number
  awaitingPaymentMaxDays: number
  awaitingPaymentUrgency: 'green' | 'amber' | 'red'
  collectedThisMonth: number
}

function formatUSD(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function getMonthName(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short' })
}

export function RevenuePipelineCard() {
  const [data, setData] = useState<RevenueData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch('/api/crm/operations-pipeline')
      if (!res.ok) return

      const json = await res.json()

      const awaitingPayment = json.pipeline?.awaiting_payment ?? []
      let maxDays = 0
      let worstUrgency: 'green' | 'amber' | 'red' = 'green'
      for (const item of awaitingPayment) {
        if (item.days_since_signed > maxDays) maxDays = item.days_since_signed
        if (item.urgency === 'red') worstUrgency = 'red'
        else if (item.urgency === 'amber' && worstUrgency !== 'red') worstUrgency = 'amber'
      }

      setData({
        pendingOffersValue: json.revenue?.pending_offers_value ?? 0,
        pendingOffersCount: json.counts?.pending_offers ?? 0,
        awaitingPaymentValue: json.revenue?.awaiting_payment_value ?? 0,
        awaitingPaymentCount: json.counts?.awaiting_payment ?? 0,
        awaitingPaymentMaxDays: maxDays,
        awaitingPaymentUrgency: worstUrgency,
        collectedThisMonth: json.revenue?.collected_this_month ?? 0,
      })
    } catch {
      // Non-critical widget
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(() => fetchData(), 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5 animate-pulse">
        <div className="h-4 bg-zinc-100 rounded w-36 mb-4" />
        <div className="space-y-3">
          <div className="h-10 bg-zinc-50 rounded" />
          <div className="h-10 bg-zinc-50 rounded" />
          <div className="h-1 bg-zinc-100 rounded w-full" />
          <div className="h-12 bg-zinc-50 rounded" />
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Revenue Pipeline
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 mb-2 animate-spin" />
          <p className="text-sm">Loading revenue data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <DollarSign className="h-3.5 w-3.5" />
          Revenue Pipeline
        </h3>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>

      <div className="space-y-2">
        {/* Pending Offers */}
        <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-blue-50/60">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-blue-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-900">Pending Offers</p>
              <p className="text-xs text-muted-foreground">
                {data.pendingOffersCount} offer{data.pendingOffersCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <span className="text-sm font-semibold text-blue-700 tabular-nums">
            {formatUSD(data.pendingOffersValue)}
          </span>
        </div>

        {/* Awaiting Payment */}
        <div className={cn(
          'flex items-center justify-between py-2 px-3 rounded-lg',
          data.awaitingPaymentUrgency === 'red' && 'bg-red-50/60',
          data.awaitingPaymentUrgency === 'amber' && 'bg-amber-50/60',
          data.awaitingPaymentUrgency === 'green' && 'bg-zinc-50/60',
        )}>
          <div className="flex items-center gap-2">
            <Clock className={cn(
              'h-4 w-4 shrink-0',
              data.awaitingPaymentUrgency === 'red' && 'text-red-500',
              data.awaitingPaymentUrgency === 'amber' && 'text-amber-500',
              data.awaitingPaymentUrgency === 'green' && 'text-zinc-400',
            )} />
            <div>
              <p className="text-sm font-medium text-zinc-900">Awaiting Payment</p>
              <p className="text-xs text-muted-foreground">
                {data.awaitingPaymentCount} signed
                {data.awaitingPaymentMaxDays > 0 && (
                  <span className={cn(
                    'ml-1',
                    data.awaitingPaymentUrgency === 'red' && 'text-red-600 font-medium',
                    data.awaitingPaymentUrgency === 'amber' && 'text-amber-600 font-medium',
                  )}>
                    &middot; {data.awaitingPaymentMaxDays}d
                  </span>
                )}
              </p>
            </div>
          </div>
          <span className={cn(
            'text-sm font-semibold tabular-nums',
            data.awaitingPaymentUrgency === 'red' && 'text-red-700',
            data.awaitingPaymentUrgency === 'amber' && 'text-amber-700',
            data.awaitingPaymentUrgency === 'green' && 'text-zinc-700',
          )}>
            {formatUSD(data.awaitingPaymentValue)}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div className="my-3 border-t" />

      {/* Collected This Month */}
      <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-emerald-50/60">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-zinc-900">Collected ({getMonthName()})</p>
          </div>
        </div>
        <span className="text-lg font-bold text-emerald-700 tabular-nums">
          {formatUSD(data.collectedThisMonth)}
        </span>
      </div>
    </div>
  )
}
