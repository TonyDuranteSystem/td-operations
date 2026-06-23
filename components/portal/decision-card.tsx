'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, XCircle, HelpCircle } from 'lucide-react'
import type { DecisionRequest } from '@/lib/decisions'

interface DecisionCardProps {
  request: DecisionRequest
  locale: 'en' | 'it'
  /** Only the most recent pending request is actionable; others are read-only. */
  actionable: boolean
}

interface Choice { key: string; label: string; description?: string }

const T = {
  en: {
    actionRequired: 'Action required',
    yes: 'Yes, I approve',
    no: "No, I don't approve",
    submit: 'Submit',
    notePlaceholder: 'Add a comment (optional)',
    suggestNameLabel: 'Suggest a name instead (optional):',
    suggestNamePlaceholder: 'e.g. Sunshine LLC',
    youResponded: 'Your response',
    pending: 'A response is pending.',
    expired: 'This request has expired.',
    cancelled: 'This request was cancelled.',
    approved: 'Approved',
    rejected: 'Rejected',
    thanks: 'Thank you — your response has been recorded.',
    error: 'Could not submit your response. Please try again.',
  },
  it: {
    actionRequired: 'Azione richiesta',
    yes: 'Sì, approvo',
    no: 'No, non approvo',
    submit: 'Invia',
    notePlaceholder: 'Aggiungi un commento (facoltativo)',
    suggestNameLabel: 'Suggerisci un nome (facoltativo):',
    suggestNamePlaceholder: 'es. Sunshine LLC',
    youResponded: 'La tua risposta',
    pending: 'In attesa di una risposta.',
    expired: 'Questa richiesta è scaduta.',
    cancelled: 'Questa richiesta è stata annullata.',
    approved: 'Approvato',
    rejected: 'Rifiutato',
    thanks: 'Grazie — la tua risposta è stata registrata.',
    error: 'Impossibile inviare la risposta. Riprova.',
  },
}

