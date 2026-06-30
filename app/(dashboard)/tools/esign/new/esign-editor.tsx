"use client"

/**
 * E-Sign editor (staff). Upload a PDF → pick a field type → click on the page to
 * place it for the active signer → create the envelope → send invites automatically.
 *
 * Fields are draggable (move after placement) and resizable (4 corner handles).
 * Coordinates are stored normalized (lib/esign/coordinates), so placement is
 * resolution-independent and the server flatten lands pixel-accurate.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { PdfViewer, type PdfPageInfo } from "@/components/esign/pdf-viewer"
import { normalizedToDomBox, clampNormalizedRect, type NormalizedRect } from "@/lib/esign/coordinates"

type FieldType = "signature" | "initials" | "date" | "text" | "checkbox"

const SIGNER_COLORS = ["#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed", "#0891b2"]

const FIELD_DEFAULTS: Record<FieldType, { w: number; h: number; label: string }> = {
  signature: { w: 0.26, h: 0.06, label: "Signature" },
  initials: { w: 0.1, h: 0.05, label: "Initials" },
  date: { w: 0.16, h: 0.028, label: "Date" },
  text: { w: 0.26, h: 0.03, label: "Text" },
  checkbox: { w: 0.03, h: 0.023, label: "Check" },
}

interface PlacedField extends NormalizedRect {
  id: string
  field_type: FieldType
  page_index: number
  signer_index: number
}

interface Signer {
  kind: "crm" | "third_party"
  name: string
  email: string
  contact_id: string | null
  company: string | null
}

type ClientResult = {
  contact_id: string
  full_name: string
  email: string | null
  account_id: string | null
  company_name: string | null
}

const emptySigner = (): Signer => ({ kind: "crm", name: "", email: "", contact_id: null, company: null })

let fieldSeq = 0

/**
 * One signer row: toggle between a CRM client (typeahead by name/company →
 * linked contact) and a third party (manual name + required email). The CRM
 * search lives here so each row owns its own query/results state.
 */
