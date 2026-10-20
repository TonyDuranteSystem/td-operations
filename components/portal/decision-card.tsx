'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, XCircle, HelpCircle } from 'lucide-react'
import type { DecisionRequest } from '@/lib/decisions'
import { useLocale } from '@/lib/portal/use-locale'
import { nameDedupeKey } from '@/lib/flows/name-checks'

interface DecisionCardProps {
  request: DecisionRequest
  locale: 'en' | 'it'
  /** Only the most recent pending request is actionable; others are read-only. */
  actionable: boolean
}

interface Choice { key: string; label: string; description?: string }

export function DecisionCard({ request, locale, actionable }: DecisionCardProps) {
  // Routed through the shared translation system (dev job 12cab351) instead
  // of a private en/it-only dictionary — a local `Record<'en'|'it',...>[locale]`
  // returned undefined for any other locale and crashed on the next property
  // access (2026-08-22 incident, found by the senior-engineer council pass).
  // useLocale()'s t() always resolves to English rather than undefined.
  const { t: translate } = useLocale()
  const t = {
    actionRequired: translate('decisionCard.actionRequired'),
    yes: translate('decisionCard.yes'),
    no: translate('decisionCard.no'),
    submit: translate('decisionCard.submit'),
    notePlaceholder: translate('decisionCard.notePlaceholder'),
    suggestNameLabel: translate('decisionCard.suggestNameLabel'),
    suggestNamePlaceholder: translate('decisionCard.suggestNamePlaceholder'),
    youResponded: translate('decisionCard.youResponded'),
    pending: translate('decisionCard.pending'),
    expired: translate('decisionCard.expired'),
    cancelled: translate('decisionCard.cancelled'),
    approved: translate('decisionCard.approved'),
    rejected: translate('decisionCard.rejected'),
    thanks: translate('decisionCard.thanks'),
    error: translate('decisionCard.error'),
    nameChoice1: translate('decisionCard.nameChoice1'),
    nameChoice2: translate('decisionCard.nameChoice2'),
    nameChoice3: translate('decisionCard.nameChoice3'),
    nameChoiceNew: translate('decisionCard.nameChoiceNew'),
    nameHint1: translate('decisionCard.nameHint1'),
    nameHint2: translate('decisionCard.nameHint2'),
    needOneName: translate('decisionCard.needOneName'),
    namesMustDiffer: translate('decisionCard.namesMustDiffer'),
  }
  const opts = (request.options ?? {}) as Record<string, unknown>
  const message = locale === 'it' && request.message_it ? request.message_it : request.message
  // Optional Italian title / placeholder of the request (options.title_it / placeholder_it); English otherwise.
  const cardTitle = locale === 'it' && typeof opts.title_it === 'string' && opts.title_it ? opts.title_it : request.title
  const inputPlaceholder = locale === 'it' && typeof opts.placeholder_it === 'string' && opts.placeholder_it ? opts.placeholder_it : ((opts.placeholder as string) || '')
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
  // "Send us your names" (Company Change Name): one box per name, laid out like the formation wizard's company-name step —
  // 1st choice, 2nd choice (backup), 3rd choice (backup) — instead of one box with "one per line" (where a comma list became
  // ONE name). The answer still travels as lines of text, so the server side is unchanged.
  const nameMarker = (opts as { name_check?: { kind?: string; split?: string; max?: number } }).name_check
  const nameBoxes = nameMarker?.kind === 'new_names' && nameMarker.split === 'lines'
    ? Math.min(Math.max(Number(nameMarker.max) || 3, 1), 3)
    : 0
  const [nameFields, setNameFields] = useState<string[]>(['', '', ''])
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
          <h3 className="text-lg font-bold text-zinc-900 break-words">{cardTitle}</h3>
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

          {request.request_type === 'text_input' && nameBoxes > 0 && (
            <>
              <div className="space-y-2">
                {Array.from({ length: nameBoxes }, (_, i) => {
                  const label = nameBoxes === 1 ? t.nameChoiceNew : [t.nameChoice1, t.nameChoice2, t.nameChoice3][i]
                  const hint = nameBoxes === 1 ? null : i === 0 ? t.nameHint1 : i === 1 ? t.nameHint2 : null
                  return (
                    <label key={i} className="block text-sm font-medium text-zinc-700">
                      {label}
                      <input
                        type="text"
                        value={nameFields[i] ?? ''}
                        onChange={(e) => setNameFields((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                        maxLength={120}
                        autoComplete="off"
                        className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm font-normal text-zinc-900"
                      />
                      {hint && <span className="mt-0.5 block text-xs font-normal text-zinc-500">{hint}</span>}
                    </label>
                  )
                })}
              </div>
              <button
                disabled={submitting || !(nameFields[0] ?? '').trim()}
                onClick={() => {
                  const names = nameFields.slice(0, nameBoxes).map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean)
                  if (names.length === 0) { setError(t.needOneName); return }
                  if (new Set(names.map((n) => nameDedupeKey(n))).size !== names.length) { setError(t.namesMustDiffer); return }
                  respond({ text: names.join('\n') })
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t.submit}
              </button>
            </>
          )}

          {request.request_type === 'text_input' && nameBoxes === 0 && (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={inputPlaceholder}
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
