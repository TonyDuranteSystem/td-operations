'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { GitBranch, Loader2, RefreshCw, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface OfferItem {
  token: string
  client_name: string
  status: string
  contract_type: string | null
  account_id: string | null
  lead_id: string | null
  days_in_stage: number
  value: number
}

interface SignedItem {
  offer_token: string
  client_name: string
  contract_type: string | null
  signed_at: string
  days_since_signed: number
  value: number
  urgency: string
}

interface PaidItem {
  offer_token: string
  client_name: string
  payment_confirmed_at: string
  payment_method: string | null
  days_since_paid: number
  urgency: string
}

interface OnboardingItem {
  account_id: string
  company_name: string
  services: Array<{ service_name: string | null; stage: string | null }>
}

interface InServiceItem {
  account_id: string
  company_name: string
  services: Array<{ service_name: string | null; stage: string | null; days_in_stage: number }>
}

interface PipelineData {
  pipeline: {
    pending_offers: OfferItem[]
    awaiting_payment: SignedItem[]
    awaiting_activation: PaidItem[]
    onboarding: OnboardingItem[]
    in_service: InServiceItem[]
  }
  counts: Record<string, number>
  revenue: {
    pending_offers_value: number
    awaiting_payment_value: number
    collected_this_month: number
  }
}

interface StageConfig {
  key: keyof PipelineData['pipeline']
  label: string
  color: string
  badgeBg: string
  badgeText: string
  dotColor: string
}

const STAGES: StageConfig[] = [
  {
    key: 'pending_offers',
    label: 'Offers',
    color: 'border-blue-200',
    badgeBg: 'bg-blue-100',
    badgeText: 'text-blue-700',
    dotColor: 'bg-blue-500',
  },
  {
    key: 'awaiting_payment',
    label: 'Signed',
    color: 'border-indigo-200',
    badgeBg: 'bg-indigo-100',
    badgeText: 'text-indigo-700',
    dotColor: 'bg-indigo-500',
  },
  {
    key: 'awaiting_activation',
    label: 'Paid',
    color: 'border-violet-200',
    badgeBg: 'bg-violet-100',
    badgeText: 'text-violet-700',
    dotColor: 'bg-violet-500',
  },
  {
    key: 'onboarding',
    label: 'Onboarding',
    color: 'border-amber-200',
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-700',
    dotColor: 'bg-amber-500',
  },
  {
    key: 'in_service',
    label: 'In Service',
    color: 'border-emerald-200',
    badgeBg: 'bg-emerald-100',
    badgeText: 'text-emerald-700',
    dotColor: 'bg-emerald-500',
  },
]

function UrgencyDot({ urgency }: { urgency: string }) {
  if (urgency === 'red') {
    return <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" title="Urgent" />
  }
  if (urgency === 'amber') {
    return <span className="inline-block w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" title="Needs attention" />
  }
  return null
}

function getItemLink(item: OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem): string {
  if ('account_id' in item && item.account_id) {
    return `/accounts/${item.account_id}`
  }
  if ('lead_id' in item && item.lead_id) {
    return `/leads/${item.lead_id}`
  }
  return '#'
}

function getItemName(item: OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem): string {
  if ('client_name' in item) return item.client_name
  if ('company_name' in item) return item.company_name
  return 'Unknown'
}

function getItemSubtext(item: OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem): string {
  if ('days_in_stage' in item && 'status' in item) {
    return `${item.days_in_stage}d ${item.status}`
  }
  if ('days_since_signed' in item) {
    return `${item.days_since_signed}d`
  }
  if ('days_since_paid' in item) {
    return `${item.days_since_paid}d`
  }
  if ('services' in item && item.services.length > 0) {
    const first = item.services[0]
    return first.stage ?? first.service_name ?? ''
  }
  return ''
}

function getItemUrgency(item: OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem): string | null {
  if ('urgency' in item) return item.urgency as string
  return null
}

function StageColumn({ stage, items }: { stage: StageConfig; items: Array<OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem> }) {
  const [expanded, setExpanded] = useState(false)
  const count = items.length
  const visibleItems = expanded ? items : items.slice(0, 3)
  const hiddenCount = count - 3

  return (
    <div className={cn('flex flex-col border rounded-lg p-3 min-w-[140px] flex-1', stage.color)}>
      <div className="flex flex-col items-center gap-1 mb-3">
        <span className={cn('text-lg font-semibold rounded-full w-8 h-8 flex items-center justify-center', stage.badgeBg, stage.badgeText)}>
          {count}
        </span>
        <span className="text-xs font-medium text-zinc-600">{stage.label}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {visibleItems.map((item, idx) => {
          const link = getItemLink(item)
          const name = getItemName(item)
          const subtext = getItemSubtext(item)
          const urgency = getItemUrgency(item)

          return (
            <Link
              key={`${stage.key}-${idx}`}
              href={link}
              className="group flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-zinc-50 transition-colors"
            >
              <span className={cn('mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0', stage.dotColor)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-medium text-zinc-800 truncate group-hover:text-zinc-950">
                    {name}
                  </span>
                  {urgency ? <UrgencyDot urgency={urgency} /> : null}
                </div>
                {subtext ? (
                  <span className="text-[10px] text-zinc-400 leading-tight">{subtext}</span>
                ) : null}
              </div>
            </Link>
          )
        })}
      </div>

      {hiddenCount > 0 ? (
        <button
          onClick={() => setExpanded(prev => !prev)}
          className="mt-2 flex items-center justify-center gap-0.5 text-[10px] text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          {expanded ? (
            <>Show less <ChevronUp className="w-3 h-3" /></>
          ) : (
            <>+{hiddenCount} more <ChevronDown className="w-3 h-3" /></>
          )}
        </button>
      ) : null}
    </div>
  )
}

export function OperationsPipelineCard() {
  const [data, setData] = useState<PipelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch('/api/crm/operations-pipeline')
      if (!res.ok) throw new Error('Failed to fetch')
      const json = await res.json()
      setData(json)
      setError(false)
    } catch {
      setError(true)
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
        <div className="h-4 bg-zinc-100 rounded w-44 mb-4" />
        <div className="flex gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-1 h-32 bg-zinc-50 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center gap-2 mb-4">
          <GitBranch className="w-4 h-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-800">Operations Pipeline</h3>
        </div>
        <div className="flex flex-col items-center gap-2 py-6 text-zinc-400">
          <AlertCircle className="w-5 h-5" />
          <span className="text-xs">Failed to load pipeline</span>
          <button
            onClick={() => { setLoading(true); setError(false); fetchData() }}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const { pipeline } = data
  const totalCount = Object.values(data.counts).reduce((sum, c) => sum + c, 0)
  const allEmpty = totalCount === 0

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-800">Operations Pipeline</h3>
          <span className="text-xs text-zinc-400">{totalCount} active</span>
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="text-zinc-400 hover:text-zinc-600 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          {refreshing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {allEmpty ? (
        <div className="flex items-center justify-center py-8 text-zinc-400">
          <span className="text-xs">All clear — no active pipeline items</span>
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto">
          {STAGES.map(stage => (
            <StageColumn
              key={stage.key}
              stage={stage}
              items={pipeline[stage.key] as Array<OfferItem | SignedItem | PaidItem | OnboardingItem | InServiceItem>}
            />
          ))}
        </div>
      )}
    </div>
  )
}
