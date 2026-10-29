'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fragmentedMp4ToFlat } from '@/lib/media/fmp4-to-flat'
import { stopPlayingAudio } from '@/lib/media/stop-playing-audio'
import { isSound, rmsOf } from '@/lib/media/sound-level'

/** Starts listening to a microphone stream; `stop()` releases it. Returns null when the browser cannot measure (the recording then goes out as before). */
function listen(stream: MediaStream, onLevel: (level: number) => void): { stop: () => void } | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    void ctx.resume().catch(() => {})
    const timer = setInterval(() => { analyser.getFloatTimeDomainData(buf); onLevel(rmsOf(buf)) }, 100)
    return { stop: () => { clearInterval(timer); try { source.disconnect() } catch { /* already gone */ } void ctx.close().catch(() => {}) } }
  } catch { return null }
}

interface UseAudioNoteRecorderOptions {
  /** Called with the finished recording, ready to attach and send like any other file. */
  onRecorded?: (file: File) => void
  onError?: (message: string) => void
  /**
   * Prefer MP4/AAC (.m4a) over WebM when the browser can record it. TD Talk (dev job c1e326dd) sets this: an iPhone
   * cannot PLAY a WebM voice note, so a note recorded on Android/desktop in WebM would be silent on the other
   * person's iPhone. iPhone Safari and Chrome 126+ record MP4. Off by default — the WhatsApp composer is unchanged.
   */
  preferMp4?: boolean
  /**
   * Listen to the microphone while recording (TD Marketing sets this): `level` is the live loudness, `heardSound` turns true at the first sound, and a recording in which the
   * microphone never heard anything is NOT handed to `onRecorded` (the person is told instead). If the level cannot be measured the recording is sent as before.
   */
  watchSound?: boolean
}

/** Speech needs far less than the ~190 kbps an iPhone records by default: 48 kbps mono is clear for voice and a 3-minute note drops from ~4.7 MB to ~1 MB (faster upload, less to download). TD Talk only. */
const VOICE_BITS_PER_SECOND = 48_000

interface UseAudioNoteRecorderReturn {
  isRecording: boolean
  startRecording: () => void
  /** Finish and hand back the recording via onRecorded. */
  stopRecording: () => void
  /** Stop and throw the recording away — never calls onRecorded. For "the chat was switched / the
   *  composer was abandoned mid-recording", where finalizing it would attach it to the wrong place. */
  cancelRecording: () => void
  isSupported: boolean
  /** Only with `watchSound`: the live loudness (0..1) and whether any sound has been heard yet in this recording. */
  level: number
  heardSound: boolean
}

/**
 * Records an actual voice note to attach and send — NOT dictation (see lib/hooks/use-voice-input.ts for that,
 * which transcribes speech into typed text). This hook's whole job is to hand back a real audio FILE that goes
 * through the exact same attachment path as a picked file (upload → wabridge_enqueue_send → sent as a real
 * WhatsApp voice note), so the recording IS the message, word for word what the person actually said.
 *
 * Shares the MediaRecorder setup with use-voice-input.ts (same constraints, same codec preference) but stops
 * there — no transcription call, no text callback.
 */
