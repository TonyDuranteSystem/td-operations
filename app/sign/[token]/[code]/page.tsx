"use client"

/**
 * Public signing page — /sign/[token]/[code]. No login.
 *
 * Fetches the envelope + ONLY this signer's fields from the server (access code
 * validated server-side), renders the PDF with pdfjs, overlays the signer's
 * interactive fields, captures a drawn signature/initials, and submits. Supports
 * ?preview=td (admin skip) and ?portal=true (embedded; postMessage on done).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { PdfViewer, type PdfPageInfo } from "@/components/esign/pdf-viewer"
import { SignaturePadModal } from "@/components/esign/signature-pad-modal"
import { expandDomBoxToMinimum, isRectOutOfView, normalizedToDomBox } from "@/lib/esign/coordinates"

/**
 * Minimum on-screen size for a click-to-open field (signature / initials).
 * A tax return's signature line is ~1.6% of the page height — a ~10px strip the
 * client cannot see or hit. Display-only: the stored rect (and therefore where
 * the signature is stamped into the PDF) is unchanged. Width is bumped only for
 * genuinely tiny boxes, so an enlarged signature never runs into the date field
 * beside it on the same line.
 */
const MIN_FIELD_HIT_WIDTH_PX = 80
const MIN_FIELD_HIT_HEIGHT_PX = 36

type FieldType = "signature" | "initials" | "date" | "text" | "checkbox"

interface SignField {
  id: string
  field_type: FieldType
  page_index: number
  pos_x: number
  pos_y: number
  width: number
  height: number
  required: boolean
  placeholder: string | null
  value: string | null
  font_size: number | null
}

