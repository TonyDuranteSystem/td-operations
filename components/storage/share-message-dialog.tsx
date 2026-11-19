'use client'

/**
 * The staff "eye" pop-up: asked when a hidden document is about to be shown to the client.
 *
 * Three ways out: "Send message" (show it + tell the client in chat; the portal notification goes out too), "Show only"
 * (show it and tell the client NOTHING — no notification, no push, no chat), "Cancel" / Escape / click outside (do nothing — the file stays hidden). Closing NEVER sends.
 *
 * Who it goes to comes from the document's own owner (pre-selected, never guessed); the person's other open companies
 * and the personal chat are the other choices. A closed company cannot be picked. Default topic is "Documents".
 * The send itself is done by the caller through POST /api/portal/chat, so every rule of a normal staff send applies.
 *
 * The window has a FIXED height with a scrolling body and a pinned button row: the member list loads after the window opens,
 * and a window that grew would move the buttons from under an aimed click (the same trap the Portal Chats pop-up had).
 */
import { useEffect, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'
import { buildDocumentShareMessage, type ShareContext, type ShareTarget } from '@/lib/portal/document-share-text'
import { MessageTargetFields, useMessageTarget } from '@/components/storage/message-target-fields'

type Askable = Extract<ShareContext, { askable: true }>

export type ShareDialogResult =
  | { action: 'cancel' }
  | { action: 'just_show' }
  | { action: 'send'; target: ShareTarget; topic: string; message: string; addressedToMemberId: string | null; addressedToCompany: boolean }

export type ShareSendResult = Extract<ShareDialogResult, { action: 'send' }>

/**
 * mode 'document' (default): the staff "eye" pop-up — a document is being shown, "Show only" is an option, the message starts filled in.
 * mode 'message' (the Contact page's Message button): a plain message — no document, no "Show only", an empty message box, a "General"
 * topic (no topic), nothing pre-selected unless there is exactly one choice. With `onSend` the pop-up stays open while the message goes
 * out and shows the server's reason if it fails, so a typed message is never lost; the caller closes it on success.
 */
export function ShareMessageDialog({ fileNames = [], ctx, note, onResult, mode = 'document', onSend }: {
  fileNames?: string[]; ctx: Askable; note?: string; onResult: (r: ShareDialogResult) => void
  mode?: 'document' | 'message'; onSend?: (r: ShareSendResult) => Promise<void>
}) {
  const isMessage = mode === 'message'
  const t = useMessageTarget(ctx, isMessage)
  const { target, finalTopic } = t
  const [message, setMessage] = useState(() => (isMessage ? '' : buildDocumentShareMessage(ctx.locale, fileNames)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onResult({ action: 'cancel' }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResult, busy])

  // a plain message may have NO topic ("General"); a document message always has one
  const canSend = !!target && !target.closed && !!message.trim() && (isMessage || !!finalTopic) && !busy

  const send = () => {
    if (!canSend || !target) return
    const result: ShareSendResult = { action: 'send', ...t.selection!, message: message.trim() }
    setBusy(true) // one click only
    if (isMessage && onSend) {
      setError(null)
      onSend(result).catch((e) => { setError(e instanceof Error && e.message ? e.message : 'The message could not be sent — please try again.'); setBusy(false) })
      return // the caller closes the pop-up on success
    }
    onResult(result) // the caller closes the pop-up
  }

  const title = isMessage ? `Message ${ctx.recipientName ?? 'the client'}` : `Tell the client about ${fileNames.length > 1 ? 'these documents' : 'this document'}?`
  // a stray click outside must not throw away a message that has been typed
  const clickOutside = () => { if (!isMessage || !message.trim()) onResult({ action: 'cancel' }) }

  return (
    <div className="fixed inset-0 z-[62] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={clickOutside}>
      <div ref={rootRef} className="flex h-[min(92vh,680px)] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()} onKeyDown={trapTabKey}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Send className="h-4 w-4 text-blue-500" />
          <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-800">{title}</h3>
          <button type="button" aria-label="Cancel" onClick={() => onResult({ action: 'cancel' })} className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {!isMessage && <p className="break-words text-zinc-600"><strong>{fileNames[0]}</strong>{fileNames.length > 1 ? ` and ${fileNames.length - 1} more` : ''} will be shown to the client either way. <strong>Show only</strong> tells the client nothing (no notification, no message); <strong>Send message</strong> posts your message in chat and the client also gets the portal notification.</p>}
          {note && <p className="text-xs text-zinc-500">{note}</p>}

          <MessageTargetFields t={t} ctx={ctx} isMessage={isMessage} />

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500" htmlFor="share-dialog-message">{isMessage ? `Message (the language on file is ${ctx.locale === 'it' ? 'Italian' : 'English'})` : `Message (${ctx.locale === 'it' ? 'Italian' : 'English'} — you can edit it)`}</label>
            <textarea id="share-dialog-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={isMessage ? 6 : 4} maxLength={5000} autoFocus={isMessage} className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-[11px] text-zinc-400">{isMessage ? 'The client may get an email about the message too, but not every time.' : 'The client may get an email about the message too, but not every time (at most one email per chat every 2 hours).'}</p>
            {error && <p className="mt-1.5 text-xs text-red-600" role="alert">{error}</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <button type="button" onClick={() => onResult({ action: 'cancel' })} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">Cancel</button>
          {!isMessage && <button type="button" disabled={busy} onClick={() => { setBusy(true); onResult({ action: 'just_show' }) }} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50">Show only — no notification</button>}
          <button type="button" disabled={!canSend} onClick={send} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">{busy ? 'Sending…' : 'Send message'}</button>
        </div>
      </div>
    </div>
  )
}
