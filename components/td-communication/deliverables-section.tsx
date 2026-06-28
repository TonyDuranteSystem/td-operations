'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  UploadCloud, Loader2, Trash2, Download, Send, BadgeCheck, Plus, FileText, ImageIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  DELIVERABLE_TYPES,
  deliverableTypeLabel,
  validateDeliverable,
  isImageThumbnailable,
  groupByConcept,
  conceptLabel,
  nextConceptNumber,
  DELIVERABLE_MAX_MB,
} from '@/lib/td-communication/deliverables'
import type { CommDeliverable, DeliverableType } from '@/lib/td-communication/types'

/** Direct-to-storage PUT with upload progress (fetch has no progress events). */
function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else if (xhr.status === 413) reject(new Error(`File too large. Maximum allowed: ${DELIVERABLE_MAX_MB} MB.`))
      else reject(new Error('Upload failed. Please check your connection and try again.'))
    }
    xhr.onerror = () => reject(new Error('Upload failed. Please check your connection and try again.'))
    xhr.send(file)
  })
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return format(parseISO(iso), 'MMM d, yyyy')
  } catch {
    return ''
  }
}

function DeliverableRow({
  d,
  busy,
  onRelease,
  onReleaseFinal,
  onDelete,
}: {
  d: CommDeliverable
  busy: boolean
  onRelease: () => void
  onReleaseFinal: () => void
  onDelete: () => void
}) {
  const isImage = isImageThumbnailable(d.file_name, d.mime_type)
  return (
    <div className="flex items-start gap-3 rounded-lg border border-zinc-200 p-2.5">
      {/* Thumbnail / icon */}
      <div className="shrink-0 h-14 w-14 rounded-md border border-zinc-100 bg-zinc-50 flex items-center justify-center overflow-hidden">
        {isImage && d.preview_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={d.preview_url} alt={d.file_name} className="h-full w-full object-cover" />
        ) : isImage ? (
          <ImageIcon className="h-5 w-5 text-zinc-400" />
        ) : (
          <FileText className="h-5 w-5 text-zinc-400" />
        )}
      </div>

      {/* Meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium text-zinc-900 truncate max-w-[14rem]">{d.file_name}</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-zinc-50 text-zinc-600 border-zinc-200">
            {deliverableTypeLabel(d.type)}
          </span>
          <span className="text-[10px] font-medium text-zinc-400">v{d.version_number}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {d.is_draft ? (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
              Draft
            </span>
          ) : (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              Final
            </span>
          )}
          {d.released_at ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
              <BadgeCheck className="h-3 w-3" /> Released {fmtDate(d.released_at)}
            </span>
          ) : (
            <span className="text-[10px] text-zinc-400">Not released</span>
          )}
        </div>

        {/* Actions */}
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {!d.released_at && (
            <button
              onClick={onRelease}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
            >
              <Send className="h-3 w-3" /> Release to Client
            </button>
          )}
          {d.is_draft && (
            <button
              onClick={onReleaseFinal}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              <BadgeCheck className="h-3 w-3" /> Release Final
            </button>
          )}
          {d.download_url && (
            <a
              href={d.download_url}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
            >
              <Download className="h-3 w-3" /> Download
            </a>
          )}
          <button
            onClick={onDelete}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-zinc-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  )
}

