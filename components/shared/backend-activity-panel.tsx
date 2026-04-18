'use client'

/**
 * P3.8 — Per-record backend activity panel.
 *
 * Read-only timeline of what the system has been doing for this account or
 * contact: CRM actions, background jobs, webhook events, session checkpoints.
 * Lazy-loaded on mount via server action — no data fetches until the operator
 * opens the "Backend" tab.
 */

import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Webhook,
  Zap,
  FileSearch,
} from 'lucide-react'
import type {
  BackendActivity,
  BackendActionRow,
  BackendJobRow,
  BackendWebhookRow,
  BackendCheckpointRow,
} from '@/lib/per-record-activity/queries'
import {
  fetchAccountBackendActivity,
  fetchContactBackendActivity,
} from '@/app/(dashboard)/shared/backend-activity-action'

type Props =
  | { kind: 'account'; accountId: string }
  | { kind: 'contact'; contactId: string; email?: string | null }

export function BackendActivityPanel(props: Props) {
  const [activity, setActivity] = useState<BackendActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const result = props.kind === 'account'
      ? await fetchAccountBackendActivity(props.accountId)
      : await fetchContactBackendActivity(props.contactId, props.email ?? null)
    if (result.success === true) {
      setActivity(result.activity)
    } else {
      setError(result.error ?? 'Failed to load activity')
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props are stable within this mount
  }, [])

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-500" />
            Backend activity
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Read-only surface of CRM actions, background jobs, webhooks, and session checkpoints that touched this record.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {loading && !activity && (
        <div className="flex items-center justify-center py-12 text-sm text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading activity...
        </div>
      )}

      {activity && (
        <div className="space-y-3">
          <Section
            title="CRM actions"
            subtitle="action_log"
            icon={CheckCircle2}
            color="text-emerald-600"
            emptyLabel="No CRM actions recorded for this record."
            rows={activity.actions}
            renderRow={(row) => <ActionRow key={row.id} row={row} />}
            defaultOpen
          />
          <Section
            title="Background jobs"
            subtitle="job_queue"
            icon={Zap}
            color="text-amber-600"
            emptyLabel="No background jobs for this record."
            rows={activity.jobs}
            renderRow={(row) => <JobRow key={row.id} row={row} />}
          />
          <Section
            title="Webhook events"
            subtitle="webhook_events"
            icon={Webhook}
            color="text-violet-600"
            emptyLabel="No webhook events mentioning this record."
            rows={activity.webhooks}
            renderRow={(row) => <WebhookRow key={row.id} row={row} />}
          />
          <Section
            title="Session checkpoints"
            subtitle="session_checkpoints"
            icon={FileSearch}
            color="text-blue-600"
            emptyLabel="No session checkpoints mentioning this record."
            rows={activity.checkpoints}
            renderRow={(row) => <CheckpointRow key={row.id} row={row} />}
          />
        </div>
      )}
    </div>
  )
}

// ── Section shell ─────────────────────────────────────────────

function Section<T>({
  title,
  subtitle,
  icon: Icon,
  color,
  rows,
  renderRow,
  emptyLabel,
  defaultOpen = false,
}: {
  title: string
  subtitle: string
  icon: typeof Activity
  color: string
  rows: T[]
  renderRow: (row: T) => React.ReactNode
  emptyLabel: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border rounded-lg bg-white">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-zinc-50"
      >
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${color}`} />
          <span className="text-sm font-semibold text-zinc-800">{title}</span>
          <span className="text-xs text-zinc-400 font-mono">{subtitle}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
            {rows.length}
          </span>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
      </button>
      {open && (
        <div className="border-t">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-zinc-500">{emptyLabel}</div>
          ) : (
            <div className="divide-y">
              {rows.map(renderRow)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Row renderers ─────────────────────────────────────────────

function ageLabel(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

function ActionRow({ row }: { row: BackendActionRow }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700">
              {row.action_type}
            </span>
            <span className="text-xs font-mono text-zinc-500">{row.table_name}</span>
            <span className="text-xs text-zinc-400">by {row.actor ?? 'unknown'}</span>
          </div>
          <div className="mt-1 text-sm text-zinc-800">{row.summary}</div>
        </div>
        <span className="text-xs text-zinc-400 shrink-0">{ageLabel(row.created_at)}</span>
      </div>
    </div>
  )
}

function JobRow({ row }: { row: BackendJobRow }) {
  const toneClass =
    row.status === 'completed' ? 'bg-emerald-100 text-emerald-700'
    : row.status === 'failed' ? 'bg-red-100 text-red-700'
    : row.status === 'pending' ? 'bg-amber-100 text-amber-700'
    : 'bg-zinc-100 text-zinc-700'

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-800">{row.job_type}</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${toneClass}`}>
              {row.status}
            </span>
            {row.attempts !== null && row.attempts > 1 && (
              <span className="text-xs text-zinc-500">
                {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {row.error && (
            <div className="mt-1 text-xs text-red-600 truncate">{row.error}</div>
          )}
        </div>
        <span className="text-xs text-zinc-400 shrink-0">{ageLabel(row.created_at)}</span>
      </div>
    </div>
  )
}

function WebhookRow({ row }: { row: BackendWebhookRow }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
              {row.source}
            </span>
            <span className="text-sm text-zinc-800">{row.event_type}</span>
            {row.review_status && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
                {row.review_status}
              </span>
            )}
          </div>
          {row.external_id && (
            <div className="mt-0.5 text-xs font-mono text-zinc-500 truncate">{row.external_id}</div>
          )}
        </div>
        <span className="text-xs text-zinc-400 shrink-0">{ageLabel(row.created_at)}</span>
      </div>
    </div>
  )
}

function CheckpointRow({ row }: { row: BackendCheckpointRow }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {row.session_type && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                {row.session_type}
              </span>
            )}
          </div>
          <div className="mt-1 text-sm text-zinc-800 line-clamp-3">{row.summary}</div>
          {row.next_steps && (
            <div className="mt-1 text-xs text-zinc-500 line-clamp-2">
              <span className="font-medium">Next:</span> {row.next_steps}
            </div>
          )}
        </div>
        <span className="text-xs text-zinc-400 shrink-0">{ageLabel(row.created_at)}</span>
      </div>
    </div>
  )
}
