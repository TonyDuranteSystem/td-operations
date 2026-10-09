'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, CornerUpLeft, Mic, Paperclip, Pencil, Trash2, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAudioNoteRecorder } from '@/lib/hooks/use-audio-note-recorder'
import { prepareChatFiles, CHAT_ATTACHMENT_MAX_COUNT } from '@/lib/team/attachment'
import { clock, snippet, type TalkMessage } from '@/lib/talk/chat-model'

/** A voice note longer than this is stopped and sent by itself. */
const MAX_VOICE_SECONDS = 5 * 60

export interface TalkSendInput {
  text: string
  files: File[]
  /** The message being answered (a quoted reply), if any. */
  replyToId?: string | null
}

/** What the box is doing besides plain writing: answering a message, or editing one of mine. */
export type TalkComposerMode =
  | { kind: 'reply'; message: TalkMessage; who: string }
  | { kind: 'edit'; message: TalkMessage }
  | null

/**
 * The message box: text, photos/files (the paperclip — on iPhone it offers Take Photo / Photo Library / Files), and
 * voice notes (tap the microphone, talk, tap send — or the bin to throw it away). `onSend` resolves true when the
 * message went out, so a failed send keeps what was typed.
 */
export function TalkComposer({
  onSend, onEdit, mode, onCancelMode, disabled,
}: {
  onSend: (input: TalkSendInput) => Promise<boolean>
  onEdit: (id: string, text: string) => Promise<boolean>
  mode: TalkComposerMode
  onCancelMode: () => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef(text)
  const modeRef = useRef(mode)
  modeRef.current = mode
  textRef.current = text
  const editingId = mode?.kind === 'edit' ? mode.message.id : null
  const replyingId = mode?.kind === 'reply' ? mode.message.id : null

  // entering Edit loads the message into the box; entering Reply just puts the cursor there
  useEffect(() => {
    if (mode?.kind === 'edit') { setText(mode.message.message ?? ''); setFiles([]) }
    if (mode) taRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, replyingId])

  const send = useCallback(async (input: TalkSendInput) => {
    setBusy(true)
    try {
      const ok = await onSend(input)
      return ok
    } finally {
      setBusy(false)
    }
  }, [onSend])

  const { isRecording, startRecording, stopRecording, cancelRecording, isSupported } = useAudioNoteRecorder({
    preferMp4: true,
    onRecorded: file => { void send({ text: '', files: [file], replyToId: modeRef.current?.kind === 'reply' ? modeRef.current.message.id : null }) },
    onError: msg => toast.error(msg),
  })

  // recording clock + the 5-minute ceiling
  useEffect(() => {
    if (!isRecording) { setSeconds(0); return }
    const started = Date.now()
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      setSeconds(s)
      if (s >= MAX_VOICE_SECONDS) stopRecording()
    }, 250)
    return () => clearInterval(t)
  }, [isRecording, stopRecording])

  // grow the box with the text (up to ~5 lines)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [text])

  const canSend = (text.trim().length > 0 || files.length > 0) && !busy && !disabled

  const submit = useCallback(async () => {
    if (!canSend) return
    const sentText = text.trim()
    const sentFiles = files
    if (mode?.kind === 'edit') {
      const id = mode.message.id
      setBusy(true)
      const ok = await onEdit(id, sentText)
      setBusy(false)
      if (ok) { setText(''); onCancelMode() }
      return
    }
    const replyToId = mode?.kind === 'reply' ? mode.message.id : null
    setText(''); setFiles([])
    const ok = await send({ text: sentText, files: sentFiles, replyToId })
    if (ok) { if (replyToId) onCancelMode() }
    if (!ok) {
      // keep what was typed so nothing is lost; do not overwrite anything typed meanwhile
      setText(prev => prev || sentText)
      setFiles(prev => (prev.length ? prev : sentFiles))
    }
  }, [canSend, text, files, send, mode, onEdit, onCancelMode])

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const intake = prepareChatFiles(Array.from(list), files.length, CHAT_ATTACHMENT_MAX_COUNT)
    if (intake.rejected.length) toast.error(`Can't attach: ${intake.rejected.join(', ')}`)
    if (intake.overflow > 0) toast.error(`Up to ${CHAT_ATTACHMENT_MAX_COUNT} files per message.`)
    if (intake.accepted.length) setFiles(prev => [...prev, ...intake.accepted])
    if (fileRef.current) fileRef.current.value = ''
  }

  if (isRecording) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-t border-zinc-200 bg-white px-3 py-2.5" data-testid="talk-recording">
        <button type="button" onClick={cancelRecording} aria-label="Throw away the recording" className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-100">
          <Trash2 className="h-5 w-5" />
        </button>
        <div className="flex flex-1 items-center gap-2">
          <span className="h-3 w-3 animate-pulse rounded-full bg-[#BE1E2D]" />
          <span className="font-mono text-base tabular-nums text-zinc-800">{clock(seconds)}</span>
          <span className="text-sm text-zinc-400">Recording…</span>
        </div>
        <button type="button" onClick={stopRecording} aria-label="Send the voice note" data-testid="talk-voice-send" className="flex h-11 w-11 items-center justify-center rounded-full bg-[#BE1E2D] text-white active:opacity-80">
          <ArrowUp className="h-5 w-5" />
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-zinc-200 bg-white px-2 pb-2 pt-2">
      {mode && (
        <div className="mx-1 mb-2 flex items-center gap-2 rounded-lg border-l-4 border-[#BE1E2D] bg-zinc-100 px-3 py-1.5" data-testid="talk-mode-bar">
          {mode.kind === 'reply' ? <CornerUpLeft className="h-4 w-4 shrink-0 text-zinc-500" /> : <Pencil className="h-4 w-4 shrink-0 text-zinc-500" />}
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-[#BE1E2D]">{mode.kind === 'reply' ? `Replying to ${mode.who}` : 'Editing message'}</span>
            <span className="block truncate text-[13px] text-zinc-600">{snippet(mode.message, 70)}</span>
          </span>
          <button type="button" aria-label="Cancel" onClick={() => { if (mode.kind === 'edit') setText(''); onCancelMode() }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pb-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex max-w-[60%] items-center gap-1 rounded-full bg-zinc-100 py-1 pl-3 pr-1 text-xs text-zinc-700">
              <span className="truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-200">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => pick(e.target.files)} data-testid="talk-file-input" />
        {mode?.kind !== 'edit' && (
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Attach a photo or file" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-100 disabled:opacity-40">
            <Paperclip className="h-5 w-5" />
          </button>
        )}
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          disabled={disabled}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && mode) { if (mode.kind === 'edit') setText(''); onCancelMode(); return }
            // On a computer Enter sends (Shift+Enter = new line); on a phone Enter is a new line and the arrow sends.
            if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Message"
          enterKeyHint="enter"
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-3xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[16px] leading-snug outline-none focus:border-zinc-300"
          data-testid="talk-input"
        />
        {canSend ? (
          <button type="button" onClick={() => void submit()} aria-label="Send" data-testid="talk-send" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#BE1E2D] text-white active:opacity-80">
            {mode?.kind === 'edit' ? <Check className="h-5 w-5" /> : <ArrowUp className="h-5 w-5" />}
          </button>
        ) : busy ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></span>
        ) : isSupported && mode?.kind !== 'edit' ? (
          <button type="button" onClick={startRecording} disabled={disabled} aria-label="Record a voice message" data-testid="talk-mic" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#BE1E2D] text-white active:opacity-80 disabled:opacity-40">
            <Mic className="h-5 w-5" />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" />
        )}
      </div>
    </div>
  )
}
