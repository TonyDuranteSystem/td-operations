"use client"

import { useCallback, useEffect, useRef, useState } from "react"

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionErrorEvent {
  error: string
  message?: string
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionConstructor | null
}

interface UseSpeechToTextOptions {
  language?: string
}

interface UseSpeechToTextReturn {
  isListening: boolean
  transcript: string
  startListening: () => void
  stopListening: () => void
  isSupported: boolean
}

export function useSpeechToText(
  options: UseSpeechToTextOptions = {}
): UseSpeechToTextReturn {
  const { language = "en-US" } = options

  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [isSupported, setIsSupported] = useState(false)

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const isListeningRef = useRef(false)
  const shouldRestartRef = useRef(false)

  // Keep ref in sync with state so callbacks always see latest value
  useEffect(() => {
    isListeningRef.current = isListening
  }, [isListening])

  // Check browser support on mount
  useEffect(() => {
    setIsSupported(getSpeechRecognition() !== null)
  }, [])

  // Create / teardown recognition instance when language changes
  useEffect(() => {
    const SpeechRec = getSpeechRecognition()
    if (!SpeechRec) return

    const recognition = new SpeechRec()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = language

    let finalTranscript = ""

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalTranscript += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      setTranscript(finalTranscript + interim)
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "aborted" fires when we call stop() — not a real error
      if (event.error === "aborted" || event.error === "no-speech") return
      console.warn("[useSpeechToText] error:", event.error, event.message)
      // On fatal errors, stop listening
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldRestartRef.current = false
        setIsListening(false)
      }
    }

    recognition.onend = () => {
      // Auto-restart if the user hasn't explicitly stopped
      if (shouldRestartRef.current && isListeningRef.current) {
        try {
          recognition.start()
        } catch {
          // start() can throw if called too quickly; retry once
          setTimeout(() => {
            try {
              if (shouldRestartRef.current && isListeningRef.current) {
                recognition.start()
              }
            } catch {
              setIsListening(false)
              shouldRestartRef.current = false
            }
          }, 200)
        }
        return
      }
      setIsListening(false)
    }

    recognitionRef.current = recognition

    return () => {
      shouldRestartRef.current = false
      try {
        recognition.abort()
      } catch {
        // ignore — may already be stopped
      }
      recognitionRef.current = null
    }
  }, [language])

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition) return

    setTranscript("")
    shouldRestartRef.current = true
    setIsListening(true)

    try {
      recognition.start()
    } catch {
      // If already started, stop first then restart
      try {
        recognition.stop()
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          recognition.start()
        } catch {
          setIsListening(false)
          shouldRestartRef.current = false
        }
      }, 100)
    }
  }, [])

  const stopListening = useCallback(() => {
    shouldRestartRef.current = false
    setIsListening(false)
    const recognition = recognitionRef.current
    if (!recognition) return
    try {
      recognition.stop()
    } catch {
      // ignore
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false
      const recognition = recognitionRef.current
      if (recognition) {
        try {
          recognition.abort()
        } catch {
          // ignore
        }
      }
    }
  }, [])

  return { isListening, transcript, startListening, stopListening, isSupported }
}
