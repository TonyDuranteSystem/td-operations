'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { listOlderHistoryItems, setHistoryItemOpen } from '@/app/(dashboard)/accounts/history-openings-actions'
import { OPENABLE_KIND_LABELS, type OlderItem, type OpenableKind } from '@/lib/portal/history-openable'

/**
 * Shown on a company where some person joined later and sees its history only from a start date (dev job d14e823f, slice 3b).
 * Staff pick a kind of item, see what was saved before that date, and open ONE item to those people (or close it again).
 */
const KINDS = Object.keys(OPENABLE_KIND_LABELS) as OpenableKind[]

const tip = (i: OlderItem) => (i.opened ? 'Shown to people who joined later — click to hide' : 'Hidden from people who joined later — click to show')

export function HistoryOpeningsPanel({ accountId }: { accountId: string }) {
  const [kind, setKind] = useState<OpenableKind>('document')
  const [items, setItems] = useState<OlderItem[] | null>(null)
  const [cutoff, setCutoff] = useState<string | null>(null)
  const [loading, startLoad] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  function load(k: OpenableKind) {
    setKind(k)
    setItems(null)
    startLoad(async () => {
      const r = await listOlderHistoryItems(accountId, k)
      if (r.success && r.data) { setItems(r.data.items); setCutoff(r.data.cutoff) }
      else toast.error(r.error ?? 'Could not load the older items')
    })
  }

  async function toggle(item: OlderItem) {
    setBusyId(item.id)
    const r = await setHistoryItemOpen(accountId, kind, item.id, !item.opened)
    setBusyId(null)
    if (!r.success) { toast.error(r.error ?? 'Failed'); return }
    setItems(prev => (prev ?? []).map(i => (i.id === item.id ? { ...i, opened: !i.opened } : i)))
    toast.success(item.opened ? 'Hidden again from people who joined later' : 'Now shown to people who joined later')
  }

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/50 p-3 text-xs space-y-2" data-testid="history-openings-panel">
      <div className="font-medium text-amber-800">Earlier items for people who joined later</div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border bg-white px-2 py-1 text-zinc-900"
          value={kind}
          onChange={e => load(e.target.value as OpenableKind)}
          aria-label="Kind of older item"
        >
          {KINDS.map(k => <option key={k} value={k}>{OPENABLE_KIND_LABELS[k]}</option>)}
        </select>
        <button onClick={() => load(kind)} className="rounded border bg-white px-2 py-1 text-zinc-900 hover:bg-zinc-50" disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Show older items'}
        </button>
      </div>
      {items && (
        <>
          <div className="text-zinc-500">Saved before {cutoff ? new Date(cutoff).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}. Click the eye to show one of them.</div>
          {items.length === 0 ? <div className="text-zinc-500">Nothing older of this kind.</div> : (
            <ul className="max-h-64 overflow-auto divide-y rounded border bg-white">
              {items.map(i => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-zinc-900">{i.label}</div>
                    <div className="truncate text-zinc-500">{i.date}{i.sub ? ` · ${i.sub}` : ''}</div>
                  </div>
                  <FastTooltip label={tip(i)}>
                    <button
                      onClick={() => toggle(i)}
                      disabled={busyId === i.id}
                      aria-label={tip(i)}
                      className={i.opened ? 'text-green-600' : 'text-zinc-400 hover:text-zinc-700'}
                    >
                      {busyId === i.id ? <Loader2 className="h-4 w-4 animate-spin" /> : i.opened ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  </FastTooltip>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
