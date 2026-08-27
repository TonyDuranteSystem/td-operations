'use client'

import { useState } from 'react'
import { Loader2, FileText, RefreshCw, Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { FastTooltip } from '@/components/ui/fast-tooltip'

export interface FaxHistoryRow {
  id: string
  createdAt: string | null
  faxno: string
  recipName: string | null
  reason: string | null
  fileName: string
  jobId: string | null
  /** Send-time outcome recorded in action_log ('submitted' once accepted). */
  source: string | null
  /** documents.id of the original file, when the fax was sent from a stored
   *  document; null for ad-hoc uploads (no persisted file to view). */
  documentId: string | null
  /** Live delivery status persisted from a prior "Check status" (action_log
   *  details.fax_status). Shown on load; null when never checked. */
  savedStatus: {
    status: 'delivered' | 'pending' | 'failed' | 'unknown'
    pages: string | null
    xmitTime: string | null
    completeTime: string | null
  } | null
}

type LiveStatus = 'delivered' | 'pending' | 'failed' | 'unknown'

interface StatusState {
  loading: boolean
  status?: LiveStatus
  pages?: string
  xmitTime?: string
  completeTime?: string
  error?: string
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

const STATUS_STYLES: Record<LiveStatus, string> = {
  delivered: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  unknown: 'bg-zinc-100 text-zinc-600',
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  delivered: 'Delivered',
  pending: 'Pending',
  failed: 'Failed',
  unknown: 'Unknown',
}

export function FaxHistoryTable({ rows }: { rows: FaxHistoryRow[] }) {
  // Seed from persisted statuses so previously-checked faxes show their status
  // on load without re-clicking.
  const [statuses, setStatuses] = useState<Record<string, StatusState>>(() => {
    const seed: Record<string, StatusState> = {}
    for (const r of rows) {
      if (r.jobId && r.savedStatus) {
        seed[r.jobId] = {
          loading: false,
          status: r.savedStatus.status,
          pages: r.savedStatus.pages ?? undefined,
          xmitTime: r.savedStatus.xmitTime ?? undefined,
          completeTime: r.savedStatus.completeTime ?? undefined,
        }
      }
    }
    return seed
  })

  const checkStatus = async (jobId: string) => {
    setStatuses(prev => ({ ...prev, [jobId]: { loading: true } }))
    try {
      const res = await fetch(`/api/tools/fax/status?jobId=${encodeURIComponent(jobId)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not check status.')
      const rec = Array.isArray(data.records) ? data.records[0] : undefined
      if (!rec) {
        setStatuses(prev => ({ ...prev, [jobId]: { loading: false, status: 'unknown' } }))
        toast.message('No status record yet for this job.')
        return
      }
      setStatuses(prev => ({
        ...prev,
        [jobId]: {
          loading: false,
          status: rec.status as LiveStatus,
          pages: rec.pageCount,
          xmitTime: rec.xmitTime,
          completeTime: rec.completeTime,
        },
      }))
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Could not check status.'
      setStatuses(prev => ({ ...prev, [jobId]: { loading: false, error: message } }))
      toast.error(message)
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-white p-10 text-center text-sm text-muted-foreground">
        No faxes have been sent yet. Sent faxes will appear here.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Recipient</th>
            <th className="px-4 py-3 font-medium">Document</th>
            <th className="px-4 py-3 font-medium">Reason</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium text-right">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const st = row.jobId ? statuses[row.jobId] : undefined
            return (
              <tr key={row.id} className="border-b last:border-0 hover:bg-zinc-50/60">
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700">{fmtDate(row.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-800">{row.recipName || '—'}</div>
                  <div className="text-xs text-zinc-500 font-mono">{row.faxno}</div>
                </td>
                <td className="px-4 py-3">
                  {row.documentId ? (
                    <FastTooltip label="Open the original document that was faxed">
                      <a
                        href={`/api/documents/${encodeURIComponent(row.documentId)}/preview`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open the original document that was faxed"
                        className="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate max-w-[160px]">{row.fileName}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                      </a>
                    </FastTooltip>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-zinc-700" title="Uploaded file — not stored, nothing to view">
                      <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      <span className="truncate max-w-[160px]">{row.fileName}</span>
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="block max-w-[160px] truncate text-zinc-700" title={row.reason || undefined}>
                    {row.reason || <span className="text-zinc-400">—</span>}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {(() => {
                    // Terminal (delivered/failed) = settled → show the badge, no
                    // button. Pending or never-checked → keep the button so staff
                    // can (re-)check; pending also shows its current badge.
                    const isTerminal = st?.status === 'delivered' || st?.status === 'failed'
                    const meta = st && (st.pages || st.xmitTime) ? (
                      <div className="text-[11px] text-zinc-400">
                        {st.pages ? `${st.pages} pg` : ''}{st.pages && st.xmitTime ? ' · ' : ''}{st.xmitTime || ''}
                      </div>
                    ) : null

                    if (isTerminal && st?.status) {
                      return (
                        <div className="space-y-0.5">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[st.status]}`}>
                            {STATUS_LABEL[st.status]}
                          </span>
                          {meta}
                        </div>
                      )
                    }
                    if (!row.jobId) {
                      return <span className="text-xs text-zinc-400">Submitted</span>
                    }
                    return (
                      <div className="space-y-1">
                        {st?.status === 'pending' && (
                          <div className="space-y-0.5">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES.pending}`}>
                              {STATUS_LABEL.pending}
                            </span>
                            {meta}
                          </div>
                        )}
                        <button
                          onClick={() => checkStatus(row.jobId as string)}
                          disabled={st?.loading}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          {st?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          {st?.status === 'pending' ? 'Re-check' : 'Check status'}
                        </button>
                      </div>
                    )
                  })()}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.jobId ? (
                    <a
                      href={`/api/tools/fax/receipt/${encodeURIComponent(row.jobId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50"
                    >
                      <Download className="h-3 w-3" /> Receipt
                    </a>
                  ) : (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
