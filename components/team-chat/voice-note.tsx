'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { transcriptLines, type VoiceTranscript } from '@/lib/team/voice-text'

/**
 * A voice note you can play right where it is, with a "Show text" button (dev job c1e326dd). Used by TD Talk and the CRM
 * Team Chat page so both show the same thing. Nothing is sent to the speech service until the button is tapped; the result
 * is saved on the message, so after the first tap both people see the words straight away.
 */
export function VoiceNote({ messageId, index, url, transcript: saved, tone = 'light', onBroken }: {
  messageId: string
  index: number
  url: string
  transcript?: VoiceTranscript | null
  /** 'dark' = text sits on a dark bubble. */
  tone?: 'light' | 'dark'
  onBroken?: () => void
}) {
  const [fetched, setFetched] = useState<VoiceTranscript | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const transcript = saved ?? fetched

  const show = async () => {
    setError(null)
    if (transcript) { setOpen(o => !o); return }
    setBusy(true)
    try {
      const r = await fetch(`/api/team/messages/${messageId}/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not turn this voice note into text. Please try again.')
      setFetched(d.transcript as VoiceTranscript)
      setOpen(true)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not turn this voice note into text. Please try again.')
    } finally { setBusy(false) }
  }

  const muted = tone === 'dark' ? 'text-white/70' : 'text-zinc-500'
  return (
    <div className="flex flex-col gap-1" data-testid="voice-note">
      <audio controls preload="metadata" src={url} className="h-10 w-60 max-w-full" onError={onBroken} data-testid="talk-voice-note" />
      <button
        type="button"
        onClick={show}
        disabled={busy}
        data-testid="voice-show-text"
        className={`flex items-center gap-1 self-start text-xs underline ${muted}`}
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        {busy ? 'Reading the voice note…' : transcript && open ? 'Hide text' : 'Show text'}
      </button>
      {error && <p className="text-xs text-red-600" data-testid="voice-text-error">{error}</p>}
      {transcript && open && (
        <div className={`rounded-lg px-2 py-1.5 text-sm ${tone === 'dark' ? 'bg-white/10' : 'bg-zinc-100'}`} data-testid="voice-text">
          {transcriptLines(transcript).map(l => (
            <p key={l.label} className="whitespace-pre-wrap break-words"><span className={`text-[10px] uppercase tracking-wide ${muted}`}>{l.label}</span><br />{l.text}</p>
          ))}
          <p className={`mt-1 text-[10px] ${muted}`}>Machine text — it can be wrong.</p>
        </div>
      )}
    </div>
  )
}
