'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadCloud, Loader2, ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  fileToLogo,
  deliverableToLogo,
  fetchImageDeliverables,
  type LoadedLogo,
  type ImageDeliverableOption,
} from './logo-utils'

/**
 * Shared logo source picker for the mockup + asset-kit tools: upload a file OR
 * pick one of the project's image deliverables (loaded CORS-safe through the
 * byte passthrough). Empty state guides Cris when no logo exists yet.
 */
export function LogoPicker({
  enrollmentId,
  onLogo,
  loadedName,
}: {
  /** null = scratchpad: upload only, no "pick a deliverable" option. */
  enrollmentId: string | null
  onLogo: (logo: LoadedLogo) => void
  loadedName?: string | null
}) {
  const [options, setOptions] = useState<ImageDeliverableOption[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!enrollmentId) {
      setOptions([])
      return
    }
    fetchImageDeliverables(enrollmentId).then(setOptions).catch(() => setOptions([]))
  }, [enrollmentId])

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        onLogo(await fileToLogo(file))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load the logo.')
      } finally {
        setBusy(false)
      }
    },
    [onLogo],
  )

  const handleDeliverable = useCallback(
    async (opt: ImageDeliverableOption) => {
      if (!enrollmentId) return
      setBusy(true)
      try {
        onLogo(await deliverableToLogo(enrollmentId, opt.id, opt.file_name))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load the logo.')
      } finally {
        setBusy(false)
      }
    },
    [enrollmentId, onLogo],
  )

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
        onClick={() => !busy && fileRef.current?.click()}
        className={cn(
          'cursor-pointer rounded-lg border-2 border-dashed px-4 py-4 text-center transition-colors',
          dragOver ? 'border-blue-400 bg-blue-50' : 'border-zinc-200 hover:border-zinc-300 bg-zinc-50/50',
        )}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
        {busy ? (
          <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading logo…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1">
            <UploadCloud className="h-5 w-5 text-zinc-400" />
            <p className="text-sm text-zinc-600">
              {loadedName ? (
                <>
                  Logo: <span className="font-medium">{loadedName}</span> — drop another to replace
                </>
              ) : (
                <>
                  Drop a logo or <span className="text-blue-600 font-medium">browse</span> (PNG, JPG, SVG)
                </>
              )}
            </p>
          </div>
        )}
      </div>

      {options.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 shrink-0 inline-flex items-center gap-1">
            <ImageIcon className="h-3 w-3" /> or a deliverable
          </span>
          <select
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              const opt = options.find((o) => o.id === e.target.value)
              if (opt) handleDeliverable(opt)
              e.target.value = ''
            }}
            className="text-xs border border-zinc-200 rounded-md px-2 py-1 flex-1 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <option value="" disabled>
              Choose an uploaded image…
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.file_name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
