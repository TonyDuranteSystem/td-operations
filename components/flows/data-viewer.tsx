'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ClipboardList, Loader2, Pencil, X } from 'lucide-react'
import { groupSubmittedData, type DataGroup, type DataField } from '@/lib/flows/submitted-data'
import { FORMATION_NAME_KEYS } from '@/lib/flows/formation-names'
import { formatUploadDate } from '@/lib/flows/workspace-format'
import { REVIEW_REQUESTS_CHANGED_EVENT } from '@/lib/flows/review-requests-event'
import { FastTooltip } from '@/components/ui/fast-tooltip'

interface Submission {
  id?: string
  entity_type: string | null
  tax_year: number | null
  review_status: string | null
  created_at: string | null
  submitted_data: Record<string, unknown> | null
}

/** One request staff sent in the newest round, with what the client did about it (computed on the server). */
interface RoundRequest {
  key: string
  label: string
  group: string
  note: string
  was: string | null
  now: string | null
  outcome: 'updated' | 'unchanged' | 'removed'
}

interface ReviewPayload {
  writable: boolean
  draft: { requests: Record<string, string>; message: string }
  last_round: { sent_at: string; by: string; message: string | null; waiting: boolean; requests: RoundRequest[] } | null
}

interface DataViewerProps {
  serviceDeliveryId: string
  /** Optional heading override from stage_layout. */
  label?: string
  /** The step has a Request Changes button: show the pencil next to each answer. Set by the stage renderer from the layout. */
  requestsEnabled?: boolean
}

/**
 * Renders the client's submitted tax-wizard data for a flow (service_delivery).
 * Fetches the account's target tax_return_submissions row and renders
 * submitted_data as grouped, readable cards (Company, Owner, per-member, per-bank
 * account, US Activity, Tax Questions) via the schema-agnostic grouping helper —
 * so it adapts to SMLLC / MMLLC / Corp shapes without hardcoding keys.
 * Surfaces the server's real error (R099) rather than a generic message.
 *
 * Review requests (dev job 7df278cd): on a step that has Request Changes, each answer has a pencil. Staff write what the client
 * must fix; it saves as they type (a draft, nothing is sent). Request Changes then sends them together. After the client
 * resubmits, each flagged answer shows whether it was updated.
 */
export function DataViewer({ serviceDeliveryId, label, requestsEnabled = false }: DataViewerProps) {
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [review, setReview] = useState<ReviewPayload | null>(null)
  const [source, setSource] = useState<'formation' | 'tax' | 'closure'>('tax')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/submission`, { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Could not load the submitted data.')
        }
        if (!cancelled) {
          setSubmission((data.submission as Submission) ?? null)
          setReview((data.review as ReviewPayload | undefined) ?? null)
          setSource(data.source === 'formation' ? 'formation' : data.source === 'closure' ? 'closure' : 'tax')
          setLoaded(true)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : 'Could not load the submitted data.')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [serviceDeliveryId])

  const isFormation = source === 'formation'
  // For formation, drop the name keys (incl. any chosen_name*) from the grouped
  // view — the candidate LLC names are owned by the formation_names command
  // center (components/flows/formation-names.tsx), not shown here.
  const dataForGroups = isFormation && submission?.submitted_data
    ? Object.fromEntries(
        Object.entries(submission.submitted_data).filter(
          ([k]) => !(FORMATION_NAME_KEYS as readonly string[]).includes(k),
        ),
      )
    : submission?.submitted_data
  const groups: DataGroup[] = submission ? groupSubmittedData(dataForGroups) : []
  const heading = label || (isFormation ? 'Formation Wizard Submission' : source === 'closure' ? 'Closure Wizard Answers' : 'Submitted Tax Data')

  // ── review requests (tax source only) ──
  const canWrite = requestsEnabled && source === 'tax' && !!review?.writable
  const draft = review?.draft.requests ?? {}
  const draftKeys = Object.keys(draft)
  const round = review?.last_round ?? null
  const roundByKey = useMemo(() => new Map((round?.requests ?? []).map((q) => [q.key, q])), [round])

  const announce = useCallback(
    (count: number) => {
      window.dispatchEvent(new CustomEvent(REVIEW_REQUESTS_CHANGED_EVENT, { detail: { serviceDeliveryId, count } }))
    },
    [serviceDeliveryId],
  )

  // Save ONE change on the server; keep what the server answers (it is the truth).
  const save = useCallback(
    async (body: { key: string; note: string } | { message: string }): Promise<string | null> => {
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/review-notes`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          return typeof data.error === 'string' && data.error ? data.error : 'Could not save the request. Please try again.'
        }
        setReview((r) => (r ? { ...r, draft: data.draft } : r))
        announce(typeof data.count === 'number' ? data.count : Object.keys(data.draft?.requests ?? {}).length)
        return null
      } catch (err) {
        return err instanceof Error && err.message ? err.message : 'Could not save the request. Please try again.'
      }
    },
    [serviceDeliveryId, announce],
  )

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-900">{heading}</h3>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && draftKeys.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800" data-testid="requests-written">
              {draftKeys.length} request{draftKeys.length === 1 ? '' : 's'} written
            </span>
          )}
          {submission && (
            <div className="text-[11px] text-zinc-400">
              {submission.entity_type ? `${submission.entity_type} · ` : ''}
              {submission.tax_year ? `${submission.tax_year} · ` : ''}
              {formatUploadDate(submission.created_at) ?? ''}
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!error && !loaded && (
        <p className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading submitted data…
        </p>
      )}

      {!error && loaded && !submission && (
        <p className="text-sm text-zinc-500">No submitted data found for this client yet.</p>
      )}

      {!error && loaded && submission && groups.length === 0 && (
        <p className="text-sm text-zinc-500">The submission has no data to display.</p>
      )}

      {!error && canWrite && groups.length > 0 && (
        <p className="mb-3 flex items-start gap-2 text-xs text-zinc-500">
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Click the pencil next to any answer to write a request for the client. Answers you leave alone are accepted. Nothing is sent until you press Request Changes.</span>
        </p>
      )}

      {!error && round && source === 'tax' && <RoundSummary round={round} />}

      {!error && groups.length > 0 && (
        isFormation ? (
          // Secondary client details — collapsed by default; the name choices
          // above are the primary content at this stage.
          <details className="group rounded-lg border border-zinc-200 bg-zinc-50/60">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-600 hover:text-zinc-900">
              Client details (owner, address, business purpose…)
            </summary>
            <div className="space-y-4 px-3 pb-3 pt-1">
              {groups.map((group) => (
                <DataGroupBlock key={group.title} group={group} />
              ))}
            </div>
          </details>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <DataGroupBlock
                key={group.title}
                group={group}
                canWrite={canWrite}
                draft={draft}
                roundByKey={roundByKey}
                waiting={round?.waiting ?? false}
                onSaveNote={(key, note) => save({ key, note })}
              />
            ))}
          </div>
        )
      )}

      {!error && canWrite && groups.length > 0 && (
        <MessageBox value={review?.draft.message ?? ''} onSave={(message) => save({ message })} />
      )}
    </div>
  )
}

