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
import { useHoldToSend } from '@/components/chat/use-hold-to-send'
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
  const { files, uploading, limitNotice, add, remove, clear, uploaded, failed, onPaste } = att

  const text = value.trim()
  const readyFiles = files.filter((f) => f.path && !f.error)
  const stillUploading = files.some((f) => !f.path && !f.error)
  // Sendable when there's text, or at least one file that actually uploaded.
  // Files that ERRORED don't count: treating them as "settled" made the button
  // look enabled while clicking it did nothing.
  const canSend = !pending && !disabled && !uploading && !stillUploading && (text.length > 0 || readyFiles.length > 0)

  // THE ACTUAL SEND — runs only once the hold expires (or the staff member presses
  // Enter a second time). The composer is cleared HERE, not when the message is
  // queued: while it is held, cancelling has to put everything back exactly as it
  // was, and the cheapest way to guarantee that is never to have taken it away.
  const { armed, secondsLeft, arm, cancel } = useHoldToSend<{
    message: string
    attachments: UploadedAttachment[]
  }>(async ({ message, attachments }) => {
    onChange('')
    clear()
    await onSend(message, attachments)
  })

  const submit = () => {
    if (!canSend) return
    const attachments = uploaded()
    // A bare file gets an implicit ask, so the worker has something to act on.
    const message = text || (attachments.length ? 'Look at the attached file(s).' : '')
    if (!message) return

    // Never let a failed file vanish on send. The staff member has to know the
    // affidavit didn't make it, or they'll trust an answer built without it.
    // Asked BEFORE the hold starts: a question during the countdown would eat the
    // seconds it exists to give them.
    const lost = failed()
    if (lost.length) {
      const names = lost.map((f) => f.name).join(', ')
      if (!window.confirm(`${names} could not be uploaded and will NOT be sent.\n\nSend anyway?`)) return
    }

    arm({ message, attachments })
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

      {limitNotice && <p className="text-[11px] text-amber-700 pb-1.5">{limitNotice}</p>}

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
            // Escape while held = "I hit Enter too early". Keeps the hands on the
            // keyboard, which is where they already are.
            if (e.key === 'Escape' && armed) {
              e.preventDefault()
              cancel()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // While held, a second Enter means "I'm sure" — sends immediately, so
              // the hold costs nothing when it isn't wanted.
              submit()
            }
          }}
          placeholder={placeholder}
          rows={4}
          className="flex-1 resize-y rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent placeholder:text-zinc-400 min-h-[96px] max-h-64"
        />
        <button
          onClick={() => submit()}
          disabled={!canSend && !armed}
          className={cn(
            'shrink-0 p-2 rounded-xl text-white transition-colors disabled:opacity-40',
            armed ? 'bg-amber-500 hover:bg-amber-600' : 'bg-violet-600 hover:bg-violet-700',
          )}
          title={armed ? 'Send now' : uploading ? 'Waiting for the upload to finish…' : 'Send'}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      {armed ? (
        <div className="flex items-center gap-2 pt-1.5">
          <span className="text-[11px] text-amber-700">Sending in {secondsLeft}s…</span>
          <button
            onClick={cancel}
            className="text-[11px] font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
          >
            Stop
          </button>
          <span className="text-[10px] text-zinc-400">or press Esc — your text stays put</span>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-400 pt-1.5">Paste a screenshot or drop a file to have the worker read it.</p>
      )}
    </div>
  )
}
