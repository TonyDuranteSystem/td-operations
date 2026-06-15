'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, Loader2, CheckCircle2, FileUp, X } from 'lucide-react'

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

  async function handleUpload() {
    if (!file || uploading) return
    setUploading(true)
    setError(null)
    setDone(null)
    try {
      const storagePath = `flow-uploads/${serviceDeliveryId}/${Date.now()}_${file.name}`

      // a. Signed URL.
      const sigRes = await fetch('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'onboarding-uploads',
          path: storagePath,
          contentType: file.type || 'application/pdf',
        }),
      })
      if (!sigRes.ok) {
        const d = await sigRes.json().catch(() => ({}))
        throw new Error(d.error || 'Could not start the upload. Please try again.')
      }
      const { signedUrl } = await sigRes.json()
      if (!signedUrl) throw new Error('Could not start the upload. Please try again.')

      // b. PUT to Storage.
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file,
      })
      if (!putRes.ok) throw new Error('The file could not be saved to storage. Please try again.')

      // c. Register against the flow (Drive + documents row + auto-advance).
      const apiRes = await fetch(`/api/flows/${serviceDeliveryId}/upload-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type || 'application/pdf',
          flow_stage: flowStage,
          // Default true preserves existing auto-advance behavior for every
          // other upload stage; only pass false when explicitly opted out.
          auto_advance: autoAdvance === false ? false : undefined,
        }),
      })
      const data = await apiRes.json().catch(() => ({}))
      if (!apiRes.ok || !data.success) {
        throw new Error(data.detail || data.error || 'Upload failed — please try again.')
      }
      setDone(`${file.name} uploaded`)
      clearPick()
      router.refresh()
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
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}
