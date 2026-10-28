'use client'

/**
 * SS-4 correction panel — Company Formation "SS-4 Sent to IRS" stage (waiting for the EIN).
 *
 * "Something is wrong with the SS-4" → pick a reason → the signed/faxed SS-4 is ARCHIVED (kept whole) and a corrected
 * DRAFT is created, all inside this stage (POST /api/flows/[id]/resubmit-ss4 → lib/operations/ss4-resubmit.ts).
 * Nothing is sent to the client and the stage does not move.
 *
 * What the panel shows, by the state of the company's current SS-4:
 *  - signed / faxed (nothing resubmitted yet) → the correction button.
 *  - draft / awaiting signature (a corrected SS-4 in progress) → the normal SS-4 panel (preview, Send to Client for Signature,
 *    Regenerate), so the whole correction is handled right here.
 *  - corrected SS-4 signed → the fax panel (fax the new package) plus the correction button again (a second resubmit is allowed).
 * Archived SS-4s are listed with when / why, so the trail is visible to anyone on the team.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Archive } from 'lucide-react'
import { Ss4Panel } from './ss4-panel'
import { Ss4FaxPanel } from './ss4-fax-panel'
import { FLOW_DOC_UPLOADED_EVENT, type FlowDocUploadedDetail } from './document-upload'

interface Props {
  serviceDeliveryId: string
  accountId?: string | null
}

interface ArchivedRow {
  id: string
  archived_at: string
  archived_by: string | null
  archive_reason: string | null
}

const PRESETS = [
  'Wrong registered agent address',
  'Wrong responsible party',
  'Wrong company name or address',
  'Rejected by the IRS',
  'Other',
] as const

const CORRECTABLE = ['signed', 'submitted', 'done', 'fax_failed']

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function Ss4CorrectionPanel({ serviceDeliveryId, accountId }: Props) {
  const [status, setStatus] = useState<string | null>(null)
  const [archived, setArchived] = useState<ArchivedRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState<string>(PRESETS[0])
  const [detail, setDetail] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ message: string; previewUrl?: string; warnings: string[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, { cache: 'no-store' }),
        fetch(`/api/flows/${serviceDeliveryId}/resubmit-ss4`, { cache: 'no-store' }),
      ])
      const da = await a.json().catch(() => ({}))
      const db = await b.json().catch(() => ({}))
      if (!a.ok || !da.success) throw new Error(da.error || 'Could not load the SS-4.')
      if (!b.ok || !db.success) throw new Error(db.error || 'Could not load the archived SS-4s.')
      setStatus(da.ss4?.status ?? null)
      setArchived(Array.isArray(db.archived) ? db.archived : [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the SS-4.')
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  const reason = preset === 'Other' ? detail.trim() : detail.trim() ? `${preset}: ${detail.trim()}` : preset
  const reasonOk = reason.length >= 3

  async function resubmit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/resubmit-ss4`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not resubmit the SS-4. Nothing was changed.')
      setDone({ message: data.message, previewUrl: data.previewUrl, warnings: Array.isArray(data.warnings) ? data.warnings : [] })
      setOpen(false)
      setConfirming(false)
      setDetail('')
      // the old SS-4's documents were relabelled and the new SS-4's added: make the Documents list on this page re-read them
      window.dispatchEvent(new CustomEvent<FlowDocUploadedDetail>(FLOW_DOC_UPLOADED_EVENT, { detail: { serviceDeliveryId } }))
      await load()
    } catch (err) {
      setConfirming(false)
      setError(err instanceof Error && err.message ? err.message : 'Could not resubmit the SS-4. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="flex items-start gap-1.5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{loadError}</span>
      </div>
    )
  }

  const inProgress = status === 'draft' || status === 'awaiting_signature'
  const canCorrect = !!status && CORRECTABLE.includes(status)
  const correctedSigned = archived.length > 0 && canCorrect

  return (
    <div className="space-y-3">
      {archived.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-zinc-800">
            <Archive className="h-4 w-4 text-zinc-400" /> Previous SS-4s (archived, kept for the record)
          </div>
          <ul className="space-y-1 text-sm text-zinc-600">
            {archived.map((a) => (
              <li key={a.id}>
                {when(a.archived_at)} — {a.archive_reason || 'no reason recorded'}
                {a.archived_by ? <span className="text-zinc-400"> ({a.archived_by})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {done && (
        <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <div className="flex items-start gap-1.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{done.message}</span>
          </div>
          {done.previewUrl && (
            <a
              href={done.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              <ExternalLink className="h-4 w-4" /> Preview the corrected SS-4
            </a>
          )}
          {done.warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      {inProgress && (
        <>
          {archived.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              A corrected SS-4 is in progress. Check the preview, then send it to the client for signature. Once signed, it can be faxed to the IRS from here.
            </p>
          )}
          <Ss4Panel serviceDeliveryId={serviceDeliveryId} accountId={accountId} />
        </>
      )}

      {correctedSigned && status !== 'submitted' && status !== 'done' && <Ss4FaxPanel serviceDeliveryId={serviceDeliveryId} />}

      {canCorrect && (
        <div className="rounded-xl border border-amber-200 bg-white p-4">
          {!open ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-zinc-600">Something wrong with the SS-4 (for example the IRS rejected it)?</p>
              <button
                onClick={() => {
                  setOpen(true)
                  setDone(null)
                  setError(null)
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-50"
              >
                <AlertTriangle className="h-4 w-4" /> Resubmit SS-4…
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Resubmit SS-4</h3>
              <p className="text-sm text-zinc-600">
                The current SS-4 is archived (nothing is deleted) and a corrected draft is created from the company&apos;s current data. Nothing is sent to the client.
              </p>
              <div>
                <label htmlFor="ss4-resubmit-reason" className="mb-1 block text-xs font-medium text-zinc-600">Reason</label>
                <select
                  id="ss4-resubmit-reason"
                  value={preset}
                  disabled={busy}
                  onChange={(e) => {
                    setPreset(e.target.value)
                    setConfirming(false)
                  }}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 disabled:opacity-50"
                >
                  {PRESETS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ss4-resubmit-detail" className="mb-1 block text-xs font-medium text-zinc-600">
                  {preset === 'Other' ? 'What is wrong? (required)' : 'Details (optional)'}
                </label>
                <textarea
                  id="ss4-resubmit-detail"
                  value={detail}
                  disabled={busy}
                  onChange={(e) => {
                    setDetail(e.target.value)
                    setConfirming(false)
                  }}
                  rows={2}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 disabled:opacity-50"
                  placeholder="e.g. Line 6 showed Sheridan County, Wyoming for a New Mexico company"
                />
              </div>
              {confirming ? (
                <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <p><strong>Archive the current SS-4</strong> with the reason “{reason}” and create a corrected draft?</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={resubmit}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                      Yes, archive and create the corrected SS-4
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                      className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={busy || !reasonOk}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => {
                      setOpen(false)
                      setConfirming(false)
                      setError(null)
                    }}
                    disabled={busy}
                    className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
