'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, FileText, Loader2 } from 'lucide-react'
import type { EinClosureFacts } from '@/lib/closure/ein-closure-package'
import { MAX_ADDRESS_LINES, MAX_ADDRESS_LINE_CHARS } from '@/lib/closure/ein-letter-wording'

interface MadeInfo {
  documentId: string
  name: string
  pages: number
  attachedNotice: string | null
  signed?: boolean
  warnings?: string[]
}

/** The day the client signed, in New York time (the UTC date is already tomorrow's after 8 pm there). */
const signedDay = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
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
  // null = staff have not chosen yet (the box preselects the certain one); '' = staff chose "No copy" — that choice must survive a reload of the facts
  const [noticeId, setNoticeId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<MadeInfo | null>(null)
  // A job with NO company of ours (a closure for a company that is not a client): there is no record to trust, so staff can fix a typo in the name or
  // EIN the client wrote before the letter goes to the IRS. `forKey` ties the typed values to the client's answers they were prefilled from — new answers replace them.
  const [edit, setEdit] = useState<{ forKey: string; name: string; ein: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/ein-closure-letter`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) throw new Error(data?.error || 'Could not load the letter.')
      const f = data.facts as EinClosureFacts
      setFacts(f)
      const key = `${f.wizardCompanyName}|${f.wizardEin}`
      setEdit((prev) => (prev && prev.forKey === key ? prev : { forKey: key, name: f.wizardCompanyName, ein: f.wizardEin }))
      setAddress((prev) => prev || f.addressLines.join('\n'))
      const preselected = f.notices.find((n) => n.recommended && n.mergeable && n.storeFileId)?.documentId || ''
      setNoticeId((prev) => (prev === null ? preselected : prev === '' ? '' : f.notices.some((n) => n.documentId === prev && n.mergeable && n.storeFileId) ? prev : preselected))
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
        body: JSON.stringify({
          address,
          notice_document_id: noticeId || null,
          facts_hash: facts?.factsHash ?? null,
          ...(facts && !facts.hasCompany && edit ? { company_name: edit.name, ein: edit.ein } : {}),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || !data.success) {
        const msg = data?.error || 'The letter could not be made.'
        // something changed under the box (409): show the fresh facts, keep the message on top of them
        if (res.status === 409) {
          // forget the EIN copy chosen on the OLD facts: the fresh box preselects again (or preselects nothing, when it warns that it cannot tell)
          setNoticeId(null)
          await load()
        }
        throw new Error(msg)
      }
      setMade(data.result as MadeInfo)
      await load()
      router.refresh() // the new file appears in the documents list
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The letter could not be made.')
    } finally {
      setBusy(false)
    }
  }

  const addressRows = address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const addressTooLong =
    addressRows.length > MAX_ADDRESS_LINES
      ? `The letter has room for ${MAX_ADDRESS_LINES} address lines — this has ${addressRows.length}. Join some lines (for example the street and the suite).`
      : addressRows.some((l) => l.length > MAX_ADDRESS_LINE_CHARS)
        ? `An address line is longer than ${MAX_ADDRESS_LINE_CHARS} characters — split it over two lines.`
        : null
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
            <dd className="font-medium text-zinc-900">
              {facts.hasCompany || !edit ? (
                <>{facts.companyName || '—'}{facts.state ? ` (${facts.state})` : ''}</>
              ) : (
                <input aria-label="Company name on the letter" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm font-normal" />
              )}
            </dd>
            <dt className="text-zinc-500">EIN</dt>
            <dd className="font-medium text-zinc-900">
              {facts.hasCompany || !edit ? (
                facts.ein || '—'
              ) : (
                <input aria-label="EIN on the letter" value={edit.ein} onChange={(e) => setEdit({ ...edit, ein: e.target.value })} inputMode="numeric" placeholder="XX-XXXXXXX" className="w-40 rounded-md border border-zinc-300 px-2 py-1 text-sm font-normal" />
              )}
            </dd>
            <dt className="text-zinc-500">Signed by</dt>
            <dd className="font-medium text-zinc-900">{facts.signerName || '—'} <span className="font-normal text-zinc-500">{facts.hasSignature ? `(signature drawn by the client${facts.signedAt ? ` on ${signedDay(facts.signedAt)}` : ''})` : '(a line to sign by hand)'}</span></dd>
          </dl>

          {!facts.hasCompany && edit && (
            <p className="text-xs text-zinc-500">
              This company is not one of ours, so the name and EIN come from what the client wrote — fix a typo here before the letter goes to the IRS.
              {edit.name.trim() !== facts.wizardCompanyName.trim() || edit.ein.trim() !== facts.wizardEin.trim()
                ? facts.hasSignature
                  ? ' You changed what the client wrote: they signed for their own version, so their signature will NOT be used and the letter will have a line to sign by hand.'
                  : ' You changed what the client wrote.'
                : ''}
            </p>
          )}

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
            {addressTooLong && <p className="mt-0.5 text-xs text-red-700">{addressTooLong}</p>}
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
            <button type="button" disabled={busy || !address.trim() || !!addressTooLong} onClick={() => void make()} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:bg-zinc-300">
              {busy ? 'Making the letter…' : shown ? 'Make the letter again' : 'Make the letter'}
            </button>
            {shown && (
              <a href={link(shown.documentId)} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-700 underline">Open {shown.name}</a>
            )}
          </div>

          {made && (
            <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Saved on this job — {made.pages} page{made.pages === 1 ? '' : 's'}{made.attachedNotice ? `, with “${made.attachedNotice}” attached` : ', letter only'}{made.signed ? ', signed with the client’s signature' : ', with a line to sign by hand'}. Print it and mail it; then save the tracking number below.</span>
            </p>
          )}
          {made?.warnings && made.warnings.length > 0 && made.warnings.filter((w) => !facts.warnings.includes(w)).map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</p>
          ))}
        </div>
      )}
    </div>
  )
}
