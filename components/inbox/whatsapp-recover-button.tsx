'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, LifeBuoy } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { describeRecoverDone, type RecoverView } from '@/lib/messaging/wabridge-commands'
import { WHATSAPP_LIST_QUERY_KEY, WHATSAPP_CHAT_QUERY_KEY } from '@/lib/ui-event-whatsapp-keys'

const POLL_MS = 30_000
const POLL_ACTIVE_MS = 4_000

/**
 * "Recover missing messages" — asks the Mac Mini to re-read the phone's recent history (last 7 days) and save whatever the CRM
 * missed (the same catch-up that already runs every 15 minutes). Safe to press at any time: anything the CRM already has is skipped.
 * The Mac answers on its next minute check, so the button shows progress and then the result in plain words.
 */
export function WhatsAppRecoverButton() {
  const qc = useQueryClient()
  const [view, setView] = useState<RecoverView>({ state: 'idle' })
  const [pressed, setPressed] = useState(false) // between the click and the first status that shows it
  const [error, setError] = useState<string | null>(null)
  const lastDone = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox/whatsapp/bridge-status', { cache: 'no-store' })
      if (!res.ok) return // a status-read failure must not disturb the inbox
      const d = await res.json()
      if (d?.recover) {
        setView(d.recover as RecoverView)
        if ((d.recover as RecoverView).state !== 'idle') setPressed(false)
        // new messages were saved: show them without a reload
        if (d.recover.state === 'done' && d.recover.at !== lastDone.current) {
          lastDone.current = d.recover.at
          if (d.recover.saved > 0) {
            void qc.invalidateQueries({ queryKey: [...WHATSAPP_LIST_QUERY_KEY] })
            void qc.invalidateQueries({ queryKey: [...WHATSAPP_CHAT_QUERY_KEY] })
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, [qc])

  const active = pressed || view.state === 'waiting' || view.state === 'running'
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), active ? POLL_ACTIVE_MS : POLL_MS)
    return () => clearInterval(t)
  }, [load, active])

  const press = async () => {
    setError(null)
    setPressed(true)
    try {
      const res = await fetch('/api/inbox/whatsapp/bridge-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'recover' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not send the request. Please try again.')
      await load()
    } catch (err) {
      setPressed(false)
      setError(err instanceof Error && err.message ? err.message : 'Could not send the request. Please try again.')
    }
  }

  let note: string | null = null
  if (error) note = error
  else if (active) note = view.state === 'running' ? 'The Mac Mini is reading the phone…' : 'Asking the Mac Mini — up to a minute…'
  else if (view.state === 'done') note = describeRecoverDone(view.saved, view.read)
  else if (view.state === 'no_answer') note = "The Mac Mini did not answer — is it on and online?"

  return (
    <div className="relative inline-flex items-center" data-testid="wa-recover">
      <FastTooltip label="Re-read the phone's recent history and save any message the CRM missed. Safe to press any time.">
        <button
          type="button"
          data-tour="wa-recover"
          onClick={press}
          disabled={active}
          aria-label="Recover missing messages"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm font-medium whitespace-nowrap hover:bg-zinc-50 transition-colors disabled:opacity-60"
        >
          {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LifeBuoy className="h-3.5 w-3.5" />}
          Recover missing messages
        </button>
      </FastTooltip>
      {/* below the button, not beside it: the toolbar must keep its shape while the message shows */}
      {note && (
        <span
          className={`absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded border bg-white px-2 py-1 text-xs shadow-sm ${error || view.state === 'no_answer' ? 'border-red-200 text-red-600' : 'border-zinc-200 text-zinc-600'}`}
          role="status"
        >
          {note}
        </span>
      )}
    </div>
  )
}
