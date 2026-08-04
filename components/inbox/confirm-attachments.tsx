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
import { FileText, Paperclip } from 'lucide-react'

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
}: {
  preparedId: string
  attachments: ConfirmAttachment[]
  className?: string
}) {
  if (!attachments?.length) return null
  return (
    <div className={className ?? 'mt-2 space-y-1.5'}>
      {attachments.map((a, i) => {
        const href = preparedAttachmentHref(preparedId, i)
        // Size is shown only when it is actually known, and in a unit that says
        // something: every small file used to read "0.0 MB", which is not a size,
        // it is noise sitting where a real number belongs.
        const size = typeof a.size === 'number' ? formatFileSize(a.size) : null
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-amber-200 bg-white p-1.5 hover:border-amber-300 hover:bg-amber-50/60"
            title={`Open ${a.name}`}
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
        )
      })}
    </div>
  )
}
