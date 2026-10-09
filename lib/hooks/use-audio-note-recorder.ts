'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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
}

interface UseAudioNoteRecorderReturn {
  isRecording: boolean
  startRecording: () => void
  /** Finish and hand back the recording via onRecorded. */
  stopRecording: () => void
  /** Stop and throw the recording away — never calls onRecorded. For "the chat was switched / the
   *  composer was abandoned mid-recording", where finalizing it would attach it to the wrong place. */
  cancelRecording: () => void
  isSupported: boolean
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
  const { onRecorded, onError, preferMp4 } = options

  const [isRecording, setIsRecording] = useState(false)
  const [isSupported, setIsSupported] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const onRecordedRef = useRef(onRecorded)
  const onErrorRef = useRef(onError)
  const preferMp4Ref = useRef(!!preferMp4)
  const cancelledRef = useRef(false)

  useEffect(() => { onRecordedRef.current = onRecorded }, [onRecorded])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { preferMp4Ref.current = !!preferMp4 }, [preferMp4])

  useEffect(() => {
    setIsSupported(
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    )
  }, [])

  const startRecording = useCallback(async () => {
    if (isRecording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
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

      const recorder = new MediaRecorder(stream, { mimeType })
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
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
        // buildOutboundPath (lib/messaging/wabridge-attachment.ts) picks the real extension from the
        // mime type the browser reports — the file NAME here is cosmetic, never used for that decision.
        const ext = mimeType.includes('webm') ? 'webm' : 'm4a'
        const file = new File([audioBlob], `voice-note.${ext}`, { type: mimeType.split(';')[0] })
        onRecordedRef.current?.(file)
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
    return () => {
      cancelledRef.current = true // an unmount (e.g. navigating away) must never fire onRecorded after the composer is gone
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return { isRecording, startRecording, stopRecording, cancelRecording, isSupported }
}
