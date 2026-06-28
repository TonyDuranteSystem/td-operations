'use client'

import { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { Clock, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PIPELINE_COLUMNS,
  statusToColumn,
  slaIndicator,
  SLA_DOT,
  deadlineLabel,
  packageLabel,
  subjectTypeLabel,
  type PipelineColumnKey,
} from '@/lib/td-communication/pipeline'
import type { CommEnrollment } from '@/lib/td-communication/types'

const SUBJECT_BADGE: Record<string, string> = {
  account: 'bg-blue-50 text-blue-700 border-blue-200',
  contact: 'bg-violet-50 text-violet-700 border-violet-200',
  lead: 'bg-amber-50 text-amber-700 border-amber-200',
  partner: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return format(parseISO(iso), 'MMM d')
  } catch {
    return ''
  }
}

function ProjectCard({
  project,
  now,
  onSelect,
}: {
  project: CommEnrollment
  now: Date
  onSelect: (id: string) => void
}) {
  const sla = slaIndicator(project.deadline, now)
  const countdown = deadlineLabel(project.deadline, now)
  return (
    <button
      type="button"
      onClick={() => onSelect(project.id)}
      className="w-full text-left bg-white rounded-lg border border-zinc-200 p-3 shadow-sm hover:shadow-md hover:border-zinc-300 transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-sm font-semibold text-zinc-900 leading-snug line-clamp-2">
          {project.subject.name}
        </span>
        <span
          className={cn(
            'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border',
            SUBJECT_BADGE[project.subject.type] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200',
          )}
        >
          {subjectTypeLabel(project.subject.type)}
        </span>
      </div>

      <p className="text-xs text-zinc-500 mb-2.5 line-clamp-1">{packageLabel(project.package_slug)}</p>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-400">{fmtDate(project.created_at)}</span>
        {countdown && (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[11px] font-medium',
              sla === 'red' ? 'text-red-600' : sla === 'yellow' ? 'text-amber-600' : 'text-zinc-500',
            )}
          >
            {sla && <span className={cn('h-2 w-2 rounded-full', SLA_DOT[sla])} />}
            <Clock className="h-3 w-3" />
            {countdown}
          </span>
        )}
      </div>
    </button>
  )
}

export function PipelineBoard({
  projects,
  onSelect,
}: {
  projects: CommEnrollment[]
  onSelect: (id: string) => void
}) {
  const now = useMemo(() => new Date(), [])

  const byColumn = useMemo(() => {
    const map: Record<PipelineColumnKey, CommEnrollment[]> = {
      new: [],
      in_progress: [],
      review: [],
      revision: [],
      approved: [],
      delivered: [],
    }
    for (const p of projects) {
      const col = statusToColumn(p.status)
      if (col) map[col].push(p)
    }
    return map
  }, [projects])

  const visibleCount = projects.filter((p) => statusToColumn(p.status)).length

  if (visibleCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <FolderOpen className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
          <h2 className="text-base font-semibold text-zinc-700 mb-1">No projects yet</h2>
          <p className="text-sm text-zinc-500">New creative projects will appear here as they come in.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-x-auto">
      <div className="flex gap-4 h-full min-w-max pb-2">
        {PIPELINE_COLUMNS.map((col) => {
          const items = byColumn[col.key]
          return (
            <div key={col.key} className="w-72 shrink-0 flex flex-col">
              <div className={cn('flex items-center justify-between px-1 pb-2 mb-2 border-t-4 pt-2', col.headerBorder)}>
                <h3 className="text-sm font-semibold text-zinc-700">{col.label}</h3>
                <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded-full', col.chip)}>
                  {items.length}
                </span>
              </div>
              <div className="flex-1 space-y-2.5 overflow-y-auto pr-0.5">
                {items.length === 0 ? (
                  <p className="text-xs text-zinc-300 text-center py-6">—</p>
                ) : (
                  items.map((p) => <ProjectCard key={p.id} project={p} now={now} onSelect={onSelect} />)
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
