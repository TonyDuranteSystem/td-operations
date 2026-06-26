'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, Loader2, CheckCircle2, FileUp, X } from 'lucide-react'

/** Window event fired after a flow document upload succeeds. The sibling
 *  DocumentViewer listens for it to re-fetch live (a server router.refresh()
 *  alone does NOT re-run the viewer's client-side effect). */
export const FLOW_DOC_UPLOADED_EVENT = 'flow-doc-uploaded'
export interface FlowDocUploadedDetail {
  serviceDeliveryId: string
}

interface DocumentUploadProps {
  /** Label from stage_layout, e.g. "Upload Extension Receipt". */
  label?: string
  serviceDeliveryId: string
  /** Stamped onto the documents row as flow_stage (the stage that expects it). */
  flowStage: string | null
  /** Whether uploading auto-advances the SD (default true). Set false when a
   *  separate action (e.g. Send for Signature) owns the stage advance. */
  autoAdvance?: boolean
}

/**
 * Upload a document bound to a flow + stage. Explicit two-step interaction:
 *   1. Pick a file ("Choose file") — the selected name is shown for confidence;
 *      nothing is sent yet.
 *   2. Click the prominent primary button (labelled with the stage's upload
 *      label, e.g. "Upload Filing Receipt") to actually send it. The button is
 *      disabled until a file is picked, so the action a user must take is always
 *      obvious — there is no silent auto-upload on selection.
 *
 * Under the hood the send is the same signed-URL pattern as CRM doc upload:
 *   a. PUT the file to Supabase Storage via a signed URL (bypasses Vercel 4.5MB).
 *   b. POST the resulting storage path to /api/flows/[id]/upload-document, which
 *      copies it to Drive, writes the documents row (stamped with
 *      service_delivery_id + flow_stage) and auto-advances the SD to the next
 *      stage. NOTE: the route takes a storage PATH, not the raw file — do not
 *      switch this to a multipart/FormData body or the 4.5MB limit returns.
 * Surfaces the server's real error on failure (R099) — never a generic toast.
 */
