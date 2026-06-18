'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, MessageSquareReply, Plus, Clock, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import type { DecisionRequest, DecisionRequestType } from '@/lib/decisions'

interface DecisionRequestPanelProps {
  serviceDeliveryId: string
  serviceType: string
  stage: string | null
}

const TYPE_LABEL: Record<DecisionRequestType, string> = {
  approval: 'Approval (Yes/No)',
  choice: 'Choice (pick one)',
  text_input: 'Text input',
}

function statusBadge(status: string): { cls: string; icon: React.ReactNode } {
  switch (status) {
    case 'approved':
      return { cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 className="h-3 w-3" /> }
    case 'rejected':
      return { cls: 'bg-red-100 text-red-700', icon: <XCircle className="h-3 w-3" /> }
    case 'responded':
      return { cls: 'bg-blue-100 text-blue-700', icon: <CheckCircle2 className="h-3 w-3" /> }
    case 'pending':
      return { cls: 'bg-amber-100 text-amber-700', icon: <Clock className="h-3 w-3" /> }
    default:
      return { cls: 'bg-zinc-100 text-zinc-600', icon: <AlertCircle className="h-3 w-3" /> }
  }
}

function answerText(req: DecisionRequest): string | null {
  const r = req.response
  if (!r) return null
  if (req.request_type === 'approval') {
    const d = r.decision === 'approved' ? 'Approved' : 'Rejected'
    return r.note ? `${d} — “${r.note}”` : d
  }
  if (req.request_type === 'choice') {
    const choices = (req.options as { choices?: { key: string; label: string }[] } | null)?.choices ?? []
    const picked = choices.find((c) => c.key === r.selected)
    const label = picked?.label ?? String(r.selected ?? '')
    return r.note ? `${label} — “${r.note}”` : label
  }
  return typeof r.text === 'string' ? r.text : null
}

/**
 * Staff workspace panel for Client Decision Requests on a service delivery.
 * Lists pending/responded/historical requests and lets staff create a new one
 * (approval / choice / text_input). On the formation "Wizard Submitted" stage a
 * "Propose Name to Client" quick-fill seeds an approval request.
 */
export function DecisionRequestPanel({ serviceDeliveryId, serviceType, stage }: DecisionRequestPanelProps) {
  const [requests, setRequests] = useState<DecisionRequest[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [open, setOpen] = useState(false)
  const [type, setType] = useState<DecisionRequestType>('approval')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [choicesText, setChoicesText] = useState('')
  const [autoAdvanceOn, setAutoAdvanceOn] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/decisions?sd_id=${serviceDeliveryId}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not load decision requests.')
      setRequests((data.requests as DecisionRequest[]) ?? [])
      setLoaded(true)
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load decision requests.')
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  const isFormationName = serviceType === 'Company Formation' && stage === 'Wizard Submitted'

  function resetForm() {
    setType('approval')
    setTitle('')
    setMessage('')
    setChoicesText('')
    setAutoAdvanceOn('')
    setFormError(null)
  }

  function proposeName() {
    setType('approval')
    setTitle('LLC Name Approval')
    setMessage('We checked and [NAME] LLC is available in [State]. Do you approve filing with this name?')
    setChoicesText('')
    setAutoAdvanceOn('')
    setFormError(null)
    setOpen(true)
  }

  async function submit() {
    setFormError(null)
    if (!title.trim() || !message.trim()) {
      setFormError('Title and message are required.')
      return
    }
    let options: Record<string, unknown> = {}
    if (type === 'choice') {
      const lines = choicesText.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) {
        setFormError('Add at least one choice (one per line).')
        return
      }
      options = { choices: lines.map((label, i) => ({ key: `opt_${i + 1}`, label })) }
    } else if (type === 'text_input') {
      options = { prompt: message.trim() }
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/portal/decisions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_delivery_id: serviceDeliveryId,
          request_type: type,
          title: title.trim(),
          message: message.trim(),
          options,
          auto_advance_on: autoAdvanceOn.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not create the request.')
      resetForm()
      setOpen(false)
      await load()
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : 'Could not create the request.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareReply className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-900">Client Decisions</h3>
        </div>
        <div className="flex items-center gap-2">
          {isFormationName && (
            <button
              onClick={proposeName}
              className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
            >
              Propose Name to Client
            </button>
          )}
          <button
            onClick={() => { setOpen((o) => !o); if (open) resetForm() }}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <Plus className="h-3.5 w-3.5" /> Request Client Decision
          </button>
        </div>
      </div>

      {open && (
        <div className="mb-4 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-zinc-500">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as DecisionRequestType)}
              className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            >
              {(Object.keys(TYPE_LABEL) as DecisionRequestType[]).map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (what the client sees as the heading)"
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message / instructions for the client"
            rows={3}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
          {type === 'choice' && (
            <textarea
              value={choicesText}
              onChange={(e) => setChoicesText(e.target.value)}
              placeholder="One choice per line, e.g.&#10;Aurora Ventures LLC&#10;Cypress Trail LLC&#10;None of these"
              rows={3}
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
            />
          )}
          <input
            value={autoAdvanceOn}
            onChange={(e) => setAutoAdvanceOn(e.target.value)}
            placeholder="Auto-advance to stage on approval (optional)"
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
          {formError && <p className="text-xs text-red-600">{formError}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send to client
            </button>
            <button
              onClick={() => { setOpen(false); resetForm() }}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}
      {!loadError && !loaded && (
        <p className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {!loadError && loaded && requests.length === 0 && (
        <p className="text-sm text-zinc-500">No decision requests yet.</p>
      )}

      {requests.length > 0 && (
        <ul className="space-y-2">
          {requests.map((req) => {
            const badge = statusBadge(req.status)
            const answer = answerText(req)
            return (
              <li key={req.id} className="rounded-lg border border-zinc-200 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-900">{req.title}</div>
                    <div className="text-xs text-zinc-500 break-words">{req.message}</div>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
                    {badge.icon}
                    {req.status}
                  </span>
                </div>
                {req.status === 'pending' ? (
                  <div className="mt-1 text-[11px] text-amber-700">Waiting for client response…</div>
                ) : answer ? (
                  <div className="mt-1 text-xs text-zinc-700">
                    <span className="font-medium">Client answered:</span> {answer}
                    {req.responded_at ? (
                      <span className="text-zinc-400"> · {new Date(req.responded_at).toLocaleString()}</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