export function useAudioNoteRecorder(options: UseAudioNoteRecorderOptions = {}): UseAudioNoteRecorderReturn {
  const { onRecorded, onError, preferMp4, watchSound } = options

  const [isRecording, setIsRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [heardSound, setHeardSound] = useState(false)
  const watchSoundRef = useRef(!!watchSound)
  const listenerRef = useRef<{ stop: () => void } | null>(null)
  const peakRef = useRef(0)
  const [isSupported, setIsSupported] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const onRecordedRef = useRef(onRecorded)
  const onErrorRef = useRef(onError)
  const preferMp4Ref = useRef(!!preferMp4)
  const cancelledRef = useRef(false)
  const startingRef = useRef(false)
  const unmountedRef = useRef(false)

  useEffect(() => { onRecordedRef.current = onRecorded }, [onRecorded])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { preferMp4Ref.current = !!preferMp4 }, [preferMp4])
  useEffect(() => { watchSoundRef.current = !!watchSound }, [watchSound])

  useEffect(() => {
    setIsSupported(
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    )
  }, [])

  const startRecording = useCallback(async () => {
    // startingRef: a second tap while the microphone permission prompt is still open must not start a second recorder
    if (isRecording || startingRef.current) return
    startingRef.current = true
    try {
      // a voice note that is playing must stop first: on an iPhone the microphone comes back empty while sound plays
      stopPlayingAudio()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      if (unmountedRef.current) {
        // the screen went away while the permission prompt was open — release the microphone, record nothing
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      chunksRef.current = []

      const mp4Wanted = preferMp4Ref.current
        && (MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2') || MediaRecorder.isTypeSupported('audio/mp4'))
      const mimeType = mp4Wanted
        ? (MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2') ? 'audio/mp4;codecs=mp4a.40.2' : 'audio/mp4')
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : 'audio/mp4'

      const recorder = new MediaRecorder(stream, mp4Wanted ? { mimeType, audioBitsPerSecond: VOICE_BITS_PER_SECOND } : { mimeType })
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      // listening (TD Marketing): the loudest moment of the recording decides whether the microphone heard anything at all
      peakRef.current = 0
      setLevel(0)
      setHeardSound(false)
      const meter = watchSoundRef.current
        ? listen(stream, l => { if (l > peakRef.current) peakRef.current = l; setLevel(l); if (isSound(l)) setHeardSound(true) })
        : null
      listenerRef.current = meter

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        meter?.stop()
        listenerRef.current = null
        setLevel(0)
        const silent = meter !== null && !isSound(peakRef.current)
        const audioBlob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        setIsRecording(false)

        if (cancelledRef.current) {
          cancelledRef.current = false
          return
        }
        if (audioBlob.size < 1000) {
          onErrorRef.current?.('Recording too short — hold the mic button a bit longer.')
          return
        }
        if (silent) {
          onErrorRef.current?.('No sound was captured, so nothing was sent. Check that the right microphone is selected and not muted, then record again.')
          return
        }
        // buildOutboundPath (lib/messaging/wabridge-attachment.ts) picks the real extension from the
        // mime type the browser reports — the file NAME here is cosmetic, never used for that decision.
        const ext = mimeType.includes('webm') ? 'webm' : 'm4a'
        const finish = (blob: Blob) => onRecordedRef.current?.(new File([blob], `voice-note.${ext}`, { type: mimeType.split(';')[0] }))
        if (!mp4Wanted) { finish(audioBlob); return }
        // TD Talk: turn the fragmented MP4 into an ordinary one before it uploads (lib/media/fmp4-to-flat.ts). Safari plays the
        // fragmented kind badly — a note could be cut short, and our earlier "fill in the length" patch made Safari report DOUBLE
        // the length (a 43 s note showed 1:26 and stopped halfway). A normal MP4 is read exactly right. Same audio bytes, nothing
        // re-encoded. Fail-safe: any problem sends the original recording unchanged.
        void audioBlob.arrayBuffer().then(buf => {
          const flat = fragmentedMp4ToFlat(new Uint8Array(buf))
          finish(flat ? new Blob([flat.data as BlobPart], { type: audioBlob.type }) : audioBlob)
        }).catch(() => finish(audioBlob))
      }

      mediaRecorderRef.current = recorder
      recorder.start(250)
      setIsRecording(true)
    } catch (err) {
      console.error('[useAudioNoteRecorder] mic access failed:', err)
      const msg = err instanceof Error && /denied|permission/i.test(err.message || err.name)
        ? 'Microphone access denied. Check your browser permissions and try again.'
        : 'Could not start recording. Check your microphone connection and browser permissions.'
      onErrorRef.current?.(msg)
    } finally {
      startingRef.current = false
    }
  }, [isRecording])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    mediaRecorderRef.current = null
  }, [])

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    mediaRecorderRef.current = null
  }, [])

  useEffect(() => {
    // Reset on every mount: React Strict Mode (dev) runs mount → cleanup → mount, and the cleanup below leaves this
    // flag true — which silently swallowed the FIRST recording after the page loaded (found 2026-10-09 in TD Talk).
    cancelledRef.current = false
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      cancelledRef.current = true // an unmount (e.g. navigating away) must never fire onRecorded after the composer is gone
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      listenerRef.current?.stop()
    }
  }, [])

  return { isRecording, startRecording, stopRecording, cancelRecording, isSupported, level, heardSound }
}
