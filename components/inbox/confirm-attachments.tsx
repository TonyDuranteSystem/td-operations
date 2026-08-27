'use client'

/**
 * THE FILES ON A CONFIRM CARD — one renderer, every surface.
 *
 * A card that prints a filename asks the staff member to approve a STRING. That
 * was survivable while the only attachable thing was the file they had dropped
 * into the panel two seconds earlier. It is not survivable once a file can come
 * from a conversation (and, later, from a client's records): one company's
 * "EIN Letter.pdf" looks exactly like another's, and the name is the one thing
 * that cannot be checked by reading it.
 *
 * So each file renders as the FILE: images inline, everything else as a tile
 * that opens. No URL is ever shown, and none is stored on the card — the tile
 * points at an id-addressed route that re-authorises on every open, which is
 * what keeps a permanent Team Chat card from carrying a bearer link to a client
 * document in the channel scrollback forever.
 */
import { useRef, useState } from 'react'
import { FileText, Loader2, Paperclip, Plus, X } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'

export interface ConfirmAttachment {
  name: string
  size?: number
  content_type?: string
  /** "posted in this thread by Luca" / "on file for ACME LLC". */
  origin?: string
  /**
   * The loud line: someone else's document, or one we hold back from clients.
   * Never blocks — Antonio's rule is that the human decides — but it must be
   * impossible to miss, so it renders in red above the file, not as a footnote.
   */
  warning?: string
}

/** Where the browser fetches attachment #index of a frozen draft. Staff-gated. */
export function preparedAttachmentHref(preparedId: string, index: number): string {
  return `/api/inbox/worker-chat/prepared-send/${preparedId}/attachment/${index}`
}

/** A size a human can read — KB below a megabyte, never "0.0 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isImage(a: ConfirmAttachment): boolean {
  return (a.content_type ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name)
}

export function ConfirmAttachments({
  preparedId,
  attachments,
  className,
  onChange,
}: {
  preparedId: string
  attachments: ConfirmAttachment[]
  className?: string
  /**
   * Called with the server's new file list after an add or a remove. Given, the
   * card shows Add/Remove controls; omitted, it stays read-only — so a surface
   * that cannot refresh its own state never offers a control that would leave
   * the card disagreeing with the email.
   */
  onChange?: (attachments: ConfirmAttachment[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /** Upload straight to private storage, then attach it to THIS draft. */
  const addFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const signRes = await fetch(`/api/inbox/worker-chat/prepared-send/${preparedId}/attachments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name, file_size: file.size, mime_type: file.type }),
      })
      const sign = await signRes.json().catch(() => ({}))
      // R099: surface the server's real reason — a size or type refusal is
      // actionable, "upload failed" is not.
      if (!signRes.ok) throw new Error(sign.error || 'Could not start the upload.')

      const put = await fetch(sign.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error('The file did not finish uploading — please try again.')

      const attachRes = await fetch(`/api/inbox/worker-chat/prepared-send/${preparedId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', path: sign.path, name: file.name, mime_type: file.type, size: file.size }),
      })
      const attached = await attachRes.json().catch(() => ({}))
      if (!attachRes.ok) throw new Error(attached.error || 'Could not attach that file.')
      onChange?.(attached.attachments ?? [])
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not attach that file.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const removeFile = async (index: number) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/inbox/worker-chat/prepared-send/${preparedId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', index }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not remove that file.')
      onChange?.(data.attachments ?? [])
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not remove that file.')
    } finally {
      setBusy(false)
    }
  }

  // A card with no files still shows the Add control when editing is available —
  // "I forgot the attachment" is the whole reason this exists.
  if (!attachments?.length && !onChange) return null
  return (
    <div className={className ?? 'mt-2 space-y-1.5'}>
      {attachments.map((a, i) => {
        const href = preparedAttachmentHref(preparedId, i)
        // Size is shown only when it is actually known, and in a unit that says
        // something: every small file used to read "0.0 MB", which is not a size,
        // it is noise sitting where a real number belongs.
        const size = typeof a.size === 'number' ? formatFileSize(a.size) : null
        return (
          <div key={i} className="relative">
          {onChange && (
            <FastTooltip label={`Remove ${a.name}`} className="absolute right-1 top-1 z-10">
              <button
                type="button"
                onClick={() => removeFile(i)}
                disabled={busy}
                aria-label={`Remove ${a.name}`}
                className="rounded-full bg-white/90 p-0.5 text-zinc-400 hover:text-red-600 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </FastTooltip>
          )}
          <FastTooltip label={`Open ${a.name}`} className="w-full">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-amber-200 bg-white p-1.5 hover:border-amber-300 hover:bg-amber-50/60"
              aria-label={`Open ${a.name}`}
            >
              {isImage(a) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={href} alt={a.name} className="max-h-40 w-auto rounded-md border border-zinc-200" />
              ) : null}
              <div className="flex items-center gap-1.5 text-xs text-zinc-700">
                {isImage(a) ? <Paperclip className="h-3 w-3 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate font-medium">{a.name}</span>
                {size && <span className="shrink-0 text-zinc-400">{size}</span>}
              </div>
              {a.origin && <p className="mt-0.5 pl-5 text-[11px] text-zinc-500">{a.origin}</p>}
              {a.warning && (
                <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">{a.warning}</p>
              )}
            </a>
          </FastTooltip>
          </div>
        )
      })}
      {onChange && (
        <div className="flex items-center gap-2 pt-0.5">
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) addFile(f) }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-amber-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add a file
          </button>
        </div>
      )}
      {error && <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">{error}</p>}
    </div>
  )
}
