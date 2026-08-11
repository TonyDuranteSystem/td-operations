'use client'

import { useState, useEffect, useCallback } from 'react'
import { FileText, Loader2, CheckCircle2, AlertCircle, Clock, ExternalLink, RotateCcw } from 'lucide-react'

interface Ss4PanelProps {
  serviceDeliveryId: string
  /** SD's account_id — empty until the company is materialized at Articles Received. */
  accountId?: string | null
}

interface Ss4Record {
  id: string
  status: string
  company_name: string
  signed_at?: string | null
  previewUrl?: string
  contact_id?: string | null
  responsible_party_name?: string | null
}

/** A person linked to the account — any role. Roles inform, they never restrict. */
interface SignerCandidate {
  contact_id: string
  full_name: string
  email: string | null
  role: string | null
}

/**
 * SS-4 panel for the Company Formation "SS-4 Prepared" workspace stage. Reads the
 * SD's account's SS-4 (GET /api/flows/[id]/generate-ss4) and offers the next
 * action by status:
 *   none  → "Generate SS-4" (POST generate-ss4; surfaces the real blocker, e.g.
 *           "Registered Agent not set", per R099)
 *   draft → preview link + "Send to Client for Signature" (POST send-ss4)
 *           + "Regenerate from account data" (POST {regenerate:true})
 *   awaiting_signature → waiting notice + regenerate (member data may have
 *           changed after the invite went out — the refresh keeps the link and
 *           re-notifies the signer only if the signer changed)
 *   signed → signed confirmation (locked — no regenerate)
 */
