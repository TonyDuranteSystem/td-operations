'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ClipboardList } from 'lucide-react'
import { packageLabel, subjectTypeLabel } from '@/lib/td-communication/pipeline'
import type { CommEnrollment, EnrollmentStats, EnrollmentStatus } from '@/lib/td-communication/types'

const STATUS_LABELS: Record<string, string> = {
  enrolled: 'Package Selected',
  form_submitted: 'Form Submitted',
  in_progress: 'In Progress',
  concept_ready: 'Ready for Review',
  approved: 'Approved',
  revision: 'Revision',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}
const STATUSES = Object.keys(STATUS_LABELS) as EnrollmentStatus[]

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function EnrollmentsAdmin({ onSelect }: { onSelect: (id: string) => void }) {
  const [enrollments, setEnrollments] = useState<CommEnrollment[]>([])
  const [stats, setStats] = useState<EnrollmentStats | null>(null)
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (statusFilter: string) => {
    setLoading(true)
    try {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
      const res = await fetch(`/api/td-communication/admin/enrollments${qs}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load enrollments.')
      }
      const data = await res.json()
      setEnrollments(Array.isArray(data.enrollments) ? data.enrollments : [])
      setStats(data.stats ?? null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load enrollments.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(status) }, [load, status])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Stats */}
      <div className="flex flex-wrap items-center gap-2 mb-3 shrink-0">
        <StatChip label="Total" value={stats ? String(stats.total) : '—'} tone="zinc" />
        <StatChip
          label="Avg delivery"
          value={stats?.avgDeliveryDays != null ? `${stats.avgDeliveryDays}d` : '—'}
          tone="blue"
        />
        {stats && STATUSES.filter((s) => stats.byStatus[s]).map((s) => (
          <StatChip key={s} label={STATUS_LABELS[s]} value={String(stats.byStatus[s])} tone="zinc" />
        ))}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <label className="text-xs font-medium text-gray-600">Status</label>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
      ) : enrollments.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center">
          <div><ClipboardList className="h-10 w-10 text-zinc-300 mx-auto mb-3" /><p className="text-sm text-zinc-500">No enrollments{status ? ' with this status' : ''}.</p></div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Client</th>
                <th className="text-left px-3 py-2 font-medium">Package</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Submitted</th>
                <th className="text-left px-3 py-2 font-medium">Deadline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {enrollments.map((e) => (
                <tr key={e.id} onClick={() => onSelect(e.id)} className="hover:bg-blue-50 cursor-pointer">
                  <td className="px-3 py-2">
                    <span className="font-medium text-zinc-900">{e.subject.name}</span>
                    <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-zinc-50 text-zinc-600 border-zinc-200">
                      {subjectTypeLabel(e.subject.type)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-700">{packageLabel(e.package_slug)}</td>
                  <td className="px-3 py-2 text-zinc-700">{STATUS_LABELS[e.status] ?? e.status}</td>
                  <td className="px-3 py-2 text-zinc-700">{fmtDate(e.created_at)}</td>
                  <td className="px-3 py-2 text-zinc-700">{fmtDate(e.deadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatChip({ label, value, tone }: { label: string; value: string; tone: 'zinc' | 'blue' }) {
  const toneClass = tone === 'blue' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-zinc-700 border-zinc-200'
  return (
    <div className={`inline-flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1 ${toneClass}`}>
      <span className="text-sm font-semibold">{value}</span>
      <span className="text-[11px] text-zinc-500">{label}</span>
    </div>
  )
}