export function DocumentUpload({ label, serviceDeliveryId, flowStage, autoAdvance }: DocumentUploadProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const uploadLabel = label || 'Upload Document'

  // The formation flow's Articles-of-Organization upload (stage "Filed with
  // State") AUTO-ADVANCES into "Articles Received", which materializes the CRM
  // company and pins the SS-4's formation date (Line 11). So for THIS upload we
  // make staff confirm the real state filing date (OCR-prefilled from the
  // Articles) instead of letting the materializer default it to today.
  const FORMATION_ARTICLES_STAGE = 'Filed with State'
  const needsFormationDate = flowStage === FORMATION_ARTICLES_STAGE

  const [confirming, setConfirming] = useState(false)
  const [formationDate, setFormationDate] = useState('')
  const [prefilling, setPrefilling] = useState(false)
  const stagedPathRef = useRef<string | null>(null)

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setFile(picked)
    setError(null)
    setDone(null)
  }

  function clearPick() {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // Stage the file to Supabase Storage via a signed URL (bypasses the 4.5MB
  // Vercel body limit). Returns the storage path. Throws on failure.
  async function stageFile(picked: File): Promise<string> {
    const storagePath = `flow-uploads/${serviceDeliveryId}/${Date.now()}_${picked.name}`
    const sigRes = await fetch('/api/storage/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'onboarding-uploads',
        path: storagePath,
        contentType: picked.type || 'application/pdf',
      }),
    })
    if (!sigRes.ok) {
      const d = await sigRes.json().catch(() => ({}))
      throw new Error(d.error || 'Could not start the upload. Please try again.')
    }
    const { signedUrl } = await sigRes.json()
    if (!signedUrl) throw new Error('Could not start the upload. Please try again.')
    const putRes = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': picked.type || 'application/pdf' },
      body: picked,
    })
    if (!putRes.ok) throw new Error('The file could not be saved to storage. Please try again.')
    return storagePath
  }

  // Register the staged file against the flow (Drive + documents row +
  // auto-advance). Passes the staff-confirmed formation date when present.
  async function commitUpload(storagePath: string, fileName: string, fileType: string, confirmedDate?: string) {
    const apiRes = await fetch(`/api/flows/${serviceDeliveryId}/upload-document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_path: storagePath,
        file_name: fileName,
        mime_type: fileType || 'application/pdf',
        flow_stage: flowStage,
        auto_advance: autoAdvance === false ? false : undefined,
        ...(confirmedDate ? { formation_date: confirmedDate } : {}),
      }),
    })
    const data = await apiRes.json().catch(() => ({}))
    if (!apiRes.ok || !data.success) {
      throw new Error(data.detail || data.error || 'Upload failed — please try again.')
    }
    setDone(`${fileName} uploaded`)
    clearPick()
    stagedPathRef.current = null
    window.dispatchEvent(
      new CustomEvent<FlowDocUploadedDetail>(FLOW_DOC_UPLOADED_EVENT, { detail: { serviceDeliveryId } }),
    )
    router.refresh()
  }

  async function handleUpload() {
    if (!file || uploading) return
    setUploading(true)
    setError(null)
    setDone(null)
    try {
      const storagePath = await stageFile(file)

      // Company-Formation Articles: stage the file, then make staff confirm the
      // formation date (OCR-prefilled) before committing — the commit advances
      // and materializes the company with that date.
      if (needsFormationDate) {
        stagedPathRef.current = storagePath
        setFormationDate('')
        setConfirming(true)
        setPrefilling(true)
        try {
          const res = await fetch(
            `/api/flows/${serviceDeliveryId}/articles-formation-date?storage_path=${encodeURIComponent(storagePath)}`,
          )
          const data = await res.json().catch(() => ({}))
          if (data?.formation_date) setFormationDate(data.formation_date)
        } catch {
          // ignore — staff enter the date manually
        } finally {
          setPrefilling(false)
          setUploading(false)
        }
        return
      }

      await commitUpload(storagePath, file.name, file.type)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Upload failed — please try again.')
    } finally {
      if (!needsFormationDate) setUploading(false)
    }
  }

  async function confirmFormationDate() {
    if (!file || !stagedPathRef.current) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formationDate)) {
      setError('Please enter the formation date before continuing.')
      return
    }
    setUploading(true)
    setError(null)
    try {
      await commitUpload(stagedPathRef.current, file.name, file.type, formationDate)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Upload failed — please try again.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileUp className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">{uploadLabel}</h3>
      </div>

      <input
        ref={inputRef}
        type="file"
        onChange={handlePick}
        disabled={uploading}
        className="hidden"
        id={`flow-upload-${serviceDeliveryId}`}
      />

      {/* Step 1 — choose the file (no send yet). */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={`flow-upload-${serviceDeliveryId}`}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border transition-colors ${
            uploading
              ? 'border-zinc-200 text-zinc-400 cursor-not-allowed'
              : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50 cursor-pointer'
          }`}
        >
          <Upload className="h-4 w-4" />
          {file ? 'Change file' : 'Choose file'}
        </label>

        {file && (
          <span className="inline-flex items-center gap-1.5 max-w-full text-sm text-zinc-600">
            <span className="truncate">{file.name}</span>
            {!uploading && (
              <button
                type="button"
                onClick={clearPick}
                aria-label="Remove selected file"
                className="text-zinc-400 hover:text-zinc-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        )}
      </div>

      {/* Step 2 — prominent submit, disabled until a file is chosen. */}
      <button
        type="button"
        onClick={handleUpload}
        disabled={!file || uploading}
        className={`mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          !file || uploading
            ? 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer'
        }`}
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {uploading ? 'Uploading…' : uploadLabel}
      </button>

      {done && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" />
          {done}
        </p>
      )}
      {error && !confirming && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-zinc-900">Confirm the formation date</h3>
            <p className="mt-1 text-sm text-zinc-600">
              The date the state formed the company — the filing date on the Articles
              of Organization. This goes on the SS-4, so please verify it before the
              company is created.
            </p>
            <label className="mt-4 block text-sm font-medium text-zinc-700">
              Formation date
              <input
                type="date"
                value={formationDate}
                onChange={(e) => setFormationDate(e.target.value)}
                disabled={uploading}
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              />
            </label>
            {prefilling && <p className="mt-2 text-xs text-zinc-500">Reading the date from the Articles…</p>}
            {!prefilling && formationDate && (
              <p className="mt-2 text-xs text-emerald-700">Pre-filled from the uploaded Articles — confirm it&apos;s correct.</p>
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setConfirming(false); setError(null); setUploading(false); stagedPathRef.current = null }}
                disabled={uploading}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmFormationDate}
                disabled={uploading || prefilling}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-400"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {uploading ? 'Creating company…' : 'Confirm & Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