export function Ss4Panel({ serviceDeliveryId, accountId }: Ss4PanelProps) {
  const [ss4, setSs4] = useState<Ss4Record | null>(null)
  const [candidates, setCandidates] = useState<SignerCandidate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const hasAccount = !!accountId

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        setSs4(data.ss4 ?? null)
        setCandidates(Array.isArray(data.candidates) ? data.candidates : [])
      }
    } finally {
      setLoaded(true)
    }
  }, [serviceDeliveryId])

  // Change the responsible party. The server resets an already-sent SS-4 to
  // draft and rotates the access code, so the previous signer's link dies.
  async function setSigner(contactId: string) {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_signer: contactId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not change the responsible party.')
      }
      if (data.unchanged) {
        setInfo('That person is already the responsible party.')
      } else {
        setInfo(
          data.status_reset
            ? 'Responsible party changed. The SS-4 went back to draft and the previous signing link no longer works — send it again when you are ready.'
            : 'Responsible party changed. The previous signing link no longer works.',
        )
      }
      // Re-read from the server rather than trusting the response shape — the
      // status and the preview link both change on a switch.
      await load()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not change the responsible party.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not generate the SS-4.')
      }
      setSs4(data.ss4 ?? null)
      // Honest already-exists messaging: nothing was refreshed.
      if (data.already_existed && data.note) setInfo(data.note)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not generate the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  async function regenerate() {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/generate-ss4`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not regenerate the SS-4.')
      }
      // Truthful notification claim (council minor, 2026-08-11): the refresh
      // notifies the new signer ONLY on an awaiting_signature record — a draft
      // stays silent by design, so never tell staff the client was pinged.
      const wasAwaiting = ss4?.status === 'awaiting_signature'
      const base = data.unchanged
        ? 'Already up to date — the SS-4 matches the current account and member data.'
        : data.signer_changed
          ? wasAwaiting
            ? 'Refreshed — the responsible party changed; the new signer has been notified.'
            : 'Refreshed — the responsible party changed. The draft is NOT sent yet; use "Send to Client for Signature" when ready.'
          : 'Refreshed from current account and member data — same client link.'
      setInfo(data.note ? `${base} ${data.note}` : base)
      // Re-read from the server instead of trusting the regenerate response:
      // it omits the responsible-party fields, and setting it directly blanked
      // the card's signer block until a page reload (council minor, 2026-08-10).
      await load()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not regenerate the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/send-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not send the SS-4 to the client.')
      }
      setSs4((prev) => (prev ? { ...prev, status: data.status || 'awaiting_signature' } : prev))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not send the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/resend-ss4`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not re-send the SS-4 for signature.')
      }
      setSs4((prev) => (prev ? { ...prev, status: data.status || 'awaiting_signature', signed_at: null } : prev))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not re-send the SS-4.')
    } finally {
      setBusy(false)
    }
  }

  function formatDate(d?: string | null): string {
    if (!d) return ''
    try {
      return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    } catch {
      return d
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <FileText className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">SS-4 (EIN Application)</h3>
      </div>

      {/* ── Responsible party (IRS Line 7a) ──
          Deliberately the FIRST thing on the card and always visible: the signer
          is picked automatically at creation from a role hint, so a wrong default
          has to be catchable at a glance during review (ACE Marketing Group LLC,
          2026-08-10). Staff may change it right up until the form is signed —
          any linked person, whatever their role, because the SS-4 responsible
          party is decoupled from ownership. */}
      {loaded && ss4 && (
        <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Responsible party (signs the SS-4)
          </div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-900">
            {ss4.responsible_party_name || 'Not set'}
          </div>

          {ss4.status === 'signed' || ss4.status === 'submitted' ? (
            <p className="mt-1.5 text-xs text-zinc-500">
              Signed — the responsible party can no longer be changed.
            </p>
          ) : candidates.length === 0 ? (
            <p className="mt-1.5 text-xs text-zinc-500">
              No people are linked to this company yet.
            </p>
          ) : (
            <div className="mt-2">
              <label htmlFor="ss4-signer" className="sr-only">
                Change the responsible party
              </label>
              <select
                id="ss4-signer"
                value={ss4.contact_id ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value
                  if (next && next !== (ss4.contact_id ?? '')) setSigner(next)
                }}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 disabled:opacity-50"
              >
                {/* Only shown when the stamped contact isn't among the links —
                    stale data rather than a real choice. */}
                {!candidates.some((c) => c.contact_id === (ss4.contact_id ?? '')) && (
                  <option value={ss4.contact_id ?? ''}>
                    {ss4.responsible_party_name || 'Current'} (not linked to this company)
                  </option>
                )}
                {candidates.map((c) => (
                  <option key={c.contact_id} value={c.contact_id}>
                    {c.full_name}
                    {c.role ? ` — ${c.role}` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-zinc-500">
                Changing this rewrites the form and revokes the previous signing link.
                {ss4.status === 'awaiting_signature' ? ' It also returns the SS-4 to draft.' : ''}
              </p>
            </div>
          )}
        </div>
      )}

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !ss4 ? (
        // ── No SS-4 yet ──
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">No SS-4 generated yet.</p>
          {!hasAccount ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              The CRM account isn&apos;t created yet — reach &quot;Articles Received&quot; to materialize the company first.
            </p>
          ) : (
            <button
              onClick={generate}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Generate SS-4
            </button>
          )}
        </div>
      ) : ss4.status === 'signed' || ss4.status === 'submitted' ? (
        // ── Signed ──
        <div className="space-y-3">
          <div className="flex items-start gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Signed by client{ss4.signed_at ? ` on ${formatDate(ss4.signed_at)}` : ''}.</span>
          </div>
          {/* Re-open for re-signature when the signature is bad/missing (e.g. the
              client tapped a single dot). Clears the signature and drops back to
              awaiting; the client re-signs on the same link. */}
          <button
            onClick={resend}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Re-send for Signature
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      ) : ss4.status === 'awaiting_signature' ? (
        // ── Awaiting signature ──
        <div className="space-y-3">
          <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Waiting for the client to sign in the portal.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ss4.previewUrl && (
              <a
                href={ss4.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100"
              >
                <ExternalLink className="h-4 w-4" /> Preview SS-4
              </a>
            )}
            <button
              onClick={regenerate}
              disabled={busy}
              title="Refresh the unsigned SS-4 from current account & member data — same client link. If the responsible party changes, the new signer is notified."
              className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Regenerate from account data
            </button>
          </div>
        </div>
      ) : (
        // ── Draft ──
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">Draft</span>
            {ss4.previewUrl && (
              <a
                href={ss4.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100"
              >
                <ExternalLink className="h-4 w-4" /> Preview SS-4
              </a>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={send}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Send to Client for Signature
            </button>
            <button
              onClick={regenerate}
              disabled={busy}
              title="Refresh the draft SS-4 from current account & member data — entity type, members, signer, addresses."
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Regenerate from account data
            </button>
          </div>
        </div>
      )}

      {info && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{info}</span>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
