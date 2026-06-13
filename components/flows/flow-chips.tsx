'use client'

import Link from 'next/link'
import { FileText, Landmark, ShieldCheck, Mailbox, ChevronRight, CalendarClock } from 'lucide-react'
import type { ResolvedFlow, FlowType } from '@/lib/flows/resolve-flows'

const FLOW_ICON: Record<FlowType, React.ComponentType<{ className?: string }>> = {
  'Tax Return': FileText,
  'State Annual Report': Landmark,
  'State RA Renewal': ShieldCheck,
  'CMRA Mailing Address': Mailbox,
}

interface FlowChipsProps {
  flows: ResolvedFlow[]
}

/**
 * Compact cards for an account's flows (the staff Annual-Cycle entry point).
 * Live flows link to their Workspace; date-derived "scheduled" placeholders show
 * the upcoming due date but have no Workspace yet (no SD).
 */
export function FlowChips({ flows }: FlowChipsProps) {
  if (flows.length === 0) return null

  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900 mb-2">Flows</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {flows.map((flow, idx) => {
          const Icon = FLOW_ICON[flow.flow_type] ?? FileText
          const isScheduled = flow.status === 'scheduled' || !flow.service_delivery_id
          const stageLine = isScheduled
            ? flow.due_date
              ? `Due ${flow.due_date}`
              : 'Scheduled'
            : (flow.stage_name ?? '—')

          const card = (
            <div
              className={`h-full rounded-xl border bg-white p-3 transition-colors ${
                isScheduled
                  ? 'border-zinc-200'
                  : 'border-zinc-200 hover:border-blue-300 hover:bg-blue-50/40'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
                  <span className="text-sm font-medium text-zinc-900 truncate">
                    {flow.flow_type}
                    {flow.year ? ` ${flow.year}` : ''}
                  </span>
                </div>
                {!isScheduled && <ChevronRight className="h-4 w-4 text-zinc-300 shrink-0" />}
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                {isScheduled && <CalendarClock className="h-3 w-3" />}
                <span className="truncate">{stageLine}</span>
              </div>
              {isScheduled && (
                <span className="mt-2 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 border border-amber-200">
                  Scheduled · no workspace yet
                </span>
              )}
            </div>
          )

          return isScheduled ? (
            <div key={`${flow.flow_type}-${idx}`}>{card}</div>
          ) : (
            <Link key={`${flow.flow_type}-${idx}`} href={`/flows/${flow.service_delivery_id}`} className="block">
              {card}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