/** What the newest Request Changes round said, above the answers. */
function RoundSummary({ round }: { round: NonNullable<ReviewPayload['last_round']> }) {
  const sent = formatUploadDate(round.sent_at) ?? ''
  const updated = round.requests.filter((q) => q.outcome !== 'unchanged').length
  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="round-summary">
      <div className="font-medium">
        {round.waiting
          ? `Changes requested ${sent}. Waiting for the client to resubmit.`
          : `The client resubmitted after your request of ${sent}: ${updated} of ${round.requests.length} flagged answer${round.requests.length === 1 ? '' : 's'} changed.`}
      </div>
      {round.message && <div className="mt-1 text-amber-800">Your message: {round.message}</div>}
    </div>
  )
}

function DataGroupBlock({
  group,
  canWrite = false,
  draft = {},
  roundByKey,
  waiting = false,
  onSaveNote,
}: {
  group: DataGroup
  canWrite?: boolean
  draft?: Record<string, string>
  roundByKey?: Map<string, RoundRequest>
  waiting?: boolean
  onSaveNote?: (key: string, note: string) => Promise<string | null>
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        {group.title}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {group.fields.map((f) => (
          <AnswerRow
            key={f.key}
            field={f}
            canWrite={canWrite}
            note={draft[f.key] ?? ''}
            sent={roundByKey?.get(f.key)}
            waiting={waiting}
            onSaveNote={onSaveNote}
          />
        ))}
      </dl>
    </div>
  )
}