function SignerRow({
  signer, index, color, active, canRemove, onPatch, onRemove, onActivate, onCrmPick,
}: {
  signer: Signer
  index: number
  color: string
  active: boolean
  canRemove: boolean
  onPatch: (patch: Partial<Signer>) => void
  onRemove: () => void
  onActivate: () => void
  onCrmPick: (c: ClientResult) => void
}) {
  const [q, setQ] = useState("")
  const [results, setResults] = useState<ClientResult[]>([])
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback((val: string) => {
    setQ(val)
    if (timer.current) clearTimeout(timer.current)
    if (val.trim().length < 2) { setResults([]); setSearching(false); return }
    setSearching(true)
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/esign/clients-search?q=${encodeURIComponent(val.trim())}`)
        const data = await res.json().catch(() => ({}))
        setResults(Array.isArray(data.clients) ? data.clients : [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
  }, [])

  return (
    <div className={`rounded-md border p-2 ${active ? "ring-2 ring-offset-1" : ""}`} style={{ borderColor: color }}>
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-xs font-medium text-zinc-500">Signer {index + 1}</span>
        <div className="ml-auto inline-flex rounded-md border p-0.5">
          {(["crm", "third_party"] as const).map(k => (
            <button
              key={k}
              onClick={() => onPatch(k === "crm"
                ? { kind: "crm", contact_id: null, name: "", email: "", company: null }
                : { kind: "third_party", contact_id: null, company: null })}
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${signer.kind === k ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
            >
              {k === "crm" ? "CRM client" : "Third party"}
            </button>
          ))}
        </div>
        {canRemove && <button onClick={onRemove} className="text-xs text-zinc-400 hover:text-red-500">✕</button>}
      </div>

      {signer.kind === "crm" ? (
        signer.contact_id ? (
          <div className="mt-1 flex items-center justify-between rounded-md border bg-blue-50 px-2 py-1.5 text-sm">
            <span className="truncate text-blue-800">
              {signer.name}{signer.company ? ` · ${signer.company}` : ""}{signer.email ? ` · ${signer.email}` : ""}
            </span>
            <button
              onClick={() => { onPatch({ contact_id: null, name: "", email: "", company: null }); setQ(""); setResults([]) }}
              className="ml-2 shrink-0 text-xs text-zinc-400 hover:text-red-500"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="relative mt-1">
            <input
              value={q}
              onChange={e => search(e.target.value)}
              placeholder="Search client by name or company"
              className="h-8 w-full rounded border px-2 text-sm"
            />
            {(results.length > 0 || searching) && (
              <div className="absolute z-10 mt-1 max-h-52 w-full overflow-auto rounded-md border bg-white shadow-lg">
                {searching && results.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-400">Searching…</div>}
                {results.map(c => (
                  <button
                    key={c.contact_id}
                    onClick={() => { onCrmPick(c); setQ(""); setResults([]) }}
                    className="block w-full px-2 py-1.5 text-left text-sm hover:bg-blue-50"
                  >
                    <span className="font-medium">{c.full_name || "(no name)"}</span>
                    {c.company_name ? <span className="text-zinc-500"> · {c.company_name}</span> : null}
                    {c.email
                      ? <span className="block text-[11px] text-zinc-400">{c.email}</span>
                      : <span className="block text-[11px] text-amber-600">no email on file</span>}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-[11px] text-zinc-400">Signs in their portal (emailed the link if they have no portal login).</p>
          </div>
        )
      ) : (
        <div className="mt-1 space-y-1">
          <input
            value={signer.name}
            onChange={e => onPatch({ name: e.target.value })}
            placeholder={`Third party ${index + 1} name`}
            className="h-8 w-full rounded border px-2 text-sm"
          />
          <input
            value={signer.email}
            onChange={e => onPatch({ email: e.target.value })}
            placeholder="email (required)"
            className="h-8 w-full rounded border px-2 text-sm"
          />
          <p className="text-[11px] text-zinc-400">Receives the document by email.</p>
        </div>
      )}

      <button
        onClick={onActivate}
        className={`mt-1 text-xs ${active ? "font-semibold text-blue-600" : "text-zinc-500 hover:text-blue-600"}`}
      >
        {active ? "● placing fields for this signer" : "place fields for this signer"}
      </button>
    </div>
  )
}

const RESIZE_HANDLES: Array<{ dir: string; cursor: string; style: React.CSSProperties }> = [
  { dir: "nw", cursor: "nwse-resize", style: { left: -5, top: -5 } },
  { dir: "ne", cursor: "nesw-resize", style: { right: -5, top: -5 } },
  { dir: "se", cursor: "nwse-resize", style: { right: -5, bottom: -5 } },
  { dir: "sw", cursor: "nesw-resize", style: { left: -5, bottom: -5 } },
]

/**
 * A placed field box: draggable (body) + resizable (4 corner handles).
 * Uses pointer capture so drags work even when the cursor leaves the element.
 */
function PlacedFieldBox({
  field,
  color,
  pageWidthCss,
  pageHeightCss,
  onUpdate,
  onRemove,
}: {
  field: PlacedField
  color: string
  pageWidthCss: number
  pageHeightCss: number
  onUpdate: (id: string, rect: NormalizedRect) => void
  onRemove: (id: string) => void
}) {
  const dragRef = useRef<{ startX: number; startY: number; origRect: NormalizedRect } | null>(null)
  const resizeRef = useRef<{ dir: string; startX: number; startY: number; origRect: NormalizedRect } | null>(null)

  const box = normalizedToDomBox(field, pageWidthCss, pageHeightCss)

  const onBodyDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.dataset.rh) return           // resize handle
    if (target.closest("button")) { e.stopPropagation(); return }    // delete button — don't capture, let click through
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origRect: { pos_x: field.pos_x, pos_y: field.pos_y, width: field.width, height: field.height },
    }
  }
  const onBodyMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dx = (e.clientX - dragRef.current.startX) / pageWidthCss
    const dy = (e.clientY - dragRef.current.startY) / pageHeightCss
    onUpdate(field.id, clampNormalizedRect({
      pos_x: dragRef.current.origRect.pos_x + dx,
      pos_y: dragRef.current.origRect.pos_y + dy,
      width: dragRef.current.origRect.width,
      height: dragRef.current.origRect.height,
    }))
  }
  const onBodyUp = () => { dragRef.current = null }

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>, dir: string) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeRef.current = {
      dir, startX: e.clientX, startY: e.clientY,
      origRect: { pos_x: field.pos_x, pos_y: field.pos_y, width: field.width, height: field.height },
    }
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    const { dir, startX, startY, origRect } = resizeRef.current
    const dx = (e.clientX - startX) / pageWidthCss
    const dy = (e.clientY - startY) / pageHeightCss
    const MIN_W = 0.02
    const MIN_H = 0.01
    let { pos_x, pos_y, width, height } = origRect

    if (dir === "se") {
      width = Math.max(MIN_W, origRect.width + dx)
      height = Math.max(MIN_H, origRect.height + dy)
    } else if (dir === "nw") {
      const nw = Math.max(MIN_W, origRect.width - dx)
      const nh = Math.max(MIN_H, origRect.height - dy)
      pos_x = origRect.pos_x + origRect.width - nw
      pos_y = origRect.pos_y + origRect.height - nh
      width = nw; height = nh
    } else if (dir === "ne") {
      width = Math.max(MIN_W, origRect.width + dx)
      const nh = Math.max(MIN_H, origRect.height - dy)
      pos_y = origRect.pos_y + origRect.height - nh
      height = nh
    } else if (dir === "sw") {
      const nw = Math.max(MIN_W, origRect.width - dx)
      pos_x = origRect.pos_x + origRect.width - nw
      width = nw
      height = Math.max(MIN_H, origRect.height + dy)
    }

    onUpdate(field.id, clampNormalizedRect({ pos_x, pos_y, width, height }))
  }
  const onHandleUp = () => { resizeRef.current = null }

  return (
    <div
      className="absolute flex items-center justify-center rounded-sm border-2 text-[10px] font-medium select-none"
      style={{
        left: box.left, top: box.top, width: box.width, height: box.height,
        borderColor: color, background: `${color}1a`, color, cursor: "move", touchAction: "none",
      }}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={onBodyUp}
    >
      <span className="pointer-events-none truncate px-1">{FIELD_DEFAULTS[field.field_type].label}</span>
      {RESIZE_HANDLES.map(h => (
        <div
          key={h.dir}
          data-rh="1"
          className="absolute h-3 w-3 rounded-sm border border-current bg-white"
          style={{ ...h.style, cursor: h.cursor, touchAction: "none" }}
          onPointerDown={e => onHandleDown(e, h.dir)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
        />
      ))}
      {/* Rendered after resize handles so it sits on top of the NE handle, which overlaps at the same corner */}
      <button
        onClick={e => { e.stopPropagation(); onRemove(field.id) }}
        onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}
        onPointerUp={e => e.stopPropagation()}
        style={{ zIndex: 20 }}
        className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] text-red-500 shadow"
      >
        ✕
      </button>
    </div>
  )
}

export function EsignEditor({ initialAccount = null, initialSigner = null }: {
  initialAccount?: { id: string; company_name: string } | null
  initialSigner?: { contact_id: string; full_name: string; email: string | null; company: string | null } | null
} = {}) {
  const [file, setFile] = useState<File | null>(null)
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
  const [documentName, setDocumentName] = useState("")
  const [signers, setSigners] = useState<Signer[]>(
    initialSigner
      ? [{ kind: "crm", name: initialSigner.full_name, email: initialSigner.email || "", contact_id: initialSigner.contact_id, company: initialSigner.company }]
      : [emptySigner()],
  )
  const [activeSigner, setActiveSigner] = useState(0)
  const [tool, setTool] = useState<FieldType>("signature")
  const [fields, setFields] = useState<PlacedField[]>([])
  const [routingOrder, setRoutingOrder] = useState<"sequential" | "parallel">("sequential")
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([])
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [templateMsg, setTemplateMsg] = useState("")
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Optional CRM account link — so the signed doc files into the client's records.
  const [account, setAccount] = useState<{ id: string; company_name: string } | null>(initialAccount)
  const [acctQuery, setAcctQuery] = useState("")
  const [acctResults, setAcctResults] = useState<Array<{ id: string; company_name: string }>>([])
  const acctTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onAcctQuery = useCallback((q: string) => {
    setAcctQuery(q)
    if (acctTimer.current) clearTimeout(acctTimer.current)
    if (q.trim().length < 2) {
      setAcctResults([])
      return
    }
    acctTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/accounts?q=${encodeURIComponent(q.trim())}&limit=8`)
        const data = await res.json().catch(() => ({}))
        setAcctResults(Array.isArray(data.accounts) ? data.accounts : Array.isArray(data) ? data : [])
      } catch {
        setAcctResults([])
      }
    }, 250)
  }, [])

  // Templates: load the list on mount.
  const refreshTemplates = useCallback(() => {
    fetch("/api/esign/templates").then(r => r.json()).then(d => setTemplates(d.templates ?? [])).catch(() => {})
  }, [])
  useEffect(() => { refreshTemplates() }, [refreshTemplates])

  // Start from a template: load its PDF + field layout + one empty signer per role.
  const loadTemplate = useCallback(async (id: string) => {
    if (!id) return
    setError("")
    setTemplateMsg("")
    try {
      const res = await fetch(`/api/esign/templates/${id}`)
      const t = await res.json()
      if (!res.ok || !t.pdfUrl) throw new Error(t.error || "Could not load the template.")
      const pdfRes = await fetch(t.pdfUrl)
      const buf = await pdfRes.arrayBuffer()
      const safe = (t.name || "template").replace(/[^a-zA-Z0-9._-]/g, "_")
      setFile(new File([buf], `${safe}.pdf`, { type: "application/pdf" }))
      setPdfBytes(new Uint8Array(buf.slice(0)))
      setDocumentName(t.name || "")
      setResult(null)
      setAccount(null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFields((t.fields ?? []).map((tf: any) => ({
        id: `f${++fieldSeq}`,
        field_type: tf.field_type,
        page_index: tf.page_index,
        signer_index: tf.signer_role_index ?? 0,
        pos_x: tf.pos_x, pos_y: tf.pos_y, width: tf.width, height: tf.height,
      })))
      const roles = Math.max(1, t.roleCount ?? 1)
      setSigners(Array.from({ length: roles }, () => (emptySigner())))
      setActiveSigner(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the template.")
    }
  }, [])

  // Save the current PDF + field layout as a reusable template.
  const saveAsTemplate = useCallback(async () => {
    setTemplateMsg("")
    if (!file) { setTemplateMsg("Upload a PDF first."); return }
    if (!fields.length) { setTemplateMsg("Place at least one field first."); return }
    if (!templateName.trim()) { setTemplateMsg("Name the template."); return }
    setSavingTemplate(true)
    try {
      const payload = {
        name: templateName.trim(),
        roleCount: signers.length,
        fields: fields.map(f => ({
          field_type: f.field_type, page_index: f.page_index,
          pos_x: f.pos_x, pos_y: f.pos_y, width: f.width, height: f.height,
          signer_role_index: f.signer_index,
        })),
      }
      const fd = new FormData()
      fd.append("pdf", file)
      fd.append("payload", JSON.stringify(payload))
      const res = await fetch("/api/esign/templates", { method: "POST", body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not save the template.")
      setTemplateMsg("Template saved.")
      setShowSaveTemplate(false)
      setTemplateName("")
      refreshTemplates()
    } catch (err) {
      setTemplateMsg(err instanceof Error ? err.message : "Could not save the template.")
    } finally {
      setSavingTemplate(false)
    }
  }, [file, fields, signers, templateName, refreshTemplates])

  const onPickFile = useCallback(async (f: File) => {
    setError("")
    setResult(null)
    setFields([])
    setFile(f)
    if (!documentName) setDocumentName(f.name.replace(/\.pdf$/i, ""))
    const buf = await f.arrayBuffer()
    setPdfBytes(new Uint8Array(buf.slice(0))) // fresh copy; pdfjs detaches its input
  }, [documentName])

  const placeField = useCallback(
    (page: PdfPageInfo, clientX: number, clientY: number, layer: HTMLElement) => {
      const rect = layer.getBoundingClientRect()
      const def = FIELD_DEFAULTS[tool]
      const fracX = (clientX - rect.left) / rect.width
      const fracY = (clientY - rect.top) / rect.height
      const norm = clampNormalizedRect({
        pos_x: fracX - def.w / 2,
        pos_y: fracY - def.h / 2,
        width: def.w,
        height: def.h,
      })
      setFields(prev => [
        ...prev,
        { id: `f${++fieldSeq}`, field_type: tool, page_index: page.index, signer_index: activeSigner, ...norm },
      ])
    },
    [tool, activeSigner],
  )

  const removeField = useCallback((id: string) => {
    setFields(prev => prev.filter(f => f.id !== id))
  }, [])

  const updateField = useCallback((id: string, rect: NormalizedRect) => {
    setFields(prev => prev.map(f => f.id === id ? { ...f, ...rect } : f))
  }, [])

  const updateSigner = useCallback((i: number, patch: Partial<Signer>) => {
    setSigners(prev => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }, [])

  // Pick a CRM client as a signer: link contact_id + name/email, and auto-file the
  // signed doc into their account if no filing account is set yet.
  const onCrmPick = useCallback((i: number, c: ClientResult) => {
    updateSigner(i, { kind: "crm", contact_id: c.contact_id, name: c.full_name, email: c.email || "", company: c.company_name })
    setAccount(prev => (prev || !c.account_id ? prev : { id: c.account_id, company_name: c.company_name || "Account" }))
  }, [updateSigner])

  const addSigner = useCallback(() => {
    setSigners(prev => (prev.length >= SIGNER_COLORS.length ? prev : [...prev, emptySigner()]))
  }, [])

  const removeSigner = useCallback((i: number) => {
    setSigners(prev => prev.filter((_, idx) => idx !== i))
    setFields(prev => prev.filter(f => f.signer_index !== i).map(f => (f.signer_index > i ? { ...f, signer_index: f.signer_index - 1 } : f)))
    setActiveSigner(0)
  }, [])

  const create = useCallback(async () => {
    setError("")
    if (!file) return setError("Upload a PDF first.")
    if (!documentName.trim()) return setError("Give the document a name.")
    const validSigners = signers.filter(s => s.name.trim())
    if (!validSigners.length) return setError("Add at least one signer with a name.")
    if (!fields.length) return setError("Place at least one field on the document.")
    for (let i = 0; i < signers.length; i++) {
      if (signers[i].name.trim() && !fields.some(f => f.signer_index === i)) {
        return setError(`Signer "${signers[i].name}" has no fields — place at least one or remove them.`)
      }
    }
    for (const s of signers) {
      if (s.name.trim() && s.kind === "third_party" && !s.email.trim()) {
        return setError(`Third-party signer "${s.name}" needs an email address — that's how they receive the document.`)
      }
    }

    setCreating(true)
    try {
      const payload = {
        document_name: documentName.trim(),
        owner_account_id: account?.id ?? null,
        routing_order: signers.length > 1 ? routingOrder : "sequential",
        signers: signers.map(s => ({ name: s.name.trim(), email: s.email.trim() || null, contact_id: s.contact_id })),
        fields: fields.map(f => ({
          field_type: f.field_type,
          page_index: f.page_index,
          pos_x: f.pos_x,
          pos_y: f.pos_y,
          width: f.width,
          height: f.height,
          signer_index: f.signer_index,
        })),
      }
      const form = new FormData()
      form.append("pdf", file)
      form.append("payload", JSON.stringify(payload))
      const res = await fetch("/api/esign/envelopes", { method: "POST", body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not create the envelope.")

      // Auto-send: dispatch invites immediately after creation (best-effort).
      // If this fails the envelope is still created as a draft — user can send
      // manually from the envelope list.
      let sentResult: { ok: boolean; emailed: number; portal: number; undeliverable: number } | null = null
      try {
        const sendRes = await fetch(`/api/esign/envelopes/${data.id}/send`, { method: "POST" })
        if (sendRes.ok) sentResult = await sendRes.json().catch(() => null)
      } catch {
        // non-fatal
      }

      setResult({ ...data, sentResult })
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not create the envelope.")
    } finally {
      setCreating(false)
    }
  }, [file, documentName, signers, fields, account, routingOrder])

  if (result) {
    const sent = result.sentResult
    return (
      <div className="max-w-2xl space-y-4">
        <div className={`rounded-lg border p-5 ${sent ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
          <h2 className={`text-lg font-semibold ${sent ? "text-green-800" : "text-amber-800"}`}>
            {sent ? "Envelope created & sent" : "Envelope created"}
          </h2>
          {sent ? (
            <p className="mt-1 text-sm text-green-700">
              Invites dispatched
              {sent.portal > 0 ? ` — ${sent.portal} client${sent.portal !== 1 ? "s" : ""} notified via portal` : ""}
              {sent.emailed > 0 ? `${sent.portal > 0 ? "," : " —"} ${sent.emailed} sent by email` : ""}
              {sent.undeliverable > 0 ? `. ${sent.undeliverable} couldn't be reached — check their email address.` : "."}
              {" "}You can also copy a direct signing link below.
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-700">The envelope was saved but invites could not be sent automatically. Open it from the list to send manually.</p>
          )}
        </div>
        <div className="space-y-3">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {(result.signers ?? []).map((s: any) => (
            <div key={s.id} className="rounded-lg border bg-white p-4">
              <div className="text-sm font-medium text-zinc-800">{s.name}{s.email ? ` · ${s.email}` : ""}</div>
              <div className="mt-2 flex gap-2">
                <input readOnly value={s.signUrl} className="flex-1 rounded-md border bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600" />
                <button
                  onClick={() => navigator.clipboard?.writeText(s.signUrl)}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-zinc-50"
                >
                  Copy
                </button>
                <a href={s.previewUrl} target="_blank" rel="noreferrer" className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-zinc-50">
                  Preview
                </a>
              </div>
            </div>
          ))}
        </div>
        <button onClick={() => { setResult(null); setFile(null); setPdfBytes(null); setFields([]); setDocumentName(""); setSigners([emptySigner()]) }} className="text-sm text-blue-600 hover:underline">
          Create another
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:h-[calc(100vh-8rem)] lg:overflow-hidden">
      {/* Controls */}
      <div className="lg:w-[280px] lg:shrink-0 lg:overflow-y-auto lg:pr-1 space-y-5">
        {templates.length > 0 && (
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Start from template</label>
            <select
              defaultValue=""
              onChange={e => { loadTemplate(e.target.value); e.target.value = "" }}
              className="mt-1 h-9 w-full rounded-md border bg-white px-2 text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="" disabled>Choose a template…</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Document</label>
          <input
            type="file"
            accept="application/pdf"
            ref={fileInputRef}
            onChange={e => { const f = e.target.files?.[0]; if (f) onPickFile(f) }}
            className="mt-1 block w-full text-sm"
          />
          <input
            value={documentName}
            onChange={e => setDocumentName(e.target.value)}
            placeholder="Document name"
            className="mt-2 h-9 w-full rounded-md border px-3 text-sm focus:ring-2 focus:ring-blue-500"
          />

          {/* Optional: link to a CRM account so the signed doc files into their records. */}
          <div className="relative mt-2">
            {account ? (
              <div className="flex items-center justify-between rounded-md border bg-blue-50 px-3 py-1.5 text-sm">
                <span className="truncate text-blue-800">{account.company_name}</span>
                <button onClick={() => { setAccount(null); setAcctQuery(""); setAcctResults([]) }} className="text-xs text-zinc-400 hover:text-red-500">✕</button>
              </div>
            ) : (
              <>
                <input
                  value={acctQuery}
                  onChange={e => onAcctQuery(e.target.value)}
                  placeholder="Link to client account (optional)"
                  className="h-9 w-full rounded-md border px-3 text-sm focus:ring-2 focus:ring-blue-500"
                />
                {acctResults.length > 0 && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-white shadow-lg">
                    {acctResults.map(a => (
                      <button
                        key={a.id}
                        onClick={() => { setAccount({ id: a.id, company_name: a.company_name }); setAcctResults([]); setAcctQuery("") }}
                        className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                      >
                        {a.company_name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Signers</label>
          <div className="mt-1 space-y-2">
            {signers.map((s, i) => (
              <SignerRow
                key={i}
                signer={s}
                index={i}
                color={SIGNER_COLORS[i]}
                active={activeSigner === i}
                canRemove={signers.length > 1}
                onPatch={patch => updateSigner(i, patch)}
                onRemove={() => removeSigner(i)}
                onActivate={() => setActiveSigner(i)}
                onCrmPick={c => onCrmPick(i, c)}
              />
            ))}
            <button onClick={addSigner} className="text-xs text-blue-600 hover:underline">+ add signer</button>
          </div>
          {signers.length > 1 && (
            <div className="mt-2">
              <label className="text-[11px] text-zinc-500">Signing order</label>
              <div className="mt-1 inline-flex rounded-md border p-0.5">
                {(["sequential", "parallel"] as const).map(o => (
                  <button
                    key={o}
                    onClick={() => setRoutingOrder(o)}
                    className={`rounded px-2.5 py-1 text-xs font-medium ${routingOrder === o ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
                  >
                    {o === "sequential" ? "One at a time" : "All at once"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Field to place</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(Object.keys(FIELD_DEFAULTS) as FieldType[]).map(t => (
              <button
                key={t}
                onClick={() => setTool(t)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${tool === t ? "border-blue-500 bg-blue-50 text-blue-700" : "hover:bg-zinc-50"}`}
              >
                {FIELD_DEFAULTS[t].label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Click to place. Drag to move. Drag a corner handle to resize.</p>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

        <button
          onClick={create}
          disabled={creating || !file}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {creating ? "Creating & sending…" : "Create & send"}
        </button>

        {/* Save as template */}
        {file && fields.length > 0 && (
          <div className="border-t pt-3">
            {showSaveTemplate ? (
              <div className="space-y-2">
                <input
                  value={templateName}
                  onChange={e => setTemplateName(e.target.value)}
                  placeholder="Template name"
                  className="h-9 w-full rounded-md border px-3 text-sm focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2">
                  <button onClick={saveAsTemplate} disabled={savingTemplate} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50">
                    {savingTemplate ? "Saving…" : "Save template"}
                  </button>
                  <button onClick={() => { setShowSaveTemplate(false); setTemplateMsg("") }} className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => { setShowSaveTemplate(true); setTemplateName(documentName) }} className="text-xs text-blue-600 hover:underline">
                Save this layout as a template
              </button>
            )}
            {templateMsg && <p className="mt-1 text-xs text-zinc-500">{templateMsg}</p>}
          </div>
        )}
      </div>

      {/* Document */}
      <div className="flex-1 min-h-[400px] lg:overflow-y-auto rounded-lg border bg-zinc-100 p-4">
        {pdfBytes ? (
          <PdfViewer
            src={pdfBytes}
            renderOverlay={page => (
              <div
                className="absolute inset-0 cursor-crosshair"
                onPointerDown={e => {
                  if (e.target !== e.currentTarget) return // a field handles its own clicks
                  const target = e.target as HTMLElement
                  if (target.closest("button")) return // delete button click
                  placeField(page, e.clientX, e.clientY, e.currentTarget as HTMLElement)
                }}
              >
                {fields
                  .filter(f => f.page_index === page.index)
                  .map(f => (
                    <PlacedFieldBox
                      key={f.id}
                      field={f}
                      color={SIGNER_COLORS[f.signer_index] ?? "#2563eb"}
                      pageWidthCss={page.widthCss}
                      pageHeightCss={page.heightCss}
                      onUpdate={updateField}
                      onRemove={removeField}
                    />
                  ))}
              </div>
            )}
          />
        ) : (
          <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-zinc-400">Upload a PDF to begin.</div>
        )}
      </div>
    </div>
  )
}
