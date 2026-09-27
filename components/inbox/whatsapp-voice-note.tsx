'use client'

import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { describeVoiceState, type MediaStatus } from '@/lib/messaging/wabridge-media'

export interface VoiceInfo {
  status: MediaStatus
  transcript: string | null
  duration_seconds: number | null
  audio_deleted: boolean
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * One WhatsApp voice note: a player (a fresh short-lived link is fetched only when staff press Play) and its machine transcript.
 * The server only sends this to staff; for anyone else the note stays the plain "[Voice note]" text.
 */
export function WhatsAppVoiceNote({ messageId, voice }: { messageId: string; voice: VoiceInfo }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const state = describeVoiceState({
    status: voice.status,
    transcript: voice.transcript,
    durationSeconds: voice.duration_seconds,
    audioDeleted: voice.audio_deleted,
  })

  async function play() {
    setLoading(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/inbox/whatsapp/voice/${encodeURIComponent(messageId)}`)
      const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !d.url) throw new Error(d.error || 'Could not load the audio — please try again.')
      setUrl(d.url)
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'Could not load the audio — please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">🎤 Voice note{voice.duration_seconds !== null ? ` · ${formatDuration(voice.duration_seconds)}` : ''}</p>
      {state.playable &&
        (url ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio controls autoPlay src={url} className="h-9 w-full max-w-[280px]" onError={() => { setUrl(null); setProblem('The link expired — press Play again.') }} />
        ) : (
          <button
            type="button"
            onClick={play}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Play
          </button>
        ))}
      {state.note && <p className={state.tone === 'warn' ? 'text-[11px] font-medium text-amber-700' : 'text-[11px] text-zinc-500'}>{state.note}</p>}
      {problem && <p className="text-[11px] font-medium text-red-600">{problem}</p>}
      {voice.transcript && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Machine transcript — may be wrong</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-zinc-800">{voice.transcript}</p>
        </div>
      )}
    </div>
  )
}
