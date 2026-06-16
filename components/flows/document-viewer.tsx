'use client'

import { useEffect, useState } from 'react'
import { FileText, ExternalLink as ExternalLinkIcon, Loader2 } from 'lucide-react'
import { formatBytes, formatUploadDate } from '@/lib/flows/workspace-format'

interface FlowDocument {
  id: string
  file_name: string | null
  drive_link: string | null
  mime_type: string | null
  file_size: number | null
  flow_stage: string | null
  created_at: string | null
}

interface DocumentViewerProps {
  serviceDeliveryId: string
  /** Optional heading override from stage_layout. */
  label?: string
}

/**
 * Lists the documents bound to a flow (service_delivery). Each document is a
 * card with its filename, upload date and size, plus a "View" link that opens
 * the file (Drive link in production, signed Storage URL in sandbox). Empty
 * state shows "No documents uploaded yet". Surfaces the server's real error on
 * failure (R099) rather than a generic message.
 */
export function DocumentViewer({ serviceDeliveryId, label }: DocumentViewerProps) {
  const [documents, setDocuments] = useState<FlowDocument[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/documents`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Could not load documents.')
        }
        if (!cancelled) setDocuments(data.documents as FlowDocument[])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : 'Could not load documents.')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [serviceDeliveryId])

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">{label || 'Documents'}</h3>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!error && documents === null && (
        <p className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading documents…
        </p>
      )}

      {!error && documents !== null && documents.length === 0 && (
        <p className="text-sm text-zinc-500">No documents uploaded yet</p>
      )}

      {!error && documents !== null && documents.length > 0 && (
        <ul className="space-y-2">
          {documents.map((doc) => {
            const size = formatBytes(doc.file_size)
            const date = formatUploadDate(doc.created_at)
            return (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-800">
                    {doc.file_name || 'Untitled document'}
                  </div>
                  <div className="text-xs text-zinc-400">
                    {date ?? 'Unknown date'}
                    {size ? ` · ${size}` : ''}
                  </div>
                </div>
                {doc.drive_link ? (
                  <a
                    href={doc.drive_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-blue-700 hover:bg-blue-50"
                  >
                    <ExternalLinkIcon className="h-3.5 w-3.5" />
                    View
                  </a>
                ) : (
                  <span className="shrink-0 text-xs text-zinc-400">No link</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
