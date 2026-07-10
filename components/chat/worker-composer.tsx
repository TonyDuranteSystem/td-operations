'use client'

/**
 * Composer for the CRM worker panels: textarea + paste/drag-drop/attach.
 *
 * Shared by the Inbox panel and the Portal Chats Worker tab. Both previously
 * carried their own copy of this markup ("consolidation is a flagged
 * follow-up"); attachments are exactly the kind of feature that would have gone
 * into one and not the other, so it lives here once.
 */

import { useRef } from 'react'
import { Loader2, Paperclip, Send, X, FileText, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UploadedAttachment, WorkerAttachments } from './use-worker-attachments'

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface WorkerComposerProps {
  placeholder: string
  pending: boolean
  disabled?: boolean
  onSend: (text: string, attachments: UploadedAttachment[]) => void | Promise<void>
  value: string
  onChange: (v: string) => void
  /**
   * Attachment state, owned by the PANEL — the drop target is the whole panel,
   * not this strip, so the two have to read and write the same list.
   */
  attachments: WorkerAttachments
}

export function WorkerComposer({ placeholder, pending, disabled, onSend, value, onChange, attachments: att }: WorkerComposerProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { files, uploading, add, remove, clear, uploaded, onPaste } = att

  const ready = files.length > 0 && files.every((f) => f.path || f.error)
  // A message with nothing but a still-uploading file isn't sendable yet.
  const canSend = !pending && !disabled && !uploading && (value.trim().length > 0 || (files.length > 0 && ready))

  const submit = async () => {
    if (!canSend) return
    const attachments = uploaded()
    const text = value.trim()
    // The worker needs SOMETHING to act on; a bare file gets an implicit ask.
    const message = text || (attachments.length ? 'Look at the attached file(s).' : '')
    if (!message) return
    onChange('')
    clear()
    await onSend(message, attachments)
  }

  return (
    <div className="border-t px-3 py-2.5 shrink-0">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {files.map((f) => (
            <div
              key={f.localId}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] max-w-full',
                f.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-zinc-200 bg-zinc-50 text-zinc-700',
              )}
            >
              {f.mimeType.startsWith('image/') ? (
                <ImageIcon className="h-3 w-3 shrink-0" />
              ) : (
                <FileText className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate max-w-[140px] font-medium">{f.name}</span>
              {f.error ? (
                <span className="truncate max-w-[180px]">— {f.error}</span>
              ) : f.path ? (
                <span className="text-zinc-400">{fileSize(f.size)}</span>
              ) : (
                <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
              )}
              <button
                onClick={() => remove(f.localId)}
                className="p-0.5 rounded hover:bg-black/5 shrink-0"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={pending || disabled}
          className={cn(
            'shrink-0 p-2 rounded-xl transition-colors disabled:opacity-40',
            files.length ? 'text-violet-600 bg-violet-100' : 'text-zinc-400 hover:bg-zinc-100',
          )}
          title="Attach a file"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            if (picked.length) void add(picked)
            e.target.value = ''
          }}
          className="hidden"
        />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={placeholder}
          rows={4}
          className="flex-1 resize-y rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent placeholder:text-zinc-400 min-h-[96px] max-h-64"
        />
        <button
          onClick={() => void submit()}
          disabled={!canSend}
          className="shrink-0 p-2 rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 transition-colors"
          title={uploading ? 'Waiting for the upload to finish…' : 'Send'}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      <p className="text-[10px] text-zinc-400 pt-1.5">Paste a screenshot or drop a file to have the worker read it.</p>
    </div>
  )
}
