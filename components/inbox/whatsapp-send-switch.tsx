'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Send } from 'lucide-react'

type Mode = 'paused' | 'shadow' | 'live'

interface SendState {
  mode: Mode
  allowlist: string[]
  pacing: { minGapSeconds: number; hourlyCap: number; dailyCap: number; distinctPerHour: number; sameBodyPerHour: number }
}

const LABELS: Record<Mode, string> = { paused: 'Paused', shadow: 'Test mode', live: 'Live' }
const HELP: Record<Mode, string> = {
  paused: 'Nothing can be queued or sent from the CRM.',
  shadow: 'Replies are recorded but NEVER sent to WhatsApp.',
  live: 'Replies are sent by the Mac Mini at the approved pace.',
}

/**
 * Owner-only control for CRM replies on the self-hosted WhatsApp line: the pause switch and the list of numbers allowed while live.
 * Renders nothing for anyone else (the status route only returns `send` to the owner, and the save routes re-check it).
 * Going LIVE needs an approved-numbers list first and asks for one extra click.
 */
export function WhatsAppSendSwitch() {
  const [state, setState] = useState<SendState | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmLive, setConfirmLive] = useState(false)
  const [listText, setListText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox/whatsapp/bridge-status', { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json()
      if (d?.send) setState(d.send as SendState)
      else setState(null)
    } catch {
      /* a status-read failure must never block the inbox */
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (state && !open) setListText(state.allowlist.join(', '))
  }, [state, open])

  if (!state) return null

  const save = async (payload: { mode?: Mode; allowlist?: string[] }) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/inbox/whatsapp/send-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save — please try again.')
      }
      toast.success(payload.mode ? `Replies from the CRM: ${LABELS[payload.mode]}` : 'Approved numbers saved.')
      setConfirmLive(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const listFromText = () => listText.split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 6)

  return (
    <div className="border-b bg-white px-4 py-2 text-xs">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <Send className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">Replies from the CRM:</span>
        <span
          className={
            state.mode === 'live'
              ? 'rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-800'
              : state.mode === 'shadow'
                ? 'rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800'
                : 'rounded bg-zinc-200 px-1.5 py-0.5 font-semibold text-zinc-700'
          }
        >
          {LABELS[state.mode]}
        </span>
        <span className="text-zinc-400">{open ? 'hide' : 'change'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-zinc-500">{HELP[state.mode]}</p>
          <div className="flex flex-wrap gap-2">
            {(['paused', 'shadow'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy || state.mode === m}
                onClick={() => save({ mode: m })}
                className="rounded border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                {LABELS[m]}
              </button>
            ))}
            {!confirmLive ? (
              <button
                type="button"
                disabled={busy || state.mode === 'live' || state.allowlist.length === 0}
                onClick={() => setConfirmLive(true)}
                aria-label={state.allowlist.length === 0 ? 'Live (add approved numbers first)' : 'Live'}
                className="rounded border border-green-300 bg-green-50 px-2.5 py-1 font-medium text-green-800 hover:bg-green-100 disabled:opacity-40"
              >
                Live…
              </button>
            ) : (
              <span className="flex items-center gap-2 rounded border border-green-300 bg-green-50 px-2 py-1 text-green-900">
                Send REAL WhatsApp messages to {state.allowlist.length} approved number{state.allowlist.length === 1 ? '' : 's'}?
                <button type="button" disabled={busy} onClick={() => save({ mode: 'live' })} className="rounded bg-green-700 px-2 py-0.5 font-semibold text-white disabled:opacity-50">
                  Yes, go live
                </button>
                <button type="button" onClick={() => setConfirmLive(false)} className="text-green-800 underline">
                  Cancel
                </button>
              </span>
            )}
          </div>
          <div className="space-y-1">
            <label className="block font-medium text-zinc-600" htmlFor="wa-allowlist">
              Approved numbers (only these can be messaged while Live; digits with country code, separated by commas)
            </label>
            <div className="flex gap-2">
              <input
                id="wa-allowlist"
                value={listText}
                onChange={(e) => setListText(e.target.value)}
                className="flex-1 rounded border border-zinc-300 px-2 py-1 outline-none focus:border-blue-400"
                placeholder="17274234285, 17274521093"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => save({ allowlist: listFromText() })}
                className="rounded border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                Save list
              </button>
            </div>
          </div>
          <p className="text-zinc-400">
            Pace: about {state.pacing.minGapSeconds} seconds apart · at most {state.pacing.hourlyCap} an hour · {state.pacing.dailyCap} a day ·{' '}
            {state.pacing.distinctPerHour} different people an hour · identical text to at most {state.pacing.sameBodyPerHour} people an hour.
          </p>
        </div>
      )}
    </div>
  )
}
