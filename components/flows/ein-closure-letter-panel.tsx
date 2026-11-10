'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, FileText, Loader2 } from 'lucide-react'
import type { EinClosureFacts } from '@/lib/closure/ein-closure-package'

interface MadeInfo {
  documentId: string
  name: string
  pages: number
  attachedNotice: string | null
}

// Luca's rule (TD Talk, 2026-11-10): the top address is ALWAYS the one printed on the EIN letter — the address the IRS has on file (the main address of the Articles).
const SOURCE_NOTE: Record<EinClosureFacts['addressSource'], string> = {
  suite: 'Our official Largo address, filled in because this company has one of our suites — check it is the address printed on the EIN letter.',
  account: "From the company's record — check it is the address printed on the EIN letter.",
  none: 'Copy the address printed on the EIN letter (the one the IRS has on file).',
}

/**
 * Company Closure, step "IRS Closure": the letter to the IRS, made for you. It has the wording every closure letter has always had,
 * the company's name and EIN, the address, and the owner's name; a copy of the company's EIN letter is attached behind it. Staff check the
 * facts, press the button, open the PDF, print it and mail it — nothing is sent from here (lib/closure/ein-closure-package.ts).
 */
export function EinClosureLetterPanel({ serviceDeliveryId }: { serviceDeliveryId: string }) {
  const router = useRouter()
  const [facts, setFacts] = useState<EinClosureFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [noticeId, setNoticeId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<MadeInfo | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/ein-closure-letter`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'Could not load the letter.')
      const f = data.facts as EinClosureFacts
      setFacts(f)
      setAddress((prev) => prev || f.addressLines.join('\n'))
      setNoticeId((prev) => prev || f.notices.find((n) => n.recommended && n.mergeable && n.storeFileId)?.documentId || '')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load the letter.')
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    void load()
  }, [load])

  async function make() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/ein-closure-letter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, notice_document_id: noticeId || null }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'The letter could not be made.')
      setMade(data.result as MadeInfo)
      await load()
      router.refresh() // the new file appears in the documents list
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The letter could not be made.')
    } finally {
      setBusy(false)
    }
  }

  const link = (id: string) => `/api/documents/${id}/preview`
  const shown = made ?? (facts?.existingLetter ? { documentId: facts.existingLetter.documentId, name: facts.existingLetter.name, pages: 0, attachedNotice: null } : null)

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <FileText className="h-4 w-4 text-zinc-500" /> EIN closure letter for the IRS
      </h3>
      <p className="mt-1 text-xs text-zinc-500">
        Makes the letter and attaches a copy of the company’s EIN letter behind it. Check it, open the PDF, print it and mail it — nothing is sent from here.
      </p>

      {!facts && !error && <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
      {error && <p className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</p>}

      {facts && (
        <div className="mt-3 space-y-3 text-sm">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
            <dt className="text-zinc-500">Company</dt>
            <dd className="font-medium text-zinc-900">{facts.companyName || '—'}{facts.state ? ` (${facts.state})` : ''}</dd>
            <dt className="text-zinc-500">EIN</dt>
            <dd className="font-medium text-zinc-900">{facts.ein || '—'}</dd>
            <dt className="text-zinc-500">Signed by</dt>
            <dd className="font-medium text-zinc-900">{facts.signerName || '—'} <span className="font-normal text-zinc-500">{facts.hasSignature ? '(signature drawn by the client)' : '(a line to sign by hand)'}</span></dd>
          </dl>

          <div>
            <label htmlFor="ein-letter-address" className="block text-xs font-medium text-zinc-700">Company address on the letter — as printed on the EIN letter</label>
            <textarea
              id="ein-letter-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              placeholder={'Street\nCity, State ZIP'}
            />
            <p className="mt-0.5 text-xs text-zinc-500">{SOURCE_NOTE[facts.addressSource]}</p>
          </div>

          <fieldset>
            <legend className="text-xs font-medium text-zinc-700">Copy of the EIN letter to attach</legend>
            <div className="mt-1 space-y-1">
              {facts.notices.map((n) => {
                const usable = n.mergeable && !!n.storeFileId
                return (
                  <label key={n.documentId} className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${usable ? 'border-zinc-200' : 'border-zinc-100 bg-zinc-50 text-zinc-400'}`}>
                    <input type="radio" name="ein-notice" className="mt-1" checked={noticeId === n.documentId} disabled={!usable} onChange={() => setNoticeId(n.documentId)} />
                    <span className="min-w-0 break-words">{n.name}{n.typeLabel ? <span className="text-zinc-500"> · {n.typeLabel}</span> : null}{!usable ? ' — cannot be attached' : ''}</span>
                  </label>
                )
              })}
              <label className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1.5">
                <input type="radio" name="ein-notice" checked={noticeId === ''} onChange={() => setNoticeId('')} />
                <span>No copy — send the letter alone</span>
              </label>
            </div>
          </fieldset>

          {facts.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</p>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy || !address.trim()} onClick={() => void make()} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:bg-zinc-300">
              {busy ? 'Making the letter…' : shown ? 'Make the letter again' : 'Make the letter'}
            </button>
            {shown && (
              <a href={link(shown.documentId)} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-700 underline">Open {shown.name}</a>
            )}
          </div>

          {made && (
            <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Saved on this job — {made.pages} page{made.pages === 1 ? '' : 's'}{made.attachedNotice ? `, with “${made.attachedNotice}” attached` : ', letter only'}. Print it and mail it; then save the tracking number below.</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
