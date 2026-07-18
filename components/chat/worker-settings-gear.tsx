'use client'

/**
 * WorkerSettingsGear — the ⚙ on every worker panel (dev job a6c3d75b, Antonio
 * 2026-07-18: "move the option to change model everywhere there is the worker with
 * the settings icon").
 *
 * ONE SHARED SETTING by Antonio's explicit choice: changing the model here changes
 * it on every worker surface. Different models per screen would mean the same
 * question gets different answers depending where it was asked, with no way to tell
 * why. Built as one component (not three copies) so the panels can't drift.
 *
 * Admin-only to CHANGE — it costs money per question and affects the whole team.
 * Everyone else sees which model is answering, read-only.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { WorkerModelOption } from '@/lib/ai-agent/worker-models'

interface ModelState {
  active: string
  chosen: string | null
  options: WorkerModelOption[]
  canEdit: boolean
}

export function WorkerSettingsGear({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ModelState | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Load lazily — the gear costs nothing until it's opened.
  useEffect(() => {
    if (!open || state) return
    let alive = true
    fetch('/api/ai-agent/model')
      .then(r => r.json())
      .then((d: ModelState & { error?: string }) => {
        if (!alive) return
        if (d.error) { toast.error(d.error); return }
        setState(d)
      })
      .catch(() => { if (alive) toast.error("Couldn't load the assistant settings.") })
    return () => { alive = false }
  }, [open, state])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = useCallback(async (id: string) => {
    if (!state?.canEdit || saving) return
    setSaving(id)
    try {
      const res = await fetch('/api/ai-agent/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not change the model.')
      setState(s => (s ? { ...s, active: id, chosen: id } : s))
      toast.success('Model changed — applies everywhere the worker runs')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not change the model.')
    } finally {
      setSaving(null)
    }
  }, [state, saving])

  return (
    <div className={cn('relative', className)} ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Assistant settings"
        aria-label="Assistant settings"
        className="inline-flex items-center justify-center rounded-md p-1.5 min-h-[32px] min-w-[32px] text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border bg-white shadow-lg p-3 text-left">
          <p className="text-xs font-semibold text-zinc-700">Assistant model</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            One setting — applies everywhere the worker runs.
          </p>

          {!state && (
            <div className="flex items-center gap-2 py-3 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}

          {state && (
            <div className="mt-2 space-y-1">
              {state.options.map(o => {
                const isActive = state.active === o.id
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={!state.canEdit || !!saving}
                    onClick={() => void choose(o.id)}
                    className={cn(
                      'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                      isActive ? 'border-violet-300 bg-violet-50' : 'border-transparent hover:bg-zinc-50',
                      !state.canEdit && 'cursor-default',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-zinc-800">{o.label}</span>
                      {isActive && <Check className="h-3 w-3 text-violet-600 shrink-0" />}
                      {saving === o.id && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{o.hint}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-zinc-400">{o.id}</span>
                  </button>
                )
              })}

              {!state.canEdit && (
                <p className="pt-1 text-[11px] text-zinc-400">
                  Only an admin can change this.
                </p>
              )}
              {state.canEdit && (
                <p className="pt-1 text-[11px] text-zinc-400">
                  A stronger model reasons better but costs more per question.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
