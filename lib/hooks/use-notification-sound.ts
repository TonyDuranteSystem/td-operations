"use client"

import { useCallback, useRef } from "react"

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null)

  const getContext = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext()
    }
    return ctxRef.current
  }, [])

  const playSound = useCallback(() => {
    const ctx = getContext()

    // Resume if suspended (browser autoplay policy)
    const play = () => {
      const now = ctx.currentTime

      // Shared gain node
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.3, now)
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35)
      gain.connect(ctx.destination)

      // First tone: 800Hz for 100ms
      const osc1 = ctx.createOscillator()
      osc1.type = "sine"
      osc1.frequency.setValueAtTime(800, now)
      osc1.connect(gain)
      osc1.start(now)
      osc1.stop(now + 0.1)

      // Second tone: 1000Hz for 150ms, starts after first
      const osc2 = ctx.createOscillator()
      osc2.type = "sine"
      osc2.frequency.setValueAtTime(1000, now + 0.1)
      osc2.connect(gain)
      osc2.start(now + 0.1)
      osc2.stop(now + 0.25)
    }

    if (ctx.state === "suspended") {
      ctx.resume().then(play)
    } else {
      play()
    }
  }, [getContext])

  return { playSound }
}
