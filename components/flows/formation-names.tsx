'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ExternalLink, Building2, ArrowRight } from 'lucide-react'
import { NAME_STATUS_META, hasFiledName, type NameCheck, type NameCheckStatus } from '@/lib/flows/name-checks'
import { resolveFormationFilingLink } from '@/lib/flows/state-links'
import type { NameAction } from '@/lib/operations/formation-name-checks'

interface FormationNamesProps {
  serviceDeliveryId: string
  stateOfFormation?: string | null
  stage: string | null
}

const BADGE_CLS: Record<NameCheckStatus, string> = {
  pending: 'bg-zinc-100 text-zinc-600',
  available: 'bg-emerald-100 text-emerald-700',
  not_available: 'bg-zinc-200 text-zinc-600',
  sent_to_client: 'bg-amber-100 text-amber-700',
  accepted: 'bg-emerald-100 text-emerald-700',
  rejected_by_client: 'bg-red-100 text-red-700',
  filed: 'bg-blue-100 text-blue-700',
  rejected_by_sos: 'bg-red-100 text-red-700',
}

/**
 * Formation Name Command Center (staff). One row per candidate LLC name with a
 * status badge + the actions valid for that status. Marking "Available" then
 * "Send to Client" creates an approval Client Decision Request behind the
 * scenes; the client's answer flips the badge to Accepted/Client rejected. The
 * gated advance unlocks once a name is Filed. Optimistic UI.
 */
