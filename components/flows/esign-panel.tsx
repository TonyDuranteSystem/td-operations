'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileSignature, Loader2, ExternalLink, CheckCircle2 } from 'lucide-react'
import { esignStatusLabel, type EsignEnvelopeRow } from '@/lib/esign/delivery-envelopes'

interface EsignPanelProps {
  serviceDeliveryId: string
  accountId: string | null
  contactId: string | null
  companyName: string | null
  /** Button label from the stage layout (default "Prepare the form for signature"). */
  label?: string
  /** Heading of the panel (default "Form for the client to sign"). Tax Return: "Return for the client to sign". */
  title?: string
  /** The sentence under the heading, from the stage layout (`helpText`). Default: the Company Change Name wording. */
  helpText?: string
  /** The document's default name in the e-sign editor. Default: "Company name change form — <company>". Tax Return: "Tax Return 2025 - <company>". */
  docName?: string
  /** Status only: no button to prepare another document (used on the step after the signature). */
  readOnly?: boolean
}

/**
 * E-sign of a form for THIS delivery (Company Change Name: the state's name-change form the client signs; Tax Return: the prepared return).
 * Staff prepare it in the e-sign editor (opened with the company, the client and this delivery already
 * linked), and see here whether it was sent and signed. The delivery moves on by itself (lib/esign/delivery-advance.ts):
 * when the document is SENT for the services that have a "sent" step (Tax Return) and when the client has SIGNED — nothing to press.
 */
export function EsignPanel({ serviceDeliveryId, accountId, contactId, companyName, label, title, helpText, docName, readOnly }: EsignPanelProps) {
  const [envelopes, setEnvelopes] = useState<EsignEnvelopeRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/esign`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'Could not load the signing status.')
      setEnvelopes((data.envelopes as EsignEnvelopeRow[]) ?? [])
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the signing status.')
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    void load()
  }, [load])

  const params = new URLSearchParams()
  if (accountId) params.set('account', accountId)
  if (contactId) params.set('contact', contactId)
  params.set('sd', serviceDeliveryId)
  const defaultName = docName || (companyName ? `Company name change form — ${companyName}` : null)
  if (defaultName) params.set('name', defaultName)
  const editorHref = `/tools/esign/new?${params.toString()}`

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <FileSignature className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">{title || 'Form for the client to sign'}</h3>
      </div>
      <p className="mb-3 text-sm text-zinc-500">
        {helpText ?? (
          <>
            Fill in the state&apos;s name-change form with the confirmed name, upload it in the signing editor, place the signature field and send it.
            The job moves on by itself when the client has signed.
          </>
        )}
      </p>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {!error && !loaded && (
        <p className="flex items-center gap-1.5 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      )}

      {loaded && envelopes.length === 0 && <p className="mb-3 text-sm text-zinc-500">No form has been sent for signature yet.</p>}
      {envelopes.length > 0 && (
        <ul className="mb-3 space-y-2">
          {envelopes.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-900">{e.document_name}</div>
                <div className="text-[11px] text-zinc-400">
                  Created {new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {e.signed_count != null && e.total_signers != null ? ` · ${e.signed_count} of ${e.total_signers} signed` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${e.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : e.status === 'voided' || e.status === 'expired' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                  {e.status === 'completed' && <CheckCircle2 className="h-3 w-3" />}
                  {esignStatusLabel(e.status)}
                </span>
                <a href={`/tools/esign/${e.id}`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">Open</a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <a
          href={editorHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <ExternalLink className="h-4 w-4" />
          {label || 'Prepare the form for signature'}
        </a>
      )}
      <button onClick={load} className={`${readOnly ? '' : 'ml-2 '}text-xs text-zinc-500 hover:text-zinc-800 hover:underline`}>Refresh status</button>
    </div>
  )
}
