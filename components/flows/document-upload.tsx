'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, Loader2, CheckCircle2, FileUp } from 'lucide-react'

interface DocumentUploadProps {
  /** Label from stage_layout, e.g. "Upload Extension Receipt". */
  label?: string
  serviceDeliveryId: string
  /** Stamped onto the documents row as flow_stage (the stage that expects it). */
  flowStage: string | null
}

/**
 * Upload a document bound to a flow + stage. Two-step (same as CRM doc upload):
 *   1. PUT the file to Supabase Storage via a signed URL (bypasses Vercel 4.5MB).
 *   2. POST to /api/flows/[id]/upload-document → Drive + documents row stamped
 *      with service_delivery_id + flow_stage.
 * Surfaces the server's real error on failure (R099) — never a generic toast.
 */
export function DocumentUpload({ label, serviceDeliveryId, flowStage }: DocumentUploadProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    setDone(null)
    try {
      const storagePath = `flow-uploads/${serviceDeliveryId}/${Date.now()}_${file.name}`

      // 1. Signed URL.
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

      // 2. PUT to Storage.
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file,
      })
      if (!putRes.ok) throw new Error('The file could not be saved to storage. Please try again.')

      // 3. Register against the flow.
      const apiRes = await fetch(`/api/flows/${serviceDeliveryId}/upload-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type || 'application/pdf',
          flow_stage: flowStage,
        }),
      })
      const data = await apiRes.json().catch(() => ({}))
      if (!apiRes.ok || !data.success) {
        throw new Error(data.detail || data.error || 'Upload failed — please try again.')
      }
      setDone(`${file.name} uploaded`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Upload failed — please try again.')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileUp className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">{label || 'Upload Document'}</h3>
      </div>

      <input
        ref={inputRef}
        type="file"
        onChange={handleFile}
        disabled={uploading}
        className="hidden"
        id={`flow-upload-${serviceDeliveryId}`}
      />
      <label
        htmlFor={`flow-upload-${serviceDeliveryId}`}
        className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border transition-colors ${
          uploading
            ? 'border-zinc-200 text-zinc-400 cursor-not-allowed'
            : 'border-blue-300 text-blue-700 hover:bg-blue-50 cursor-pointer'
        }`}
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {uploading ? 'Uploading…' : 'Choose file'}
      </label>

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
