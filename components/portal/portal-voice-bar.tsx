'use client'

import { ArrowUp, Trash2 } from 'lucide-react'
import { clock } from '@/lib/talk/chat-model'

/**
 * The bar the client portal chat shows while a voice note is being recorded (dev job 753b2909) — the same as TD Talk's: a bin to throw the
 * recording away, a pulsing dot with the running clock, and an arrow that sends it. It replaces the message box for the length of the recording.
 * Presentational only: the recording itself is lib/hooks/use-audio-note-recorder.ts (the one TD Talk and the WhatsApp screen use).
 */
export function PortalVoiceBar({ seconds, onDiscard, onSend, discardLabel, recordingLabel, sendLabel }: {
  seconds: number
  onDiscard: () => void
  onSend: () => void
  discardLabel: string
  recordingLabel: string
  sendLabel: string
}) {
  return (
    <div className="flex items-center gap-3" data-testid="portal-recording">
      <button
        type="button"
        onClick={onDiscard}
        aria-label={discardLabel}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-zinc-500 active:bg-zinc-100 hover:bg-zinc-100"
        data-testid="portal-voice-discard"
      >
        <Trash2 className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-[#BE1E2D]" />
        <span className="font-mono text-base tabular-nums text-zinc-800" data-testid="portal-voice-clock">{clock(seconds)}</span>
        <span className="truncate text-sm text-zinc-400">{recordingLabel}</span>
      </div>
      <button
        type="button"
        onClick={onSend}
        aria-label={sendLabel}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#BE1E2D] text-white active:opacity-80 hover:opacity-90"
        data-testid="portal-voice-send"
      >
        <ArrowUp className="h-5 w-5" />
      </button>
    </div>
  )
}
