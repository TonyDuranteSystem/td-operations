'use client'

/**
 * "How they became our client" — the row in Company Info, right above Formation (dev job 5ea6c651).
 *
 * A dropdown with two answers: Formed by us | Onboarded. A client company nobody has checked yet shows a GUESS marked "To check" (worked
 * out on the server from its signed contract or Client Since — nothing is saved until a person acts) and a sentence saying where the
 * guess comes from. "It's correct" saves it at once when everything agrees; when the records disagree, the contract could not be read,
 * or the answer does not fit Client Since, the pop-up opens first with the three dates and a warning. Changing the answer always opens
 * the pop-up. Design: the approved mockup (docs/systems/crm-core.md, "How they became our client"). Nothing in billing reads this yet.
 */
import { useEffect, useState } from 'react'
import { UserCheck, Loader2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { setBecameClientHow } from '@/app/(dashboard)/accounts/actions'
import {
  BECAME_CLIENT_LABEL,
  BECAME_CLIENT_VALUES,
  changeHeadsUp,
  checkedByName,
  etDay,
  evidenceLine,
  isBecameClientHow,
  planConfirm,
  type BecameClientHow,
  type GuessSummary,
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
  /** the saved answer (null for a company nobody has saved an answer for yet) */
  value: string | null
  checkedAt: string | null
  checkedBy: string | null
  /** the guess worked out from the contract and dates; null when the contract could not be read */
  guess: GuessSummary | null
  formationDate: string | null
  clientSince: string | null
  raSwitchDate: string | null
}

type Pending = { mode: 'change' | 'confirm'; value: BecameClientHow; warnings: string[] }

export function BecameClientRow(p: Props) {
  const saved: BecameClientHow | null = isBecameClientHow(p.value) ? p.value : null
  const isClient = p.accountType === 'Client'
  // what the row shows: the saved answer, or — for a client company with none — the guess
  const shown: BecameClientHow | null = saved ?? (isClient && !p.checkedAt && p.guess ? p.guess.value : null)
  const [pending, setPending] = useState<Pending | null>(null) // waiting in the pop-up
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setPending(null)
    setError(null)
  }

  // Escape closes the pop-up (not while it is saving)
  useEffect(() => {
    if (!pending || saving) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPending(null)
        setError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, saving])

  // a company that is not a client and has no answer has nothing to show
  if (!isClient && !saved) return null

  const unchecked = isClient && shown !== null && !p.checkedAt

  async function send(mode: 'change' | 'confirm', value: BecameClientHow) {
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

  function onConfirm() {
    if (!shown) return
    const plan = planConfirm(shown, p.guess, p.clientSince)
    if (plan.direct) {
      void send('confirm', shown)
    } else {
      setError(null)
      setPending({ mode: 'confirm', value: shown, warnings: plan.warnings })
    }
  }

  const isConfirm = pending?.mode === 'confirm'

  return (
    <>
      <div className="flex items-start gap-2" data-testid="became-client-row">
        <UserCheck className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
        <span className="text-muted-foreground min-w-[100px] max-w-[132px] text-sm mt-1">How they became our client</span>
        <div className="flex flex-1 flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="How they became our client"
              value={shown ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (isBecameClientHow(v) && v !== shown) {
                  const headsUp = changeHeadsUp(v, p.clientSince)
                  setError(null)
                  setPending({ mode: 'change', value: v, warnings: headsUp ? [headsUp] : [] })
                }
              }}
              className="rounded-md border bg-background px-2 py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              {shown === null && <option value="">Not set</option>}
              {BECAME_CLIENT_VALUES.map((v) => (
                <option key={v} value={v}>{BECAME_CLIENT_LABEL[v]}</option>
              ))}
            </select>
            {unchecked ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">To check</span>
            ) : shown && p.checkedAt ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Checked</span>
            ) : null}
          </div>
          {unchecked && shown && (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-xs text-muted-foreground">{evidenceLine(shown, p.guess)}</p>
              <button
                type="button"
                disabled={saving}
                onClick={onConfirm}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-950/40 dark:text-blue-300"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                It&apos;s correct
              </button>
            </div>
          )}
          {!unchecked && shown && p.checkedAt && (
            <p className="text-xs text-muted-foreground">
              Checked{checkedByName(p.checkedBy) ? ` by ${checkedByName(p.checkedBy)}` : ''} on {prettyDate(etDay(p.checkedAt))}
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
          onClick={() => { if (!saving) close() }}
        >
          <div className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 id="became-client-title" className="text-base font-semibold">
              {isConfirm ? `Mark how ${p.companyName} became our client as checked?` : `Change how ${p.companyName} became our client?`}
            </h3>
            <p className="text-sm text-muted-foreground">
              {isConfirm ? (
                <>Answer: <b className="text-foreground">{BECAME_CLIENT_LABEL[pending.value]}</b>. </>
              ) : (
                <>From <b className="text-foreground">{shown ? BECAME_CLIENT_LABEL[shown] : 'Not set'}</b> to <b className="text-foreground">{BECAME_CLIENT_LABEL[pending.value]}</b>. </>
              )}
              This decides which date counts as the day they became our client. It will later decide when their yearly invoices start; nothing is invoiced from it yet.
            </p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
              <dt className="text-muted-foreground">Formation</dt>
              <dd className="text-right font-semibold">{prettyDate(p.formationDate)}</dd>
              <dt className="text-muted-foreground">Client Since</dt>
              <dd className="text-right font-semibold">{prettyDate(p.clientSince)}</dd>
              <dt className="text-muted-foreground">RA Switch Date</dt>
              <dd className="text-right font-semibold">{prettyDate(p.raSwitchDate)}</dd>
            </dl>
            {pending.warnings.map((w) => (
              <p key={w} className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">Heads up: {w}</p>
            ))}
            {error && <p className="text-sm font-medium text-red-600">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                autoFocus
                disabled={saving}
                onClick={close}
                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => send(pending.mode, pending.value)}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isConfirm ? 'The dates are correct, mark as checked' : 'The dates are correct, save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
