'use client'

/**
 * "How they became our client" — the row in Company Info, right above Formation (dev job 5ea6c651).
 *
 * A dropdown with two answers: Formed by us | Onboarded. A company starts with a GUESS marked "To check" (and a sentence saying where
 * the guess comes from) until a person presses "It's correct" or changes it. Changing opens a pop-up that shows the three dates and asks
 * the person to check them before saving. Design: the approved mockup (docs/systems/crm-core.md, "How they became our client").
 * Nothing in billing reads this yet.
 */
import { useState } from 'react'
import { UserCheck, Loader2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { setBecameClientHow } from '@/app/(dashboard)/accounts/actions'
import {
  BECAME_CLIENT_LABEL,
  BECAME_CLIENT_VALUES,
  changeHeadsUp,
  checkedByName,
  becameClientLabel,
  isBecameClientHow,
  type BecameClientHow,
} from '@/lib/accounts/became-client'

const prettyDate = (d: string | null): string => {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

interface Props {
  accountId: string
  companyName: string
  accountType: string | null
  updatedAt: string
  value: string | null
  checkedAt: string | null
  checkedBy: string | null
  /** one sentence saying where the guess comes from (only while unchecked) */
  hint: string | null
  formationDate: string | null
  clientSince: string | null
  raSwitchDate: string | null
}

export function BecameClientRow(p: Props) {
  const current: BecameClientHow | null = isBecameClientHow(p.value) ? p.value : null
  const [pending, setPending] = useState<BecameClientHow | null>(null) // the answer the person picked, waiting in the pop-up
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // a company that is not a client has nothing to answer
  if (p.accountType !== 'Client' && !current) return null

  const unchecked = current !== null && !p.checkedAt

  async function send(mode: 'change' | 'confirm', value: BecameClientHow | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await setBecameClientHow(p.accountId, value, mode, p.updatedAt)
      if (!res.success) throw new Error(res.error || 'Could not save. Please try again.')
      toast.success(mode === 'confirm' ? 'Marked as checked' : 'Saved')
      if (res.warning) toast.warning(res.warning)
      setPending(null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const headsUp = pending ? changeHeadsUp(pending, p.clientSince) : null

  return (
    <>
      <div className="flex items-start gap-2" data-testid="became-client-row">
        <UserCheck className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
        <span className="text-muted-foreground min-w-[100px] max-w-[132px] text-sm mt-1">How they became our client</span>
        <div className="flex flex-1 flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="How they became our client"
              value={current ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (isBecameClientHow(v) && v !== current) {
                  setError(null)
                  setPending(v)
                }
              }}
              className="rounded-md border bg-background px-2 py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              {current === null && <option value="">Not set</option>}
              {BECAME_CLIENT_VALUES.map((v) => (
                <option key={v} value={v}>{BECAME_CLIENT_LABEL[v]}</option>
              ))}
            </select>
            {unchecked ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">To check</span>
            ) : current && p.checkedAt ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Checked</span>
            ) : null}
          </div>
          {unchecked && (
            <div className="flex flex-col items-start gap-1.5">
              {p.hint && <p className="text-xs text-muted-foreground">{p.hint}</p>}
              <button
                type="button"
                disabled={saving}
                onClick={() => send('confirm', null)}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-950/40 dark:text-blue-300"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                It&apos;s correct
              </button>
            </div>
          )}
          {!unchecked && current && p.checkedAt && (
            <p className="text-xs text-muted-foreground">
              Checked{checkedByName(p.checkedBy) ? ` by ${checkedByName(p.checkedBy)}` : ''} on {prettyDate(p.checkedAt.slice(0, 10))}
            </p>
          )}
          {!pending && error && <p className="text-xs font-medium text-red-600">{error}</p>}
        </div>
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="became-client-title"
          onClick={() => { if (!saving) setPending(null) }}
        >
          <div className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 id="became-client-title" className="text-base font-semibold">Change how {p.companyName} became our client?</h3>
            <p className="text-sm text-muted-foreground">
              From <b className="text-foreground">{becameClientLabel(current)}</b> to <b className="text-foreground">{BECAME_CLIENT_LABEL[pending]}</b>.
              This decides which date counts as the day they became our client, and so when their yearly invoices start.
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
              <dt className="text-muted-foreground">Formation</dt>
              <dd className="text-right font-semibold">{prettyDate(p.formationDate)}</dd>
              <dt className="text-muted-foreground">Client Since</dt>
              <dd className="text-right font-semibold">{prettyDate(p.clientSince)}</dd>
              <dt className="text-muted-foreground">RA Switch Date</dt>
              <dd className="text-right font-semibold">{prettyDate(p.raSwitchDate)}</dd>
            </dl>
            {headsUp && (
              <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">Heads up: {headsUp}</p>
            )}
            {error && <p className="text-sm font-medium text-red-600">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setPending(null)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => send('change', pending)}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                The dates are correct, save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
