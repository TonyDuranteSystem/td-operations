"use client"

import { useCallback, useRef } from "react"

type Tone = { freq: number; start: number; dur: number }

// 5 distinct sound patterns — one per sender slot (deterministic)
const PATTERNS: Tone[][] = [
  // 0: rising two-tone (default)
  [{ freq: 800, start: 0, dur: 0.1 }, { freq: 1000, start: 0.1, dur: 0.15 }],
  // 1: low→high
  [{ freq: 500, start: 0, dur: 0.12 }, { freq: 900, start: 0.12, dur: 0.15 }],
  // 2: three quick pings
  [{ freq: 700, start: 0, dur: 0.07 }, { freq: 700, start: 0.12, dur: 0.07 }, { freq: 900, start: 0.24, dur: 0.1 }],
  // 3: descending
  [{ freq: 1100, start: 0, dur: 0.08 }, { freq: 800, start: 0.1, dur: 0.1 }, { freq: 550, start: 0.22, dur: 0.12 }],
  // 4: soft chime
  [{ freq: 660, start: 0, dur: 0.15 }, { freq: 1100, start: 0.18, dur: 0.12 }],
]

function hashSenderId(senderId: string): number {
  let h = 0
  for (let i = 0; i < senderId.length; i++) {
    h = (h << 5) - h + senderId.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

export function senderPatternIndex(senderId: string): number {
  return hashSenderId(senderId) % PATTERNS.length
}

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null)

  const getContext = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext()
    }
    return ctxRef.current
  }, [])

  const playTones = useCallback((tones: Tone[], volume = 0.3) => {
    const ctx = getContext()

    const play = () => {
      const now = ctx.currentTime
      const totalDur = Math.max(...tones.map(t => t.start + t.dur)) + 0.05

      const gain = ctx.createGain()
      gain.gain.setValueAtTime(volume, now)
      gain.gain.exponentialRampToValueAtTime(0.01, now + totalDur)
      gain.connect(ctx.destination)

      for (const tone of tones) {
        const osc = ctx.createOscillator()
        osc.type = "sine"
        osc.frequency.setValueAtTime(tone.freq, now + tone.start)
        osc.connect(gain)
        osc.start(now + tone.start)
        osc.stop(now + tone.start + tone.dur)
      }
    }

    if (ctx.state === "suspended") {
      ctx.resume().then(play)
    } else {
      play()
    }
  }, [getContext])

  // Default sound (pattern 0) — for portal client messages
  const playSound = useCallback(() => {
    playTones(PATTERNS[0])
  }, [playTones])

  // Per-sender sound — deterministic from sender_id
  const playSenderSound = useCallback((senderId: string) => {
    const idx = senderPatternIndex(senderId)
    playTones(PATTERNS[idx])
  }, [playTones])

  return { playSound, playSenderSound }
}