export function FormationNames({ serviceDeliveryId, stateOfFormation, stage }: FormationNamesProps) {
  const [checks, setChecks] = useState<NameCheck[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState(false)
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [advancing, setAdvancing] = useState(false)
  const [requestingNames, setRequestingNames] = useState(false)
  const [requestSent, setRequestSent] = useState(false)

  const sos = resolveFormationFilingLink(stateOfFormation)
  // The name-selection workflow (check on SOS → mark available → send to client →
  // file) belongs to the "Wizard Submitted" stage. Once the SD is at "Filed with
  // State" the selection is DONE: the panel is read-mostly — it shows the filed
  // name with its status and the only corrective action (report a SOS rejection);
  // the other candidates are shown dimmed for reference, with no action buttons.
  const selectionStage = stage === 'Wizard Submitted'

  const load = useCallback(async () => {
    setError(null)
    setAuthError(false)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/name-check`, { cache: 'no-store' })
      // Session lapse: middleware 307-redirects unauthenticated /api/flows
      // requests to the login page (HTML). Detect that (or a 401/403) and show
      // a clear "session" message — the names are NOT lost, they're in the DB.
      if (res.redirected || res.url.includes('/login') || res.status === 401 || res.status === 403) {
        setAuthError(true)
        return
      }
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'Could not load the LLC names.')
      setChecks((data.name_checks as NameCheck[]) ?? [])
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the LLC names.')
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  async function act(nameIndex: number, action: NameAction, optimisticStatus: NameCheckStatus) {
    setBusyIndex(nameIndex)
    setError(null)
    const prev = checks
    // Optimistic: reflect the new status immediately.
    setChecks((cur) => cur.map((c, i) => (i === nameIndex ? { ...c, status: optimisticStatus } : c)))
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/name-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name_index: nameIndex }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not update the name.')
      setChecks((data.name_checks as NameCheck[]) ?? prev)
    } catch (err) {
      setChecks(prev) // revert
      setError(err instanceof Error && err.message ? err.message : 'Could not update the name.')
    } finally {
      setBusyIndex(null)
    }
  }

  async function requestNewNames() {
    setRequestingNames(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/name-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_new_names', name_index: 0 }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not send the request to the client.')
      setRequestSent(true)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the request to the client.')
    } finally {
      setRequestingNames(false)
    }
  }

  async function advance() {
    setAdvancing(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_stage: 'Filed with State' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not advance the stage.')
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not advance the stage.')
      setAdvancing(false)
    }
  }

  function Btn({ onClick, children, variant = 'default' }: { onClick: () => void; children: React.ReactNode; variant?: 'default' | 'primary' | 'danger' }) {
    const cls =
      variant === 'primary'
        ? 'bg-blue-600 text-white hover:bg-blue-700'
        : variant === 'danger'
          ? 'border border-red-200 text-red-700 hover:bg-red-50'
          : 'border border-zinc-300 text-zinc-700 hover:bg-zinc-50'
    return (
      <button onClick={onClick} disabled={busyIndex != null} className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${cls}`}>
        {children}
      </button>
    )
  }

  function rowActions(c: NameCheck, i: number) {
    // Filed-with-State (read-mostly): only a filed name keeps a corrective
    // action — report a Secretary-of-State rejection. Everything else is
    // reference-only here (selection happened on the previous stage).
    if (!selectionStage) {
      if (c.status === 'filed') {
        return <Btn onClick={() => act(i, 'mark_sos_rejected', 'rejected_by_sos')} variant="danger">Mark SOS Rejected</Btn>
      }
      return null
    }
    switch (c.status) {
      case 'pending':
        return (
          <>
            <a href={sos.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
              <ExternalLink className="h-3 w-3" /> Check on SOS ({sos.stateCode})
            </a>
            <Btn onClick={() => act(i, 'mark_available', 'available')} variant="primary">Mark Available</Btn>
            <Btn onClick={() => act(i, 'mark_not_available', 'not_available')}>Mark Not Available</Btn>
          </>
        )
      case 'available':
        return <Btn onClick={() => act(i, 'send_to_client', 'sent_to_client')} variant="primary">Send to Client →</Btn>
      case 'not_available':
        return <Btn onClick={() => act(i, 'mark_available', 'available')}>Mark Available</Btn>
      case 'accepted':
        return (
          <>
            <a href={sos.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700">
              <ExternalLink className="h-3 w-3" /> File on SOS ({sos.stateCode}) →
            </a>
            <Btn onClick={() => act(i, 'mark_filed', 'filed')} variant="primary">Mark as Filed</Btn>
          </>
        )
      case 'filed':
        return <Btn onClick={() => act(i, 'mark_sos_rejected', 'rejected_by_sos')} variant="danger">Mark SOS Rejected</Btn>
      default:
        return null
    }
  }

  const canAdvance = hasFiledName(checks)
  // Every candidate is a dead end (unavailable / rejected by client or SOS) and
  // none is still viable — offer to ask the client for a fresh set of names.
  const allDead =
    checks.length > 0 &&
    checks.every(
      (c) =>
        c.status === 'not_available' ||
        c.status === 'rejected_by_client' ||
        c.status === 'rejected_by_sos',
    )

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">LLC Name Approval</h3>
        {sos.defaulted && <span className="text-[11px] text-zinc-400">· defaulted to New Mexico</span>}
      </div>

      {authError ? (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Your session expired (or you&apos;re not signed in as staff). The names are safe — reload the page.
          <button onClick={load} className="ml-2 rounded-md border border-amber-300 px-2 py-0.5 text-xs font-medium hover:bg-amber-100">
            Retry
          </button>
        </div>
      ) : (
        <>
          {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
          {!error && !loaded && (
            <p className="flex items-center gap-1.5 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          )}
          {!error && loaded && checks.length === 0 && (
            <p className="text-sm text-zinc-500">No names submitted by the client yet.</p>
          )}
        </>
      )}

      {checks.length > 0 && (
        <ul className="space-y-2">
          {checks.map((c, i) => {
            const meta = NAME_STATUS_META[c.status]
            return (
              <li key={`${c.name}-${i}`} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2 ${!selectionStage && c.status !== 'filed' ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-zinc-900 break-words">{c.name}</span>
                  {c.source === 'client_resubmit' && <span className="text-[10px] text-zinc-400">(client-proposed)</span>}
                  {c.source === 'client_suggestion' && <span className="text-[10px] font-medium text-blue-500">(client suggested)</span>}
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${BADGE_CLS[c.status]}`}>
                    {meta.emoji} {meta.label}
                  </span>
                  {c.status === 'sent_to_client' && c.updated_at && (
                    <span className="text-[10px] text-zinc-400">Sent {new Date(c.updated_at).toLocaleDateString()}</span>
                  )}
                  {busyIndex === i && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">{rowActions(c, i)}</div>
                {/* Client's rejection reason, shown under the badge (basis-full
                    pushes it to its own line via the row's flex-wrap). */}
                {c.note && (
                  <div className="basis-full text-[11px] text-red-600">
                    Client note: &ldquo;{c.note}&rdquo;
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {selectionStage && allDead && (
        <div className="mt-4 border-t border-zinc-100 pt-3">
          {requestSent ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Request sent — waiting for the client to propose new names. They&apos;ll appear here once submitted.
            </p>
          ) : (
            <>
              <button
                onClick={requestNewNames}
                disabled={requestingNames}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {requestingNames ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Request New Names from Client
              </button>
              <p className="mt-1.5 text-[11px] text-zinc-400">None of the current names are viable — ask the client to propose 3 new LLC names.</p>
            </>
          )}
        </div>
      )}

      {stage === 'Wizard Submitted' && (
        <div className="mt-4 border-t border-zinc-100 pt-3">
          <button
            onClick={advance}
            disabled={!canAdvance || advancing}
            title={canAdvance ? undefined : 'File an accepted name on the SOS first'}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {advancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Name Confirmed &amp; Filed — Waiting for Articles
          </button>
          {!canAdvance && <p className="mt-1.5 text-[11px] text-zinc-400">Enabled once a client-accepted name is filed with the Secretary of State.</p>}
        </div>
      )}
    </div>
  )
}
