'use client'

import { FileText, ExternalLink, Globe, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AccountDocument {
  id: string
  file_name: string
  document_type_name: string | null
  category_name: string | null
  drive_link: string | null
  mime_type: string | null
  file_size: number | null
  processed_at: string | null
  portal_visible: boolean
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(d: string | null): string {
  if (!d) return ''
  try {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return ''
  }
}

/**
 * Lists ALL documents linked to an account from the `documents` table —
 * including Storage-backed uploads (drive_file_id = "storage:…", drive_link is a
 * signed Supabase Storage URL) that the Drive-only FileManager cannot show.
 *
 * This is the source of truth for "documents on file": the new Company
 * Formation flow uploads via the Storage fallback and never creates a Google
 * Drive folder, so without this list the Documents tab counted "4" but rendered
 * nothing (FileManager's "No Google Drive folder" empty state). Mirrors the flow
 * workspace's document-viewer: each row links to drive_link (Drive URL in prod,
 * signed Storage URL for the fallback).
 */
export function AccountDocumentsList({ documents }: { documents: AccountDocument[] }) {
  if (!documents || documents.length === 0) return null

  return (
    <div className="rounded-lg border bg-white">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <FileText className="h-4 w-4" />
        <h3 className="text-sm font-semibold">Documents on file</h3>
        <span className="text-xs text-muted-foreground">{documents.length}</span>
      </div>

      <ul className="divide-y">
        {documents.map(doc => {
          const meta = [
            doc.document_type_name,
            formatDate(doc.processed_at),
            formatBytes(doc.file_size),
          ].filter(Boolean).join(' · ')

          return (
            <li key={doc.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                <div className="min-w-0">
                  <div className="truncate text-zinc-900">{doc.file_name || 'Untitled document'}</div>
                  {meta && <div className="truncate text-xs text-muted-foreground">{meta}</div>}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  title={doc.portal_visible ? 'Visible to client' : 'Hidden from client'}
                  className={cn('inline-flex', doc.portal_visible ? 'text-green-600' : 'text-zinc-300')}
                >
                  {doc.portal_visible ? <Globe className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </span>
                {doc.drive_link ? (
                  <a
                    href={doc.drive_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-blue-700 hover:bg-blue-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">No link</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