function todayUS(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}/${dd}/${d.getFullYear()}`
}

export default function SignPage() {
  const params = useParams()
  const search = useSearchParams()
  const token = params?.token as string
  const code = (params?.code as string) || ""
  const isPreview = search.get("preview") === "td"
  const isPortal = search.get("portal") === "true"

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [docName, setDocName] = useState("")
  const [pdfUrl, setPdfUrl] = useState("")
  const [fields, setFields] = useState<SignField[]>([])
  const [alreadySigned, setAlreadySigned] = useState(false)

  const [values, setValues] = useState<Record<string, string>>({})
  const [signaturePng, setSignaturePng] = useState<string | null>(null)
  const [initialsPng, setInitialsPng] = useState<string | null>(null)
  const [padTarget, setPadTarget] = useState<"signature" | "initials" | null>(null)
  const [flashFieldId, setFlashFieldId] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  const [signedByName, setSignedByName] = useState("")
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState("")
  const [declining, setDeclining] = useState(false)
  const [declined, setDeclined] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/sign/${token}/fetch?code=${encodeURIComponent(code)}${isPreview ? "&preview=td" : ""}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || "Could not load the document.")
        if (cancelled) return
        setDocName(data.envelope?.document_name || "Document")
        setPdfUrl(data.pdfUrl)
        // Sort into DOCUMENT order. The API returns whatever order the rows come
        // back in (fields are bulk-inserted in the staff's click order, and the
        // fetch has no ORDER BY), so without this "the next one is on page N"
        // can name the wrong page and jump the signer past an earlier gap.
        const fs: SignField[] = [...((data.fields || []) as SignField[])].sort(
          (a, b) => a.page_index - b.page_index || a.pos_y - b.pos_y || a.pos_x - b.pos_x,
        )
        setFields(fs)
        setAlreadySigned(!!data.signer?.alreadySigned)
        // Auto-fill date fields.
        const initial: Record<string, string> = {}
        for (const f of fs) if (f.field_type === "date") initial[f.id] = todayUS()
        setValues(initial)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the document.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token, code, isPreview])

  const isFilled = useCallback(
    (f: SignField): boolean => {
      if (!f.required) return true
      if (f.field_type === "signature") return !!signaturePng
      if (f.field_type === "initials") return !!initialsPng
      if (f.field_type === "checkbox") return values[f.id] === "true"
      return !!(values[f.id] && values[f.id].trim())
    },
    [signaturePng, initialsPng, values],
  )

  const allFilled = useMemo(() => fields.every(isFilled), [fields, isFilled])
  const canSubmit = allFilled && signedByName.trim().length > 0 && consent && !submitting

  // What is still missing, in document order. Telling the signer WHERE to go is
  // the whole fix: the box is often pages above the disabled button, so "fill
  // every highlighted field" on its own leaves them stuck staring at grey.
  const pendingFields = useMemo(() => fields.filter(f => !isFilled(f)), [fields, isFilled])

  const goToNextField = useCallback(() => {
    const next = pendingFields[0]
    if (!next) return
    const el = document.getElementById(`esign-field-${next.id}`)
    // The overlay only exists once the PDF has painted. Say so instead of doing
    // nothing — a rescue button that silently ignores a tap reads as "the
    // document is broken", which is the complaint this whole panel answers.
    if (!el) {
      setError("The document is still loading — give it a moment and try again.")
      return
    }
    setError("")
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    // Smooth scrolling is a silent no-op in some engines (caught in QA: the same
    // call without `behavior` moved the page, with it nothing happened). Verify,
    // and re-issue instantly if we did not actually move — a jump button that
    // quietly does nothing reads as "the document is broken".
    window.setTimeout(() => {
      const viewportH = window.innerHeight || document.documentElement.clientHeight
      if (isRectOutOfView(el.getBoundingClientRect(), viewportH)) el.scrollIntoView({ block: "center" })
    }, 500)
    setFlashFieldId(next.id)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashFieldId(cur => (cur === next.id ? null : cur)), 2500)
  }, [pendingFields])

  // Don't leave a timer running into an unmount (the tree is replaced the moment
  // the signature is accepted).
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current) }, [])

  const submit = useCallback(async () => {
    setError("")
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const fieldVals = fields
        .filter(f => f.field_type === "date" || f.field_type === "text" || f.field_type === "checkbox")
        .map(f => ({ field_id: f.id, value: f.field_type === "checkbox" ? (values[f.id] === "true" ? "true" : "false") : values[f.id] ?? null }))
      const res = await fetch(`/api/sign/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          preview: isPreview ? "td" : undefined,
          signature_png: signaturePng,
          initials_png: initialsPng,
          signed_by_name: signedByName.trim(),
          consent,
          consent_text: CONSENT_TEXT,
          fields: fieldVals,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not submit. Please try again.")
      setDone(true)
      if (isPortal && window.parent !== window) window.parent.postMessage({ type: "document-signed", token }, "https://portal.tonydurante.us")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, fields, values, signaturePng, initialsPng, signedByName, consent, code, isPreview, isPortal, token])

  const decline = useCallback(async () => {
    setDeclining(true)
    setError("")
    try {
      const res = await fetch(`/api/sign/${token}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, preview: isPreview ? "td" : undefined, reason: declineReason.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not decline. Please try again.")
      setDeclined(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decline. Please try again.")
    } finally {
      setDeclining(false)
    }
  }, [token, code, isPreview, declineReason])

  if (loading) return <Centered>Loading…</Centered>
  if (error && !pdfUrl) return <Centered><span className="text-red-500">{error}</span></Centered>
  if (declined)
    return (
      <Centered>
        <div className="text-center">
          <h2 className="text-xl font-semibold text-zinc-700">Declined</h2>
          <p className="mt-1 text-sm text-zinc-500">You declined to sign this document. Our team has been notified.</p>
        </div>
      </Centered>
    )
  if (done || alreadySigned)
    return (
      <Centered>
        <div className="text-center">
          <div className="text-4xl">&#10003;</div>
          <h2 className="mt-2 text-xl font-semibold text-green-700">Document signed</h2>
          <p className="mt-1 text-sm text-zinc-500">Thank you — your signature has been recorded.</p>
        </div>
      </Centered>
    )

  return (
    <div className={`min-h-screen bg-zinc-100 ${isPortal ? "p-0" : "p-4 sm:p-8"}`}>
      {isPreview && (
        <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-700">
          ADMIN PREVIEW — submitting will mark this signed
        </div>
      )}
      {!isPortal && <h1 className="mb-4 text-center text-xl font-bold text-zinc-900">{docName}</h1>}

      <div className="mx-auto max-w-3xl">
        <PdfViewer
          src={pdfUrl}
          renderOverlay={(page: PdfPageInfo) => (
            <>
              {fields
                .filter(f => f.page_index === page.index)
                .map(f => {
                  const clickToOpen = f.field_type === "signature" || f.field_type === "initials"
                  const raw = normalizedToDomBox(f, page.widthCss, page.heightCss)
                  // Only the click-to-open fields are grown: a text/date box is typed
                  // into in place and must keep the form's own line width.
                  const box = clickToOpen
                    ? expandDomBoxToMinimum(raw, MIN_FIELD_HIT_WIDTH_PX, MIN_FIELD_HIT_HEIGHT_PX, page.widthCss, page.heightCss)
                    : raw
                  // A grown box must never win a click from a field it did not
                  // originally cover: fields are absolutely positioned with no
                  // stacking order of their own, so paint order alone would let an
                  // enlarged signature sit on top of a neighbouring input and make
                  // it untappable — the same hard block this change removes.
                  const style = { left: box.left, top: box.top, width: box.width, height: box.height, zIndex: clickToOpen ? 1 : 2 } as const
                  const filled = isFilled(f)
                  const ring = filled ? "border-green-500 bg-green-50/40" : "border-blue-500 bg-blue-50/50"
                  const flash = flashFieldId === f.id ? " ring-4 ring-amber-400 ring-offset-1" : ""
                  if (clickToOpen) {
                    const png = f.field_type === "signature" ? signaturePng : initialsPng
                    return (
                      <button
                        key={f.id}
                        id={`esign-field-${f.id}`}
                        className={`absolute flex items-center justify-center rounded-sm border-2 ${ring}${flash}`}
                        style={style}
                        onClick={() => setPadTarget(f.field_type as "signature" | "initials")}
                      >
                        {png ? (
                          // Preview at the STORED box size, not the grown one: the
                          // server fits the signature into the stored rect, so
                          // letting it fill the enlarged box would show the signer
                          // proportions the finished PDF will not have.
                          <span className="flex items-center justify-center" style={{ width: raw.width, height: raw.height }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={png} alt="" className="max-h-full max-w-full object-contain" />
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium text-blue-700">{f.field_type === "signature" ? "Sign" : "Initials"}</span>
                        )}
                      </button>
                    )
                  }
                  if (f.field_type === "checkbox") {
                    const on = values[f.id] === "true"
                    return (
                      <button
                        key={f.id}
                        id={`esign-field-${f.id}`}
                        className={`absolute flex items-center justify-center rounded-sm border-2 ${ring}${flash}`}
                        style={style}
                        onClick={() => setValues(v => ({ ...v, [f.id]: on ? "false" : "true" }))}
                      >
                        {on && <span className="text-xs font-bold text-green-700">✓</span>}
                      </button>
                    )
                  }
                  if (f.field_type === "date") {
                    return (
                      <div key={f.id} id={`esign-field-${f.id}`} className={`absolute flex items-center rounded-sm border-2 px-1 ${ring}${flash}`} style={style}>
                        <span className="truncate text-[10px] text-zinc-700">{values[f.id] || todayUS()}</span>
                      </div>
                    )
                  }
                  return (
                    <input
                      key={f.id}
                      id={`esign-field-${f.id}`}
                      value={values[f.id] || ""}
                      onChange={e => setValues(v => ({ ...v, [f.id]: e.target.value }))}
                      placeholder={f.placeholder || "Type here"}
                      className={`absolute rounded-sm border-2 bg-white px-1 text-[11px] outline-none ${ring}${flash}`}
                      style={style}
                    />
                  )
                })}
            </>
          )}
        />
      </div>

      {/* Sign bar */}
      <div className={`mx-auto mt-6 max-w-3xl rounded-xl border bg-white p-5 ${isPortal ? "mb-4" : ""}`}>
        <h2 className="text-sm font-semibold text-zinc-900">Complete & sign</h2>
        {!allFilled && (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-800">
              {pendingFields.length === 1 ? "1 field still to complete" : `${pendingFields.length} fields still to complete`}
              {pendingFields[0] ? ` — the next one is on page ${pendingFields[0].page_index + 1}.` : "."}
            </p>
            <button
              onClick={goToNextField}
              className="mt-2 w-full rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
            >
              {pendingFields[0]?.field_type === "signature"
                ? "Take me to the signature box"
                : "Take me to the next field"}
            </button>
          </div>
        )}
        {error && <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <input
            value={signedByName}
            onChange={e => setSignedByName(e.target.value)}
            placeholder="Type your full legal name"
            className="h-10 rounded-md border px-3 text-sm focus:ring-2 focus:ring-blue-500"
          />
          <label className="flex items-center gap-2 text-xs text-zinc-600">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            {CONSENT_TEXT}
          </label>
        </div>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="mt-4 w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Sign & Submit"}
        </button>

        {/* Decline */}
        <div className="mt-3 text-center">
          {showDecline ? (
            <div className="space-y-2 text-left">
              <textarea
                value={declineReason}
                onChange={e => setDeclineReason(e.target.value)}
                placeholder="Reason (optional)"
                rows={2}
                className="w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-red-400"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowDecline(false)} className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
                <button onClick={decline} disabled={declining} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  {declining ? "Declining…" : "Confirm decline"}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowDecline(true)} className="text-xs text-zinc-400 hover:text-red-600 hover:underline">
              Decline to sign
            </button>
          )}
        </div>
      </div>

      {padTarget && (
        <SignaturePadModal
          title={padTarget === "signature" ? "Draw your signature" : "Draw your initials"}
          onClose={() => setPadTarget(null)}
          onDone={dataUrl => {
            if (padTarget === "signature") setSignaturePng(dataUrl)
            else setInitialsPng(dataUrl)
            setPadTarget(null)
          }}
        />
      )}
    </div>
  )
}

const CONSENT_TEXT = "I agree to sign electronically (ESIGN/UETA) and that my electronic signature is legally binding."

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">{children}</div>
}
