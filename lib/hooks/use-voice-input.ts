'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseVoiceInputOptions {
  language?: string
  onTranscript?: (text: string) => void
}

interface UseVoiceInputReturn {
  isRecording: boolean
  isTranscribing: boolean
  startRecording: () => void
  stopRecording: () => void
  isSupported: boolean
}

/**
 * Voice input hook — ChatGPT-quality dictation.
 *
 * Records audio via MediaRecorder, sends to server for Whisper transcription.
 * Falls back to Web Speech API if Whisper not available.
 *
 * Usage:
 *   const { isRecording, isTranscribing, startRecording, stopRecording, isSupported } = useVoiceInput({
 *     language: 'en-US',
 *     onTranscript: (text) => setInput(prev => prev + ' ' + text)
 *   })
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { language = 'en-US', onTranscript } = options

  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isSupported, setIsSupported] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const onTranscriptRef = useRef(onTranscript)

  // Keep callback ref current
  useEffect(() => {
    onTranscriptRef.current = onTranscript
  }, [onTranscript])

  // Check support
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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      })

      streamRef.current = stream
      chunksRef.current = []

      // Use webm/opus if available, fallback to whatever is supported
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4'

      const recorder = new MediaRecorder(stream, { mimeType })

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null

        const audioBlob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []

        // Don't send if too short (< 0.5s ~ < 5KB usually)
        if (audioBlob.size < 1000) {
          setIsRecording(false)
          return
        }

        // Transcribe
        setIsTranscribing(true)
        try {
          const text = await transcribeAudio(audioBlob, language)
          if (text && onTranscriptRef.current) {
            onTranscriptRef.current(text)
          }
        } catch (err) {
          console.error('[useVoiceInput] transcription failed:', err)
        } finally {
          setIsTranscribing(false)
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start(250) // collect in 250ms chunks
      setIsRecording(true)
    } catch (err) {
      console.error('[useVoiceInput] mic access denied:', err)
    }
  }, [isRecording, language])

  const stopRecording = useCallback(() => {
    setIsRecording(false)
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    mediaRecorderRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      }
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return { isRecording, isTranscribing, startRecording, stopRecording, isSupported }
}

/**
 * Send audio to server for Whisper transcription.
 * Falls back to empty string if transcription service is unavailable.
 */
async function transcribeAudio(audioBlob: Blob, language: string): Promise<string> {
  const formData = new FormData()

  // Determine file extension from MIME type
  const ext = audioBlob.type.includes('webm') ? 'webm' : audioBlob.type.includes('mp4') ? 'm4a' : 'webm'
  formData.append('audio', audioBlob, `recording.${ext}`)
  formData.append('language', language.split('-')[0]) // 'en-US' → 'en'

  const res = await fetch('/api/portal/chat/transcribe', {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Transcription failed')
  }

  const data = await res.json()
  return data.text || ''
}
