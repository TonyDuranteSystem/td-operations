'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Users, CheckCircle2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

const FORMATION_STAGES = [
  'New',
  'Data Collection',
  'State Filing',
  'Articles Ready',
  'Articles Filed',
  'EIN Application',
  'EIN Submitted',
  'Post-Formation',
  'Closing',
]

const ONBOARDING_STAGES = [
  'New',
  'Data Collection',
  'Setup',
  'Active',
]

interface OnboardingItem {
  id: string
  name: string
  link: string
  stage: string
  pipeline: string
  serviceName: string
  stageIndex: number
  totalStages: number
  daysInStage: number
  urgency: 'green' | 'amber' | 'red'
}

interface PipelineResponse {
  pipeline: {
    pending_offers: Array<{
      token: string
      client_name: string
      status: string
      contract_type: string | null
      account_id: string | null
      lead_id: string | null
      days_in_stage: number
    }>
    awaiting_payment: Array<{
      offer_token: string
      client_name: string
      contract_type: string | null
      days_since_signed: number
      urgency: string
    }>
    awaiting_activation: Array<{
      offer_token: string
      client_name: string
      days_since_paid: number
      urgency: string
    }>
    onboarding: Array<{
      account_id: string
      company_name: string
      services: Array<{ service_name: string | null; stage: string | null }>
    }>
    in_service: Array<{
      account_id: string
      company_name: string
      services: Array<{ service_name: string | null; stage: string | null; days_in_stage: number }>
    }>
  }
}

function getStageInfo(stage: string | null, pipeline: string | null): { index: number; total: number; stages: string[] } {
  const stageStr = stage ?? 'New'

  if (pipeline === 'formation' || pipeline === 'Company Formation') {
    const idx = FORMATION_STAGES.indexOf(stageStr)
    return { index: idx >= 0 ? idx : 0, total: FORMATION_STAGES.length, stages: FORMATION_STAGES }
  }

  const idx = ONBOARDING_STAGES.indexOf(stageStr)
  return { index: idx >= 0 ? idx : 0, total: ONBOARDING_STAGES.length, stages: ONBOARDING_STAGES }
}

function getUrgency(days: number): 'green' | 'amber' | 'red' {
  if (days > 10) return 'red'
  if (days > 5) return 'amber'
  return 'green'
}

function formatDays(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return '1d'
  return `${days}d`
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  const maxDots = Math.min(total, 7)
  const scaledCurrent = total > 7 ? Math.round((current / total) * maxDots) : current

  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: maxDots }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'inline-block w-1.5 h-1.5 rounded-full',
            i <= scaledCurrent ? 'bg-blue-500' : 'bg-zinc-200'
          )}
        />
      ))}
    </span>
  )
}

export function ActiveOnboardingsCard() {
  const [items, setItems] = useState<OnboardingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch('/api/crm/operations-pipeline')
      if (!res.ok) return
      const data: PipelineResponse = await res.json()
      const combined: OnboardingItem[] = []

      // Awaiting activation items
      for (const item of data.pipeline.awaiting_activation) {
        combined.push({
          id: `activation-${item.offer_token}`,
          name: item.client_name,
          link: '#',
          stage: 'Awaiting Activation',
          pipeline: 'activation',
          serviceName: 'Activation',
          stageIndex: 0,
          totalStages: 1,
          daysInStage: item.days_since_paid,
          urgency: item.urgency === 'red' ? 'red' : 'green',
        })
      }

      // Awaiting payment items
      for (const item of data.pipeline.awaiting_payment) {
        combined.push({
          id: `payment-${item.offer_token}`,
          name: item.client_name,
          link: '#',
          stage: 'Awaiting Payment',
          pipeline: item.contract_type ?? 'onboarding',
          serviceName: item.contract_type ?? 'Onboarding',
          stageIndex: 0,
          totalStages: 2,
          daysInStage: item.days_since_signed,
          urgency: item.urgency === 'red' ? 'red' : item.urgency === 'amber' ? 'amber' : 'green',
        })
      }

      // Onboarding stage items (early-stage service deliveries)
      for (const acct of data.pipeline.onboarding) {
        for (const svc of acct.services) {
          const info = getStageInfo(svc.stage, null)
          combined.push({
            id: `onb-${acct.account_id}-${svc.service_name}`,
            name: acct.company_name,
            link: `/accounts/${acct.account_id}`,
            stage: svc.stage ?? 'New',
            pipeline: 'onboarding',
            serviceName: svc.service_name ?? 'Service',
            stageIndex: info.index,
            totalStages: info.total,
            daysInStage: 0,
            urgency: 'green',
          })
        }
      }

      // In-service items in early formation stages
      for (const acct of data.pipeline.in_service) {
        for (const svc of acct.services) {
          const isEarlyFormation = FORMATION_STAGES.slice(0, 7).includes(svc.stage ?? '')
          if (!isEarlyFormation) continue

          const info = getStageInfo(svc.stage, 'formation')
          combined.push({
            id: `svc-${acct.account_id}-${svc.service_name}`,
            name: acct.company_name,
            link: `/accounts/${acct.account_id}`,
            stage: svc.stage ?? 'Unknown',
            pipeline: 'formation',
            serviceName: svc.service_name ?? 'Formation',
            stageIndex: info.index,
            totalStages: info.total,
            daysInStage: svc.days_in_stage,
            urgency: getUrgency(svc.days_in_stage),
          })
        }
      }

      // Sort: red first, then amber, then green; within same urgency, most stale first
      const urgencyOrder = { red: 0, amber: 1, green: 2 }
      combined.sort((a, b) => {
        const urgDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
        if (urgDiff !== 0) return urgDiff
        return b.daysInStage - a.daysInStage
      })

      setItems(combined.slice(0, 8))
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
        <div className="h-4 bg-zinc-100 rounded w-44 mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="space-y-1.5">
              <div className="h-3.5 bg-zinc-100 rounded w-3/4" />
              <div className="h-3 bg-zinc-50 rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Active Onboardings
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">No active onboardings</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Active Onboardings
        </h3>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>

      <div className="space-y-1">
        {items.map(item => {
          const className = cn(
            'flex items-center gap-3 py-2 px-3 rounded-lg text-sm transition-colors',
            item.link !== '#' && 'hover:bg-zinc-50 cursor-pointer',
            item.urgency === 'red' && 'bg-red-50/60',
            item.urgency === 'amber' && 'bg-amber-50/60',
            item.urgency === 'green' && 'bg-zinc-50/40',
          )

          const content = (
            <>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm truncate">{item.name}</p>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <ProgressDots current={item.stageIndex} total={item.totalStages} />
                  <span className="text-xs text-muted-foreground truncate">{item.stage}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{item.serviceName}</p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <span className={cn(
                  'text-xs font-medium tabular-nums',
                  item.urgency === 'red' && 'text-red-600',
                  item.urgency === 'amber' && 'text-amber-600',
                  item.urgency === 'green' && 'text-muted-foreground',
                )}>
                  {formatDays(item.daysInStage)}
                </span>
                {item.urgency !== 'green' && (
                  <span className={cn(
                    'inline-block w-1.5 h-1.5 rounded-full',
                    item.urgency === 'red' ? 'bg-red-500' : 'bg-amber-500'
                  )} />
                )}
              </div>
            </>
          )

          return item.link !== '#' ? (
            <Link key={item.id} href={item.link} className={className}>
              {content}
            </Link>
          ) : (
            <div key={item.id} className={className}>
              {content}
            </div>
          )
        })}
      </div>

      <div className="mt-3 pt-2 border-t text-xs text-muted-foreground text-center">
        {items.length} active onboarding{items.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}