export function DeliverablesSection({
  enrollmentId,
  onChanged,
}: {
  enrollmentId: string
  onChanged?: () => void
}) {
  const [deliverables, setDeliverables] = useState<CommDeliverable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploadType, setUploadType] = useState<DeliverableType>('logo_draft')
  const [activeConcept, setActiveConcept] = useState<number | null>(null)
  const [draftConcept, setDraftConcept] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/td-communication/projects/${enrollmentId}/deliverables`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not load deliverables.')
      }
      const data = await res.json()
      setDeliverables(Array.isArray(data.deliverables) ? data.deliverables : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load deliverables.')
    } finally {
      setLoading(false)
    }
  }, [enrollmentId])

  useEffect(() => {
    load()
  }, [load])

  const concepts = useMemo(() => groupByConcept(deliverables), [deliverables])

  // Tabs = existing concepts ∪ a pending "new" concept the user just opened.
  const conceptNumbers = useMemo(() => {
    const set = new Set(concepts.map((c) => c.concept))
    if (draftConcept != null) set.add(draftConcept)
    return Array.from(set).sort((a, b) => a - b)
  }, [concepts, draftConcept])

  // Keep a valid active concept selected.
  useEffect(() => {
    if (conceptNumbers.length === 0) {
      if (activeConcept !== null) setActiveConcept(null)
      return
    }
    if (activeConcept === null || !conceptNumbers.includes(activeConcept)) {
      setActiveConcept(conceptNumbers[0])
    }
  }, [conceptNumbers, activeConcept])

  const targetConcept = activeConcept ?? 1
  const activeVersions = useMemo(
    () => concepts.find((c) => c.concept === targetConcept)?.versions ?? [],
    [concepts, targetConcept],
  )

  const uploadOne = useCallback(
    async (file: File) => {
      const validationError = validateDeliverable(file.name, file.size)
      if (validationError) {
        toast.error(validationError)
        throw new Error(validationError)
      }
      setUploading(true)
      setProgress(0)
      try {
        const urlRes = await fetch(
          `/api/td-communication/projects/${enrollmentId}/deliverables/upload-url`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_name: file.name }),
          },
        )
        if (!urlRes.ok) {
          const d = await urlRes.json().catch(() => ({}))
          throw new Error(d.error || 'Could not start the upload. Please try again.')
        }
        const { signedUrl, path } = await urlRes.json()
        if (!signedUrl || !path) throw new Error('Could not start the upload. Please try again.')

        await putWithProgress(signedUrl, file, setProgress)

        const recRes = await fetch(`/api/td-communication/projects/${enrollmentId}/deliverables`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: uploadType,
            file_url: path,
            file_name: file.name,
            file_size: file.size,
            mime_type: file.type || null,
            concept_number: targetConcept,
          }),
        })
        if (!recRes.ok) {
          const d = await recRes.json().catch(() => ({}))
          throw new Error(d.error || 'Could not save the deliverable.')
        }
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Upload failed.')
        throw err
      } finally {
        setUploading(false)
        setProgress(0)
      }
    },
    [enrollmentId, uploadType, targetConcept],
  )

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
      if (!arr.length) return
      let anyOk = false
      for (const f of arr) {
        try {
          await uploadOne(f)
          anyOk = true
        } catch {
          /* already toasted */
        }
      }
      if (anyOk) {
        toast.success(arr.length > 1 ? `Uploaded ${arr.length} files` : `Uploaded ${arr[0].name}`)
        // Refresh FIRST so the just-created concept exists in the data, THEN pin
        // the active tab to it and drop the draft placeholder. Order matters: if
        // we cleared the draft before the reload landed, the "keep a valid active
        // concept" effect would briefly see the concept as missing and snap back
        // to Concept A.
        await load()
        setActiveConcept(targetConcept)
        setDraftConcept(null)
        onChanged?.()
      }
    },
    [uploadOne, load, onChanged, targetConcept],
  )

  const doAction = useCallback(
    async (delivId: string, action: 'release' | 'release_final') => {
      setBusyId(delivId)
      try {
        const res = await fetch(
          `/api/td-communication/projects/${enrollmentId}/deliverables/${delivId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          },
        )
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not update the deliverable.')
        }
        toast.success(action === 'release_final' ? 'Released as final' : 'Released to client')
        await load()
        onChanged?.()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Could not update the deliverable.')
      } finally {
        setBusyId(null)
      }
    },
    [enrollmentId, load, onChanged],
  )

  const doDelete = useCallback(
    async (delivId: string) => {
      if (!window.confirm('Delete this deliverable? It will be hidden from the project.')) return
      setBusyId(delivId)
      try {
        const res = await fetch(
          `/api/td-communication/projects/${enrollmentId}/deliverables/${delivId}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not delete the deliverable.')
        }
        toast.success('Deliverable deleted')
        await load()
        onChanged?.()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Could not delete the deliverable.')
      } finally {
        setBusyId(null)
      }
    },
    [enrollmentId, load, onChanged],
  )

  const addConcept = () => {
    const n = nextConceptNumber(deliverables)
    setDraftConcept(n)
    setActiveConcept(n)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-red-600 mb-2">{error}</p>
        <button onClick={load} className="text-sm text-blue-600 hover:underline">
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Concept tabs */}
      {conceptNumbers.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {conceptNumbers.map((c) => (
            <button
              key={c}
              onClick={() => {
                setActiveConcept(c)
                if (c !== draftConcept) setDraftConcept(null)
              }}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-md border',
                c === targetConcept
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50',
              )}
            >
              {conceptLabel(c)}
            </button>
          ))}
          <button
            onClick={addConcept}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border border-dashed border-zinc-300 text-zinc-500 hover:bg-zinc-50"
          >
            <Plus className="h-3 w-3" /> Concept
          </button>
        </div>
      )}

      {/* Upload controls */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-500">Type</label>
        <select
          value={uploadType}
          onChange={(e) => setUploadType(e.target.value as DeliverableType)}
          className="text-xs border border-zinc-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200"
        >
          {DELIVERABLE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">→ {conceptLabel(targetConcept)}</span>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files)
        }}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={cn(
          'cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragOver ? 'border-blue-400 bg-blue-50' : 'border-zinc-200 hover:border-zinc-300 bg-zinc-50/50',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {uploading ? (
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2 text-sm text-zinc-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Uploading… {progress}%
            </div>
            <div className="h-1.5 w-full bg-zinc-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <UploadCloud className="h-6 w-6 text-zinc-400" />
            <p className="text-sm text-zinc-600">
              Drag &amp; drop or <span className="text-blue-600 font-medium">browse</span>
            </p>
            <p className="text-[11px] text-zinc-400">
              Images (PNG, JPG, SVG) &amp; design files (PDF, AI, PSD, EPS) — up to {DELIVERABLE_MAX_MB} MB
            </p>
          </div>
        )}
      </div>

      {/* Version list for the active concept */}
      {deliverables.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-2">No deliverables yet.</p>
      ) : activeVersions.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-2">No files in {conceptLabel(targetConcept)} yet.</p>
      ) : (
        <div className="space-y-2">
          {activeVersions.map((d) => (
            <DeliverableRow
              key={d.id}
              d={d}
              busy={busyId === d.id}
              onRelease={() => doAction(d.id, 'release')}
              onReleaseFinal={() => doAction(d.id, 'release_final')}
              onDelete={() => doDelete(d.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
