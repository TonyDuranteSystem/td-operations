'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, Loader2, PenLine, AlertCircle } from 'lucide-react'
import { SignaturePadModal } from '@/components/esign/signature-pad-modal'
import {
  CLOSURE_SIGNATURE_CONSENT_EN,
  CLOSURE_SIGNATURE_CONSENT_IT,
  CLOSURE_SIGNATURE_LOCALE_HINT,
  CLOSURE_SIGNATURE_SEEN_HINT,
  signaturePathsOf,
  signatureFingerprint,
} from '@/lib/closure/signature-consent'
import { EIN_LETTER_BODY_CLOSE, EIN_LETTER_REQUEST, EIN_LETTER_TO } from '@/lib/closure/ein-letter-wording'

interface Props {
  name: string
  value: unknown
  onChange: (name: string, value: string | string[] | boolean | number) => void
  onFileUpload?: (name: string, file: File, onProgress?: (pct: number) => void) => Promise<string | null>
  /** the answers so far — the preview names the company, its EIN and the owner the client typed on the earlier steps */
  context?: Record<string, unknown>
  locale: 'en' | 'it'
  pick: (en: string | undefined, it: string | undefined) => string | undefined
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Company Closure wizard: "Draw your signature here for the EIN letter to send to the IRS for its closure" (part F step 2).
 * Shows the letter's own sentences with the client's answers in them (so they sign what will be printed), the consent text, and a pad. The drawing
 * is a PNG uploaded through the wizard's normal file pipeline under the field name `signature_image`; the answers hold the path. REQUIRED (the field's
 * `required` flag: the wizard gate and the server both refuse a closure sent without it). The server writes the consent record (lib/closure/signature-consent.ts).
 */
export function WizardSignatureField({ name, value, onChange, onFileUpload, context, locale, pick }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [changedNote, setChangedNote] = useState(false)
  const saved = signaturePathsOf(value).length > 0

  const company = text(context?.llc_name)
  const ein = text(context?.llc_ein)
  // the same owner the letter will print (lib/closure/signature-consent.ts signatureFingerprint): the owner fields, else the person who signed in
  const owner = `${text(context?.owner_first_name)} ${text(context?.owner_last_name)}`.trim() || `${text(context?.first_name)} ${text(context?.last_name)}`.trim()
  const fingerprint = signatureFingerprint(context ?? {})
  const seen = text(context?.[CLOSURE_SIGNATURE_SEEN_HINT])
  const consent = locale === 'it' ? CLOSURE_SIGNATURE_CONSENT_IT : CLOSURE_SIGNATURE_CONSENT_EN

  // A signature belongs to the letter the client saw when drawing it. If the company, the EIN or the owner is changed afterwards (the client went
  // back a step), the saved drawing is dropped and they draw again — the server refuses a signature for other details too.
  // A closure form re-opened after it was SENT has the drawing and the server's own fingerprint of what was sent (`signature_for`), but not the hint
  // (the server consumes it): that fingerprint says what the drawing was signed for, so it stands in as the hint.
  const signedFor = text(context?.signature_for)
  useEffect(() => {
    if (saved && !seen && signedFor) onChange(CLOSURE_SIGNATURE_SEEN_HINT, signedFor)
  }, [saved, seen, signedFor, onChange])

  // A re-opened form has the drawing but no language hint (the server consumes it at every send): without one an Italian re-send was recorded as English.
  // Only FILLED when missing — a hint set when the signature was drawn is the language the client saw while signing, and switching the page language afterwards
  // must not rewrite it.
  const shownLocale = text(context?.[CLOSURE_SIGNATURE_LOCALE_HINT])
  useEffect(() => {
    if (saved && !shownLocale) onChange(CLOSURE_SIGNATURE_LOCALE_HINT, locale)
  }, [saved, shownLocale, locale, onChange])

  useEffect(() => {
    if (saved && seen && seen !== fingerprint) {
      onChange(name, [])
      setPreview(null)
      setChangedNote(true)
    }
  }, [saved, seen, fingerprint, name, onChange])

  async function save(dataUrl: string) {
    setOpen(false)
    setError(null)
    if (!onFileUpload) {
      setError(pick('Signing is not available right now.', 'La firma non è disponibile in questo momento.') ?? '')
      return
    }
    setBusy(true)
    try {
      const blob = await (await fetch(dataUrl)).blob()
      const file = new File([blob], 'signature.png', { type: 'image/png' })
      const path = await onFileUpload(name, file)
      if (!path) throw new Error('upload failed')
      // the hints first, the path last: the box drops a saved drawing whose hint does not match the details, so the new hint must already be there
      onChange(CLOSURE_SIGNATURE_LOCALE_HINT, locale) // which language the client saw the consent in
      onChange(CLOSURE_SIGNATURE_SEEN_HINT, fingerprint) // which letter they signed (company, EIN, owner) — the server checks it against what is sent
      onChange(name, [path])
      setChangedNote(false)
      setPreview(dataUrl)
    } catch (err) {
      setError(err instanceof Error && err.message && err.message !== 'upload failed' ? err.message : (pick('Your signature could not be saved — please try again.', 'Non è stato possibile salvare la firma — riprova.') ?? ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-700">
        <p className="mb-1 font-medium text-zinc-800">{pick('The letter you are signing', 'La lettera che stai firmando')}</p>
        <p><span className="font-medium">To:</span> {EIN_LETTER_TO}</p>
        <p><span className="font-medium">Request:</span> {EIN_LETTER_REQUEST}</p>
        <p><span className="font-medium">Name/Business Name:</span> {company || '—'}</p>
        <p><span className="font-medium">EIN:</span> {ein || '—'}</p>
        <p className="mt-1">{EIN_LETTER_BODY_CLOSE}</p>
        <p className="mt-1"><span className="font-medium">Name:</span> {owner || '—'}</p>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">{consent}</p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
          {saved ? pick('Draw it again', 'Disegnala di nuovo') : pick('Draw my signature', 'Disegna la mia firma')}
        </button>
        {saved && !busy && (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle className="h-4 w-4" /> {pick('Signature saved', 'Firma salvata')}
          </span>
        )}
        {saved && (
          <button type="button" onClick={() => { onChange(name, []); setPreview(null); setChangedNote(false) }} className="text-xs text-zinc-500 underline">
            {pick('Remove', 'Rimuovi')}
          </button>
        )}
      </div>

      {preview && saved && (
        // eslint-disable-next-line @next/next/no-img-element -- a local data URL of the drawing just made
        <img src={preview} alt={pick('Your signature', 'La tua firma') ?? 'Your signature'} className="h-16 rounded border border-zinc-200 bg-white p-1" />
      )}
      {changedNote && !saved && (
        <p className="flex items-start gap-2 text-xs text-amber-800"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {pick('You changed the company details after signing — please draw your signature again.', 'Hai cambiato i dati della società dopo aver firmato — disegna di nuovo la firma.')}</p>
      )}
      {error && (
        <p className="flex items-start gap-2 text-xs text-red-700"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}</p>
      )}
      {open && <SignaturePadModal title={pick('Draw your signature', 'Disegna la tua firma')} onClose={() => setOpen(false)} onDone={(url) => void save(url)} />}
    </div>
  )
}
