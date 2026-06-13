import { Building2, Flag, Clock, CalendarClock, UserRound } from 'lucide-react'
import type { WorkspaceServiceDelivery, WorkspaceAccount } from './types'
import { daysSince } from '@/lib/flows/workspace-format'

interface InfoPanelProps {
  serviceDelivery: WorkspaceServiceDelivery
  account: WorkspaceAccount
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</div>
        <div className="text-sm text-zinc-800">{value}</div>
      </div>
    </div>
  )
}

/**
 * Overview card for a flow Workspace: company, current stage, time-in-stage,
 * deadline (if any) and assignee. Pure display — no interactivity.
 */
export function InfoPanel({ serviceDelivery: sd, account }: InfoPanelProps) {
  const days = daysSince(sd.stage_entered_at)
  const stageLabel = sd.stage ?? '—'
  const clientLabel = sd.current_client_label

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-zinc-900 mb-1">Overview</h3>
      <div className="divide-y divide-zinc-100">
        <Row icon={<Building2 className="h-4 w-4" />} label="Company" value={account.company_name ?? '—'} />
        <Row
          icon={<Flag className="h-4 w-4" />}
          label="Current stage"
          value={
            <span>
              {stageLabel}
              {clientLabel && clientLabel !== stageLabel && (
                <span className="text-zinc-400"> · “{clientLabel}”</span>
              )}
            </span>
          }
        />
        <Row
          icon={<Clock className="h-4 w-4" />}
          label="Time in stage"
          value={days === null ? '—' : days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}
        />
        <Row
          icon={<CalendarClock className="h-4 w-4" />}
          label="Deadline"
          value={sd.due_date ?? <span className="text-zinc-400">None</span>}
        />
        <Row
          icon={<UserRound className="h-4 w-4" />}
          label="Assignee"
          value={sd.assigned_to ?? <span className="text-zinc-400">Unassigned</span>}
        />
      </div>
    </div>
  )
}
