'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw } from 'lucide-react'
import { boxModel, parseSendCheckReply, type SendCheckReply } from '@/lib/offers/send-check-view'
import { useOfferBuilderFeatures } from './use-offer-builder-features'

/**
 * "Before this offer can be sent" — what the real Send will say about a DRAFT offer, shown before staff press it
 * (offer builder Part 1, dev job d2971d11). It asks the read-only route (nothing is written, nothing is sent) and draws the
 * answer from lib/offers/send-check-view.ts. The server stays the only real gate: Send is never locked by this box.
 *
 * Drawn only where the rollout allows it for this offer's record (off / test accounts only / on — Claude sets it on Antonio's
 * word, no screen); while it is not allowed nothing is drawn and the check route is never called. Mount it only for a DRAFT
 * offer. Amber with an icon and words, never colour alone.
 */
export function OfferSendCheckBox({ token }: { token: string }) {
  // Off unless the server says this piece may be shown for THIS offer's record (off / test accounts only / on — Claude sets it
  // on Antonio's word; there is no screen for it). See lib/offers/rollout.ts.
  const { sendCheckBox: on } = useOfferBuilderFeatures({ token })
  const [reply, setReply] = useState<SendCheckReply | null>(null)
  const [loading, setLoading] = useState(false)
  const [couldNot, setCouldNot] = useState(false)
  const seq = useRef(0)

  const run = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const res = await fetch(`/api/crm/admin-actions/offer-send-check?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      const parsed = parseSendCheckReply(res.ok, await res.json().catch(() => null))
      // An older answer never overwrites a newer one.
      if (mine !== seq.current) return
      setReply(parsed)
      setCouldNot(parsed === null)
    } catch {
      if (mine !== seq.current) return
      setReply(null)
      setCouldNot(true)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (on) void run()
  }, [on, run])

  if (!on) return null
  // The offer is no longer a draft: nothing is about to be sent.
  if (reply && !reply.applicable) return null

  const model = reply && reply.applicable ? boxModel(reply) : null
  const checkedAt = reply?.checkedAt ? new Date(reply.checkedAt) : null

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-3 text-sm" aria-label="Before this offer can be sent" aria-live="polite" data-offer-send-check-box>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">Before this offer can be sent</h3>
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Check again
        </button>
      </div>

      {!model && loading && <p className="mt-2 text-xs text-zinc-500">Checking…</p>}

      {!model && !loading && couldNot && (
        <p className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Could not check this offer right now (not a result — nothing is known). Try “Check again”. Send still checks everything itself.</span>
        </p>
      )}

      {model && (
        <div className="mt-2 space-y-2">
          {model.tone === 'ok' ? (
            <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {model.headline}
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="flex items-center gap-2 text-xs font-medium text-amber-900">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {model.headline}
              </p>
              <ul className="space-y-1.5">
                {model.problems.map((p, i) => (
                  <li key={i} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-zinc-800">
                    {p.text}
                    {p.href && (
                      <>
                        {' '}
                        <a href={p.href} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap font-medium text-blue-700 underline">
                          {p.linkLabel}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-zinc-500">{model.askLine}</p>
            </div>
          )}

          {model.risks.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-zinc-700">It can be sent, but look at this first</p>
              <ul className="space-y-1.5">
                {model.risks.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-800">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {model.notChecked.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-zinc-700">Not checked here</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600">
                {model.notChecked.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-zinc-500">
            {model.willSendTo ? <>It will go to <span className="font-medium text-zinc-700">{model.willSendTo}</span>. </> : 'There is no client email on this offer. '}
            {checkedAt && !Number.isNaN(checkedAt.getTime()) && <>Checked at {checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</>}
          </p>
        </div>
      )}
    </section>
  )
}