export function DecisionCard({ request, locale, actionable }: DecisionCardProps) {
  const t = T[locale]
  const opts = (request.options ?? {}) as Record<string, unknown>
  const message = locale === 'it' && request.message_it ? request.message_it : request.message
  // Per-request button labels (with optional IT variants), falling back to the
  // localized defaults.
  const approveLabel = ((locale === 'it' ? (opts.approve_label_it ?? opts.approve_label) : opts.approve_label) as string | undefined) || t.yes
  const rejectLabel = ((locale === 'it' ? (opts.reject_label_it ?? opts.reject_label) : opts.reject_label) as string | undefined) || t.no

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local override once the client responds, so the card flips to read-only.
  const [localResponse, setLocalResponse] = useState<{ status: string; response: Record<string, unknown> } | null>(null)

  const [note, setNote] = useState('')
  const [selected, setSelected] = useState('')
  const [text, setText] = useState('')
  const [suggestedName, setSuggestedName] = useState('')

  // Formation name-approval requests carry a name_check marker — only those show
  // the "suggest a name instead" field (generic approvals don't).
  const isNameRequest = !!(opts as { name_check?: unknown }).name_check

  const effectiveStatus = localResponse?.status ?? request.status
  const effectiveResponse = localResponse?.response ?? request.response

  async function respond(payload: Record<string, unknown>) {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/decisions/${request.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: payload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || t.error)
      setLocalResponse({ status: data.status ?? 'responded', response: payload })
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.error)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Read-only states ──
  function renderAnswer() {
    const r = effectiveResponse
    if (!r) return null
    let line: string
    if (request.request_type === 'approval') {
      line = r.decision === 'approved' ? t.approved : t.rejected
      if (r.note) line += ` — “${r.note}”`
    } else if (request.request_type === 'choice') {
      const choices = (opts.choices as Choice[] | undefined) ?? []
      const picked = choices.find((c) => c.key === r.selected)
      line = picked?.label ?? String(r.selected ?? '')
      if (r.note) line += ` — “${r.note}”`
    } else {
      line = typeof r.text === 'string' ? r.text : ''
    }
    return (
      <div className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t.youResponded}</div>
        <div className="mt-0.5">{line}</div>
        {request.responded_at && (
          <div className="mt-1 text-[11px] text-zinc-400">
            {new Date(request.responded_at).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US')}
          </div>
        )}
      </div>
    )
  }

  const isAnswered = ['approved', 'rejected', 'responded'].includes(effectiveStatus)
  const isPendingActionable = effectiveStatus === 'pending' && actionable

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${
        isPendingActionable ? 'border-amber-300 bg-amber-50/60' : 'border-zinc-200 bg-white'
      }`}
    >
      <div className="flex items-start gap-2">
        <HelpCircle className={`mt-0.5 h-4 w-4 shrink-0 ${isPendingActionable ? 'text-amber-500' : 'text-zinc-400'}`} />
        <div className="min-w-0 flex-1">
          {isPendingActionable && <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700">{t.actionRequired}</div>}
          <h3 className="text-lg font-bold text-zinc-900 break-words">{request.title}</h3>
          <p className="mt-1.5 text-sm text-zinc-700 whitespace-pre-wrap break-words">{message}</p>
        </div>
      </div>

      {/* Answered → read-only */}
      {isAnswered && renderAnswer()}

      {/* Terminal non-answer states */}
      {effectiveStatus === 'expired' && <p className="mt-2 text-sm text-zinc-500">{t.expired}</p>}
      {effectiveStatus === 'cancelled' && <p className="mt-2 text-sm text-zinc-500">{t.cancelled}</p>}
      {effectiveStatus === 'pending' && !actionable && <p className="mt-2 text-sm text-zinc-500">{t.pending}</p>}

      {/* Just-submitted confirmation */}
      {localResponse && <p className="mt-2 text-xs text-emerald-700">{t.thanks}</p>}

      {/* Actionable pending → response UI */}
      {isPendingActionable && !localResponse && (
        <div className="mt-3 space-y-2">
          {request.request_type === 'approval' && (
            <>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t.notePlaceholder}
                rows={2}
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              />
              {/* Name-approval only: let the client propose a name to use instead.
                  Sent with a rejection; it becomes a pending candidate for staff. */}
              {isNameRequest && (
                <label className="block text-sm text-zinc-600">
                  {t.suggestNameLabel}
                  <input
                    type="text"
                    value={suggestedName}
                    onChange={(e) => setSuggestedName(e.target.value)}
                    placeholder={t.suggestNamePlaceholder}
                    className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                  />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={submitting}
                  onClick={() => respond({ decision: 'approved', ...(note.trim() ? { note: note.trim() } : {}) })}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {approveLabel}
                </button>
                <button
                  disabled={submitting}
                  onClick={() => respond({
                    decision: 'rejected',
                    ...(note.trim() ? { note: note.trim() } : {}),
                    ...(isNameRequest && suggestedName.trim() ? { suggested_name: suggestedName.trim() } : {}),
                  })}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  {rejectLabel}
                </button>
              </div>
            </>
          )}

          {request.request_type === 'choice' && (
            <>
              <div className="space-y-1.5">
                {((opts.choices as Choice[] | undefined) ?? []).map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2">
                    <input
                      type="radio"
                      name={`choice-${request.id}`}
                      value={c.key}
                      checked={selected === c.key}
                      onChange={() => setSelected(c.key)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-900">{c.label}</span>
                      {c.description && <span className="block text-xs text-zinc-500">{c.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t.notePlaceholder}
                rows={2}
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              />
              <button
                disabled={submitting || !selected}
                onClick={() => respond({ selected, ...(note.trim() ? { note: note.trim() } : {}) })}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t.submit}
              </button>
            </>
          )}

          {request.request_type === 'text_input' && (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={(opts.placeholder as string) || ''}
                rows={3}
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              />
              <button
                disabled={submitting || !text.trim()}
                onClick={() => respond({ text: text.trim() })}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t.submit}
              </button>
            </>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
