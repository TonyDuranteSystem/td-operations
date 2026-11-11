'use client'

/**
 * Renewal details — opens when a renewal row is clicked on the Calendar (or a
 * company in the "date doesn't match" list). Shows EVERY date the CRM holds for
 * the company and, if the stored renewal date is wrong, lets staff pick the
 * right one (dev job 51324085).
 *
 * The rule (Antonio, 2026-11-10): Client Since filled = we onboarded a company
 * they already had, so the Registered Agent renewal is the anniversary of
 * Client Since. Client Since empty = we created the company, so it is the
 * anniversary of Formation. The old Onboarding date and the RA Switch Date are
 * shown but play no part.
 *
 * Saving goes through POST /api/calendar/correct-renewal-date, which updates
 * the account's date, the client-portal deadline and the open renewal job in
 * one go and writes the audit line. Marking a filing stays in MarkFiledDialog
 * (reached from here for rows that are due).
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Loader2, AlertTriangle, CheckCircle2, ExternalLink, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { RenewalRow } from '@/app/(dashboard)/calendar/page'
import { CORRECTION_REASON_LABEL, reasonsFor, type CorrectionReason } from '@/lib/operations/renewal-correction-reasons'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-12-10' → '10 Dec 2026' (string math: no timezone drift). */
export function formatDay(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—'
  const [y, m, d] = iso.split('-')
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`
}

interface DateLine {
  key: string
  label: string
  /** null = not set. */
  value: string | null
  hint?: string
  /** Client Since: the date that decides how the renewal is measured. */
  main?: boolean
  /** The date being checked in this pop-up. */
  current?: boolean
  /** Shown instead of "not set" when the value is empty. */
  emptyText?: string
}

interface DateGroup { title: string; lines: DateLine[] }

function groupsFor(row: RenewalRow): DateGroup[] {
  const d = row.dates
  if (!d) return []
  return [
    {
      title: 'Company',
      lines: [{ key: 'formation', label: 'Formation', value: d.formation, hint: 'day the company was incorporated' }],
    },
    {
      title: 'With us',
      lines: [
        { key: 'onboarding', label: 'Onboarding date', value: d.onboarding, hint: 'old field, a copy of Formation for companies we created. Not used.' },
        {
          key: 'clientSince', label: 'Client Since ★', value: d.clientSince, main: true, emptyText: 'empty',
          hint: d.clientSince ? 'filled = we onboarded a company they already had' : 'empty = we created this company',
        },
        { key: 'raSwitch', label: 'RA Switch Date', value: d.raSwitch, hint: 'day the agent changed to Harbor. Shown, not used.' },
        { key: 'portalCreated', label: 'Portal created', value: d.portalCreated },
      ],
    },
    {
      title: 'Renewals',
      lines: [
        { key: 'raRenewal', label: 'RA renewal', value: row.due_date, current: true, hint: '← the date you are checking' },
        { key: 'mailingAddress', label: 'Mailing address', value: d.mailingAddress, hint: 'renewal of the mailing address lease' },
      ],
    },
    {
      title: 'Other',
      lines: [
        { key: 'setupFee', label: 'Setup fee', value: d.setupFee, hint: `date paid: ${d.setupFeePaid ? formatDay(d.setupFeePaid) : 'not set'}` },
        { key: 'cancellation', label: 'Cancellation', value: d.cancellation, hint: 'date the company or service was cancelled' },
        { key: 'remindersPaused', label: 'Reminders paused', value: d.remindersPausedUntil, hint: 'payment reminders are paused until this date' },
      ],
    },
  ]
}

interface Props {
  row: RenewalRow
  onClose: () => void
  /** Given only when this row may be marked filed (due within 30 days or overdue). */
  onMarkFiled?: () => void
}

export function RenewalDetailsDialog({ row, onClose, onMarkFiled }: Props) {
  const router = useRouter()
  const kindLabel = 'Registered Agent renewal'
  const check = row.date_check ?? null
  const basisLabel = check?.basis === 'client_since' ? 'Client Since' : 'Formation'

  // Today (UTC date, the same day the server uses to judge "past due").
  const today = new Date().toISOString().slice(0, 10)
  const pastDue = row.due_date < today
  // Moving a PAST-DUE date forward makes the overdue flag disappear, so it needs a confirmation and a real reason.
  const forwardFromPastDue = (date: string) => pastDue && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today
  const prefill = check?.mismatch && check.expected ? check.expected : ''
  const prefillReason: CorrectionReason | '' = prefill && !forwardFromPastDue(prefill) ? 'matches_rule' : ''

  const [editing, setEditing] = useState(false)
  const [newDate, setNewDate] = useState<string>(prefill)
  const [reason, setReason] = useState<CorrectionReason | ''>(prefillReason)
  const [note, setNote] = useState('')
  const [confirmOverdue, setConfirmOverdue] = useState(false)
  const [saving, setSaving] = useState(false)

  const needsOverdueConfirm = forwardFromPastDue(newDate)
  const reasonOptions = reasonsFor().filter(r => !(needsOverdueConfirm && r === 'matches_rule'))

  // Escape closes the pop-up (never while saving).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saving, onClose])

  function changeDate(value: string) {
    setNewDate(value)
    // "Matches the renewal rule" is only true for the rule date itself.
    if (reason === 'matches_rule' && (!check || value !== check.expected || forwardFromPastDue(value))) setReason('')
  }

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(newDate) && newDate !== row.due_date
  const canSave = dateOk && !!reason && (reason !== 'other' || !!note.trim()) && (!needsOverdueConfirm || confirmOverdue) && !saving

  async function save() {
    if (!canSave || !reason) return
    setSaving(true)
    try {
      const res = await fetch('/api/calendar/correct-renewal-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: row.account_id,
          from: row.due_date,
          to: newDate,
          reason,
          note: note.trim() || null,
          ...(needsOverdueConfirm ? { confirm_overdue: confirmOverdue } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'The date could not be changed — please try again.')
      toast.success(data.message || `${row.company_name}: date changed to ${formatDay(newDate)}.`)
      for (const w of (data.warnings ?? []) as string[]) toast.warning(w, { duration: 20000 })
      onClose()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'The date could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  const jobLabel =
    row.status === 'blocked' ? 'On hold — unpaid invoice'
      : row.status === 'offboarding' ? 'Company is closing'
        : row.delivery_id ? 'Renewal job open' : 'No renewal job yet'

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={() => !saving && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col pointer-events-auto"
          onClick={e => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`${kindLabel} details`}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">{kindLabel} — details</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{row.company_name}</p>
            </div>
            <button type="button" onClick={onClose} disabled={saving} className="p-1 rounded hover:bg-zinc-100 disabled:opacity-50" aria-label="Close">
              <X className="h-5 w-5 text-zinc-500" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <div className="grid grid-cols-[130px_1fr] gap-y-1.5 text-xs">
              <span className="text-zinc-500">State</span>
              <span className="font-medium">{row.state_of_formation ?? '—'}</span>

              <span className="text-zinc-500">Agent</span>
              <span className="font-medium">
                {row.provider ?? <em className="text-zinc-400">none</em>}
                {row.agent_name ? ` · ${row.agent_name}` : ''}
              </span>

              <span className="text-zinc-500">Job</span>
              <span className="font-medium">{jobLabel}</span>
            </div>

            {row.engine_status === 'overdue' && (
              <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="status-box">
                <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /> This renewal is overdue.</p>
                {row.engine_cause && <p className="mt-1">{row.engine_cause}</p>}
                <p className="mt-1">Changing the date forward hides this flag. Do it only if Harbor (or the state website) shows the renewal was really done or the date was wrong from the start.</p>
              </div>
            )}
            {row.engine_status === 'on_hold_unpaid' && (
              <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900" data-testid="status-box">
                <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /> On hold — unpaid invoice.</p>
                {row.engine_cause && <p className="mt-1">{row.engine_cause}</p>}
              </div>
            )}

            <div className="border border-zinc-200 rounded-md overflow-hidden text-xs" data-testid="all-dates">
              {groupsFor(row).map(group => (
                <div key={group.title}>
                  <div className="bg-zinc-50 text-zinc-500 text-[10px] font-bold tracking-wider uppercase px-2.5 py-1 border-t border-zinc-200 first:border-t-0">
                    {group.title}
                  </div>
                  {group.lines.map(line => (
                    <div
                      key={line.key}
                      data-testid={`date-${line.key}`}
                      className={cn(
                        'grid grid-cols-[112px_84px_1fr] gap-2 px-2.5 py-1.5 border-t border-zinc-100 items-baseline',
                        line.main && 'bg-blue-50 shadow-[inset_3px_0_0_#2563eb]',
                        line.current && 'bg-orange-50 shadow-[inset_3px_0_0_#f97316]',
                      )}
                    >
                      <span className={cn('text-zinc-600', line.main && 'text-blue-700 font-semibold')}>{line.label}</span>
                      <span className={cn('font-semibold whitespace-nowrap', !line.value && 'text-zinc-400 font-normal')}>
                        {line.value ? formatDay(line.value) : (line.emptyText ?? 'not set')}
                      </span>
                      <span className={cn('text-[11px] text-zinc-500', line.current && 'text-orange-700 font-semibold')}>{line.hint}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {check?.mismatch && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1.5" data-testid="mismatch-banner">
                <p className="flex items-start gap-1.5 font-medium">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                  <span>
                    {check.basis === 'client_since'
                      ? `Client Since is filled, so this company came to us. The CRM date does not fall on the anniversary of Client Since (${formatDay(check.start)}).`
                      : `Client Since is empty, so this is treated as a company we created. The CRM date does not fall on the anniversary of Formation (${formatDay(check.start)}).`}
                  </span>
                </p>
                {check.expected && (
                  <p>
                    By the renewal rule it would be <strong>{formatDay(check.expected)}</strong>. That assumes every past year
                    was renewed on schedule — <strong>confirm in Harbor Compliance before changing it.</strong>
                  </p>
                )}
              </div>
            )}
            {check && !check.mismatch && (
              <p className="flex items-start gap-1.5 text-xs text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  {check.basis === 'client_since'
                    ? `Client Since is filled, so this company came to us. The date matches the anniversary of Client Since (${formatDay(check.start)}).`
                    : `Client Since is empty, so this is treated as a company we created. The date matches the anniversary of Formation (${formatDay(check.start)}).`}
                </span>
              </p>
            )}
            {!check && (
              <p className="text-xs text-zinc-500">
                Neither Client Since nor Formation is recorded for this company, so there is nothing to compare this date with.
              </p>
            )}

            {!editing ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={row.status === 'offboarding'}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border rounded-md hover:bg-zinc-50 disabled:opacity-50"
              >
                <Pencil className="h-3.5 w-3.5" /> This date is wrong — correct it
              </button>
            ) : (
              <div className="rounded-md border p-3 space-y-3 bg-zinc-50/60" data-testid="correct-form">
                <div>
                  <label htmlFor="renewal-new-date" className="block text-xs font-medium text-zinc-600 mb-1">
                    Right date <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="renewal-new-date"
                    type="date"
                    value={newDate}
                    onChange={e => changeDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {check?.expected && newDate !== check.expected && (
                    <button type="button" onClick={() => { setNewDate(check.expected!); setReason(forwardFromPastDue(check.expected!) ? '' : 'matches_rule') }} className="mt-1 text-[11px] text-blue-600 hover:underline">
                      Use {formatDay(check.expected)} (rule date, anniversary of {basisLabel})
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="renewal-reason" className="block text-xs font-medium text-zinc-600 mb-1">
                    Why is it being changed? <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="renewal-reason"
                    value={reason}
                    onChange={e => setReason(e.target.value as CorrectionReason | '')}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Choose…</option>
                    {reasonOptions.map(r => (
                      <option key={r} value={r}>{CORRECTION_REASON_LABEL[r]}</option>
                    ))}
                  </select>
                </div>
                {needsOverdueConfirm && (
                  <label className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-md p-2" data-testid="overdue-confirm">
                    <input
                      type="checkbox"
                      checked={confirmOverdue}
                      onChange={e => setConfirmOverdue(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>This renewal is past due. I checked in Harbor Compliance that it was really renewed (or that the date was wrong from the start). Moving the date forward hides the overdue flag.</span>
                  </label>
                )}
                <div>
                  <label htmlFor="renewal-note" className="block text-xs font-medium text-zinc-600 mb-1">
                    Note{reason === 'other' ? <span className="text-red-500"> * (required)</span> : ' (optional)'}
                  </label>
                  <textarea
                    id="renewal-note"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    rows={2}
                    maxLength={500}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-zinc-500">
                  Saving changes the date on the Calendar, on the client’s portal deadline and on the open renewal job.
                  Nothing is filed and the client is not contacted. The change is logged.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={save}
                    disabled={!canSave}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save new date
                  </button>
                  <button type="button" onClick={() => setEditing(false)} disabled={saving} className="px-3 py-2 text-sm border rounded-md hover:bg-zinc-100 disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className={cn('flex items-center gap-2 px-6 py-3 border-t shrink-0', onMarkFiled ? 'justify-between' : 'justify-end')}>
            {onMarkFiled && (
              <button
                type="button"
                onClick={onMarkFiled}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 disabled:opacity-50"
              >
                <AlertTriangle className="h-4 w-4" /> {check?.mismatch ? 'Mark filed anyway…' : 'Mark filed…'}
              </button>
            )}
            <div className="flex items-center gap-3">
              <a href={`/accounts/${row.account_id}`} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                Open account <ExternalLink className="h-3 w-3" />
              </a>
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
