'use client'

/**
 * System Errors (auto-audit) panel for /system-health.
 *
 * Lists captured runtime errors (system_errors table) with their AI
 * diagnosis + suggested fix, deduplicated by fingerprint with an occurrence
 * counter. Staff can mark a row Resolved (fixed / no longer relevant) or
 * Ignore it (known noise). A repeat occurrence reopens resolved rows.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CheckCircle2, EyeOff, Loader2, Sparkles } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import type { SystemErrorRow } from '@/lib/system-errors'

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-red-50 text-red-700 border-red-200',
  diagnosed: 'bg-blue-50 text-blue-700 border-blue-200',
}

export function SystemErrorsPanel({ rows }: { rows: SystemErrorRow[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function setStatus(id: string, status: 'resolved' | 'ignored') {
    setBusyId(id)
    try {
      const res = await fetch('/api/system-errors/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      const data = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) {
        toast.error(data.error || `Update failed (HTTP ${res.status})`)
        return
      }
      toast.success(status === 'resolved' ? 'Marked resolved' : 'Ignored')
      startTransition(() => router.refresh())
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Update failed — please retry.')
    } finally {
      setBusyId(null)
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No open errors — all clear.</p>
  }

  return (
    <ul className="divide-y divide-zinc-100" data-testid="system-errors-list">
      {rows.map((row) => (
        <li key={row.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded border px-1.5 py-0.5 font-medium ${STATUS_BADGE[row.status] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200'}`}>
                  {row.status}
                </span>
                <span className="font-mono text-zinc-500">
                  {row.method ?? ''} {row.route}
                </span>
                {row.http_status ? <span className="text-zinc-500">HTTP {row.http_status}</span> : null}
                <span className="text-zinc-400">
                  ×{row.occurrence_count} · last {new Date(row.last_seen).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 truncate text-sm font-medium text-zinc-800" title={row.message}>
                {row.message}
              </p>
              {row.diagnosis ? (
                <div className="mt-2 rounded-md bg-blue-50/60 p-2 text-sm">
                  <p className="flex items-start gap-1.5 text-zinc-700">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                    <span>{row.diagnosis}</span>
                  </p>
                  {row.suggested_fix ? (
                    <p className="mt-1 pl-5 text-zinc-600">
                      <span className="font-medium text-zinc-700">Solution: </span>
                      {row.suggested_fix}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-xs text-zinc-400">Diagnosis pending — the auditor runs every 15 minutes.</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <FastTooltip label="Mark resolved (a repeat occurrence reopens it)">
                <button
                  onClick={() => setStatus(row.id, 'resolved')}
                  disabled={busyId === row.id || isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
                  aria-label="Mark resolved (a repeat occurrence reopens it)"
                >
                  {busyId === row.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  Resolve
                </button>
              </FastTooltip>
              <FastTooltip label="Ignore (known noise)">
                <button
                  onClick={() => setStatus(row.id, 'ignored')}
                  disabled={busyId === row.id || isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
                  aria-label="Ignore (known noise)"
                >
                  <EyeOff className="h-3 w-3" />
                  Ignore
                </button>
              </FastTooltip>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
