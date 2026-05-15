'use client'

import { FileText, ExternalLink } from 'lucide-react'

/**
 * pdf_list — Attachment template for tasks that reference a list of PDFs
 * already uploaded to Google Drive.
 *
 * Used by Slice 4 ITIN workflow: W-7, 1040-NR, Schedule OI rendered as
 * clickable chips so Luca/Antonio can preview before approving.
 *
 * Expected task_meta shape:
 *   {
 *     attachments: Array<{
 *       kind: 'w7' | '1040nr' | 'schedule_oi' | 'passport_copy' | string,
 *       file_id: string,
 *       file_name: string,
 *       mime_type?: string,
 *     }>
 *   }
 *
 * The component is defensive: malformed task_meta renders an inline notice
 * rather than throwing (the WorkflowErrorBoundary will catch genuine throws
 * upstream).
 */

interface AttachmentRow {
  kind?: string
  file_id?: string
  file_name?: string
  mime_type?: string
}

function isAttachmentRow(x: unknown): x is AttachmentRow {
  return typeof x === 'object' && x !== null
}

function driveUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`
}

export function PdfListAttachment({ taskMeta }: { taskMeta: Record<string, unknown> | null | undefined }) {
  const raw = taskMeta?.attachments
  if (!Array.isArray(raw)) {
    return (
      <div className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700">
        No attachments to preview.
      </div>
    )
  }
  const rows: AttachmentRow[] = raw.filter(isAttachmentRow) as AttachmentRow[]
  if (rows.length === 0) {
    return (
      <div className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700">
        No attachments to preview.
      </div>
    )
  }

  return (
    <ul className="flex flex-wrap gap-1.5">
      {rows.map((att, i) => {
        const label = att.file_name || att.kind || `Attachment ${i + 1}`
        const fileId = typeof att.file_id === 'string' ? att.file_id : null
        return (
          <li key={`${fileId ?? 'na'}-${i}`}>
            {fileId ? (
              <a
                href={driveUrl(fileId)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs hover:bg-blue-100 transition-colors"
                title={label}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[200px]">{label}</span>
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 text-zinc-600 text-xs">
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[200px]">{label}</span>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
