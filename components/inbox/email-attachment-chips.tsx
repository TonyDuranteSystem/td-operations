'use client'

/**
 * Staged-attachment chips row shared by the two Inbox email composers
 * (compose-dialog + compose-reply), so they can't drift on upload states,
 * error copy, or remove behavior.
 */

import { FileText, Loader2, X, AlertCircle } from 'lucide-react'
import type { EmailAttachments } from './use-email-attachments'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function EmailAttachmentChips({ attachments }: { attachments: EmailAttachments }) {
  const { files, limitNotice, remove } = attachments
  if (!files.length && !limitNotice) return null

  return (
    <div className="flex flex-col gap-1">
      {limitNotice && (
        <p className="text-xs text-amber-600">{limitNotice}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {files.map((f) => (
          <span
            key={f.localId}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs max-w-full ${
              f.error
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-zinc-200 bg-zinc-50 text-zinc-700'
            }`}
            title={f.error || f.name}
          >
            {f.previewUrl && !f.error ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not a remote image
              <img src={f.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
            ) : f.error ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            ) : f.path ? (
              <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
            )}
            <span className="truncate max-w-[180px]">{f.name}</span>
            <span className={f.error ? 'text-red-400' : 'text-zinc-400'}>
              {f.error ? 'failed' : formatSize(f.size)}
            </span>
            <button
              type="button"
              onClick={() => remove(f.localId)}
              className="shrink-0 rounded p-0.5 hover:bg-zinc-200 text-zinc-400 hover:text-zinc-600"
              aria-label={`Remove ${f.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {files.some((f) => f.error) && (
        <p className="text-xs text-red-500">
          {files.find((f) => f.error)?.error}
        </p>
      )}
    </div>
  )
}
