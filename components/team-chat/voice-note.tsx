'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { stopPlayingAudio } from '@/lib/media/stop-playing-audio'
import { transcriptLines, type VoiceTranscript } from '@/lib/team/voice-text'
import { useTalkI18n } from '@/components/talk/talk-i18n'

/**
 * A voice note you can play right where it is, with a "Show text" button (dev job c1e326dd). Used by TD Talk and the CRM
 * Team Chat page so both show the same thing. Nothing is sent to the speech service until the button is tapped; the result
 * is saved on the message, so after the first tap both people see the words straight away.
 */
/** Notes already asked about in this browser session — one repair check per note, however often it re-renders. */
const repairAsked = new Set<string>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function VoiceNote({ messageId, index, url, transcript: saved, flat, flattenedAt, tone = 'light', onBroken, eager = false, apiBase = '/api/team/messages' }: {
  messageId: string
  index: number
  url: string
  transcript?: VoiceTranscript | null
  /** Stored as an ordinary MP4 already (recorded that way, or repaired once). Otherwise the server checks it the first time it is opened. */
  flat?: boolean
  flattenedAt?: string | null
  /** The newest voice note of the chat: load the WHOLE file as soon as it is on screen so the tap plays at once. Every other note only reads its first few KB, and only when it is near the screen. */
  eager?: boolean
  /** 'dark' = text sits on a dark bubble. */
  tone?: 'light' | 'dark'
  onBroken?: () => void
  /** Where the repair and "Show text" calls go: `<apiBase>/<message id>/flatten|transcribe`. Team Chat / TD Talk by default; the marketing lead chat passes its own. */
  apiBase?: string
}) {
  const { t } = useTalkI18n()
  const [fetched, setFetched] = useState<VoiceTranscript | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const transcript = saved ?? fetched
  const [repairedAt, setRepairedAt] = useState<string | null>(null)

  // Safari plays the fragmented MP4 an older note may be stored as badly (cut short / double length). The first time such a note is
  // opened the server converts it in place (keeping the original) and marks it; after that nobody asks again.
  useEffect(() => {
    const key = `${messageId}:${index}`
    if (flat || repairAsked.has(key) || !UUID.test(messageId)) return
    repairAsked.add(key)
    fetch(`${apiBase}/${messageId}/flatten`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }),
    }).then(r => r.json()).then(d => { if (d?.ok && d.flattened_at) setRepairedAt(d.flattened_at as string) }).catch(() => {})
  }, [messageId, index, flat, apiBase])
  // a new address after the repair makes the browser load the corrected file instead of its cached copy
  const latest = repairedAt ?? flattenedAt ?? null
  // the corrected address is only swapped in while the note is idle: swapping it mid-play (or right as someone taps play)
  // reloads the whole file, which is the "delay" after the first tap on an older note
  const audioRef = useRef<HTMLAudioElement>(null)
  const [stamp, setStamp] = useState<string | null>(flattenedAt ?? null)
  const [near, setNear] = useState(false)
  const swapIfIdle = useCallback(() => {
    const a = audioRef.current
    if (!a || a.ended || (a.paused && a.currentTime === 0)) setStamp(cur => cur === latest ? cur : latest)
  }, [latest])
  useEffect(() => { if (latest !== stamp) swapIfIdle() }, [latest, stamp, swapIfIdle])
  // Nothing is fetched for a note far off screen (a chat can hold hundreds). Near the screen it reads only its first few KB
  // (length + play button); the whole file is fetched ahead of time only for the NEWEST note, otherwise on tap.
  useEffect(() => {
    const el = audioRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setNear(true); io.disconnect() } }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const src = stamp ? `${url}?v=${encodeURIComponent(stamp)}` : url

  const show = async () => {
    setError(null)
    if (transcript) { setOpen(o => !o); return }
    setBusy(true)
    try {
      const r = await fetch(`${apiBase}/${messageId}/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || 'Could not turn this voice note into text. Please try again.'))
      setFetched(d.transcript as VoiceTranscript)
      setOpen(true)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('Could not turn this voice note into text. Please try again.'))
    } finally { setBusy(false) }
  }

  const muted = tone === 'dark' ? 'text-white/70' : 'text-zinc-500'
  return (
    <div className="flex flex-col gap-1" data-testid="voice-note">
      <audio
        ref={audioRef} controls preload={near ? (eager ? 'auto' : 'metadata') : 'none'} src={src} className="h-10 w-60 max-w-full" onError={onBroken}
        onPlay={e => stopPlayingAudio(e.currentTarget)} onEnded={swapIfIdle} data-testid="talk-voice-note"
      />
      <button
        type="button"
        onClick={show}
        disabled={busy}
        data-testid="voice-show-text"
        className={`flex items-center gap-1 self-start text-xs underline ${muted}`}
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
        {busy ? t('Reading the voice note…') : transcript && open ? t('Hide text') : t('Show text')}
      </button>
      {error && <p className="text-xs text-red-600" data-testid="voice-text-error">{error}</p>}
      {transcript && open && (
        <div className={`rounded-lg px-2 py-1.5 text-sm ${tone === 'dark' ? 'bg-white/10' : 'bg-zinc-100'}`} data-testid="voice-text">
          {transcriptLines(transcript).map(l => (
            <p key={l.label} className="whitespace-pre-wrap break-words"><span className={`text-[10px] uppercase tracking-wide ${muted}`}>{t(l.label)}</span><br />{l.text}</p>
          ))}
          <p className={`mt-1 text-[10px] ${muted}`}>{t('Machine text — it can be wrong.')}</p>
        </div>
      )}
    </div>
  )
}