function AnswerRow({
  field,
  canWrite,
  note,
  sent,
  waiting,
  onSaveNote,
}: {
  field: DataField
  canWrite: boolean
  note: string
  sent?: RoundRequest
  waiting: boolean
  onSaveNote?: (key: string, note: string) => Promise<string | null>
}) {
  // the editor is open while a request is written, or while staff just clicked the pencil
  const [open, setOpen] = useState(false)
  const flagged = note !== '' || open
  const sentTag = sent ? (waiting ? 'Request sent' : sent.outcome === 'updated' ? 'Updated by client' : sent.outcome === 'removed' ? 'Removed by client' : 'Not changed') : null
  const sentTone = !sent ? '' : waiting ? 'bg-amber-100 text-amber-800' : sent.outcome === 'unchanged' ? 'bg-zinc-100 text-zinc-600' : 'bg-emerald-100 text-emerald-800'

  return (
    <div
      className={`flex flex-col ${flagged || (sent && (waiting || sent.outcome !== 'unchanged')) ? 'rounded-lg border border-amber-200 bg-amber-50/60 px-2 py-1' : ''} ${flagged ? 'sm:col-span-2' : ''}`}
      data-answer-key={field.key}
    >
      <dt className="text-[11px] text-zinc-400">{field.label}</dt>
      <dd className="flex items-start justify-between gap-2 text-sm text-zinc-800 break-words">
        <span className="min-w-0">{field.value}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {sentTag && <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sentTone}`}>{sentTag}</span>}
          {canWrite && (
            <FastTooltip label="Write a request for the client">
              <button
                type="button"
                aria-label={`Write a request for ${field.label}`}
                onClick={() => setOpen((o) => !o)}
                className={`inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border ${note ? 'border-amber-300 bg-white text-amber-700' : 'border-zinc-200 bg-zinc-50 text-zinc-400 hover:text-zinc-700'}`}
              >
                <Pencil className="h-3 w-3" />
              </button>
            </FastTooltip>
          )}
        </span>
      </dd>
      {sent && (
        <div className="mt-1 text-[11px] text-amber-800">
          You asked: {sent.note}
          {!waiting && sent.outcome !== 'unchanged' && sent.was !== null && <span className="text-zinc-500"> · was: {sent.was}</span>}
        </div>
      )}
      {canWrite && flagged && onSaveNote && (
        <NoteEditor
          initial={note}
          onSave={(text) => onSaveNote(field.key, text)}
          onClear={async () => {
            const err = await onSaveNote(field.key, '')
            if (!err) setOpen(false)
            return err
          }}
        />
      )}
    </div>
  )
}

/** A text box that saves on its own a moment after typing stops (and when it loses focus); shows Saved / Saving / the server's reason. */
function NoteEditor({
  initial,
  onSave,
  onClear,
}: {
  initial: string
  onSave: (text: string) => Promise<string | null>
  onClear: () => Promise<string | null>
}) {
  const fieldId = useId()
  const [text, setText] = useState(initial)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>(initial ? 'saved' : 'idle')
  const [err, setErr] = useState<string | null>(null)
  const lastSaved = useRef(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(
    async (value: string) => {
      if (value.trim() === lastSaved.current.trim()) return
      setState('saving')
      const e = await onSave(value)
      if (e) {
        setErr(e)
        setState('idle')
      } else {
        setErr(null)
        lastSaved.current = value.trim()
        setState('saved')
      }
    },
    [onSave],
  )

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div className="mt-1.5">
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-amber-800" htmlFor={fieldId}>
        Your request to the client
      </label>
      <textarea
        id={fieldId}
        value={text}
        rows={2}
        maxLength={1000}
        placeholder="What should the client fix or add?"
        onChange={(e) => {
          setText(e.target.value)
          setState('idle')
          if (timer.current) clearTimeout(timer.current)
          const v = e.target.value
          timer.current = setTimeout(() => void flush(v), 700)
        }}
        onBlur={() => {
          if (timer.current) clearTimeout(timer.current)
          void flush(text)
        }}
        className="w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-amber-400"
      />
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className={err ? 'text-red-600' : 'text-zinc-400'}>
          {err ?? (state === 'saving' ? 'Saving…' : state === 'saved' ? <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Saved</span> : '')}
        </span>
        <button
          type="button"
          onClick={async () => {
            if (timer.current) clearTimeout(timer.current)
            const e = await onClear()
            if (e) setErr(e)
            else { setText(''); lastSaved.current = ''; setErr(null) }
          }}
          className="inline-flex cursor-pointer items-center gap-1 text-zinc-500 hover:text-zinc-800"
        >
          <X className="h-3 w-3" /> Remove request
        </button>
      </div>
    </div>
  )
}

/** The optional note to the client that is not about one answer. */
function MessageBox({ value, onSave }: { value: string; onSave: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState(value)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const last = useRef(value)
  return (
    <div className="mt-4 border-t border-zinc-100 pt-3">
      <label htmlFor="review-message" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Message to the client (optional)
      </label>
      <textarea
        id="review-message"
        value={text}
        rows={2}
        maxLength={2000}
        placeholder="Anything else you want the client to know?"
        onChange={(e) => { setText(e.target.value); setSaved(false) }}
        onBlur={async () => {
          if (text.trim() === last.current.trim()) return
          const e = await onSave(text)
          if (e) setErr(e)
          else { setErr(null); last.current = text.trim(); setSaved(true) }
        }}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-400"
      />
      <div className="mt-1 text-[11px] text-zinc-400">{err ? <span className="text-red-600">{err}</span> : saved ? 'Saved' : 'Sent with your requests when you press Request Changes.'}</div>
    </div>
  )
}
