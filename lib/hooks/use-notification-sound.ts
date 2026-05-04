"use client"

import { useCallback, useRef } from "react"

type Tone = { freq: number; start: number; dur: number }

export type Sound = { id: string; label: string; tones: Tone[] }

export const SOUND_NONE = 'none'

export const SOUND_LIBRARY: Sound[] = [
  {
    id: 'chime',
    label: 'Chime',
    tones: [{ freq: 880, start: 0, dur: 0.12 }, { freq: 1100, start: 0.15, dur: 0.18 }],
  },
  {
    id: 'ping',
    label: 'Ping',
    tones: [{ freq: 1200, start: 0, dur: 0.15 }],
  },
  {
    id: 'double',
    label: 'Double',
    tones: [{ freq: 900, start: 0, dur: 0.08 }, { freq: 1100, start: 0.12, dur: 0.1 }],
  },
  {
    id: 'bubble',
    label: 'Bubble',
    tones: [{ freq: 600, start: 0, dur: 0.05 }, { freq: 900, start: 0.05, dur: 0.08 }, { freq: 1200, start: 0.13, dur: 0.07 }],
  },
  {
    id: 'bell',
    label: 'Bell',
    tones: [{ freq: 523, start: 0, dur: 0.35 }],
  },
  {
    id: 'pop',
    label: 'Pop',
    tones: [{ freq: 400, start: 0, dur: 0.04 }, { freq: 800, start: 0.05, dur: 0.06 }],
  },
  {
    id: 'drop',
    label: 'Drop',
    tones: [{ freq: 1100, start: 0, dur: 0.08 }, { freq: 800, start: 0.1, dur: 0.1 }, { freq: 500, start: 0.22, dur: 0.12 }],
  },
  {
    id: 'triple',
    label: 'Triple',
    tones: [{ freq: 700, start: 0, dur: 0.06 }, { freq: 700, start: 0.1, dur: 0.06 }, { freq: 1000, start: 0.2, dur: 0.08 }],
  },
  {
    id: 'ding',
    label: 'Ding',
    tones: [{ freq: 660, start: 0, dur: 0.18 }, { freq: 1320, start: 0.2, dur: 0.12 }],
  },
  {
    id: 'soft',
    label: 'Soft',
    tones: [{ freq: 440, start: 0, dur: 0.22 }, { freq: 550, start: 0.25, dur: 0.15 }],
  },
]

const SOUND_MAP = new Map(SOUND_LIBRARY.map(s => [s.id, s]))

function hashSenderId(senderId: string): number {
  let h = 0
  for (let i = 0; i < senderId.length; i++) {
    h = (h << 5) - h + senderId.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

function fallbackSoundId(senderId: string): string {
  return SOUND_LIBRARY[hashSenderId(senderId) % SOUND_LIBRARY.length].id
}

export function getSenderSoundId(senderId: string): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(`tc-sound-${senderId}`)
}

export function setSenderSoundId(senderId: string, soundId: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(`tc-sound-${senderId}`, soundId)
}

function runTones(ctx: AudioContext, tones: Tone[], volume = 0.3): void {
  const now = ctx.currentTime
  const totalDur = Math.max(...tones.map(t => t.start + t.dur)) + 0.05
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(volume, now)
  gain.gain.exponentialRampToValueAtTime(0.01, now + totalDur)
  gain.connect(ctx.destination)
  for (const tone of tones) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(tone.freq, now + tone.start)
    osc.connect(gain)
    osc.start(now + tone.start)
    osc.stop(now + tone.start + tone.dur)
  }
}

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null)

  const getContext = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext()
    return ctxRef.current
  }, [])

  const play = useCallback((soundId: string) => {
    if (soundId === SOUND_NONE) return
    const sound = SOUND_MAP.get(soundId)
    if (!sound) return
    const ctx = getContext()
    const doPlay = () => runTones(ctx, sound.tones)
    if (ctx.state === 'suspended') { ctx.resume().then(doPlay) } else { doPlay() }
  }, [getContext])

  const previewSound = useCallback((soundId: string) => {
    play(soundId)
  }, [play])

  const playSound = useCallback(() => {
    play(SOUND_LIBRARY[0].id)
  }, [play])

  const playSenderSound = useCallback((senderId: string) => {
    const stored = getSenderSoundId(senderId)
    if (stored === SOUND_NONE) return
    play(stored && SOUND_MAP.has(stored) ? stored : fallbackSoundId(senderId))
  }, [play])

  return { playSound, playSenderSound, previewSound }
}
