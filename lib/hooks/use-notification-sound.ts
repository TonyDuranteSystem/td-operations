"use client"

import { useCallback, useRef } from "react"

// Musical frequencies (equal temperament, A4=440Hz)
// C4=261.6  E4=329.6  G4=392  A4=440
// C5=523.3  E5=659.3  G5=784  A5=880
// C6=1046.5 E6=1318.5

type Tone = {
  freq: number   // Hz
  start: number  // seconds from note onset
  dur: number    // total envelope duration in seconds
  vol?: number   // relative volume (default 1.0)
}

export type Sound = { id: string; label: string; tones: Tone[] }

export const SOUND_NONE = 'none'

export const SOUND_LIBRARY: Sound[] = [
  {
    id: 'chime',
    label: 'Chime',
    // G5 → C6: ascending perfect 4th, like wind chimes
    tones: [{ freq: 784, start: 0, dur: 0.5 }, { freq: 1046.5, start: 0.12, dur: 0.5 }],
  },
  {
    id: 'ping',
    label: 'Ping',
    // Clean single A5 with natural decay
    tones: [{ freq: 880, start: 0, dur: 0.45 }],
  },
  {
    id: 'double',
    label: 'Double',
    // E5 → A5: rising perfect 4th
    tones: [{ freq: 659.3, start: 0, dur: 0.28 }, { freq: 880, start: 0.2, dur: 0.35 }],
  },
  {
    id: 'triple',
    label: 'Triple',
    // C5 → E5 → G5 major arpeggio
    tones: [
      { freq: 523.3, start: 0, dur: 0.22 },
      { freq: 659.3, start: 0.15, dur: 0.22 },
      { freq: 784, start: 0.3, dur: 0.3 },
    ],
  },
  {
    id: 'bubble',
    label: 'Bubble',
    // Fast ascending C5→E5→G5→C6 like bubbles rising
    tones: [
      { freq: 523.3, start: 0, dur: 0.18 },
      { freq: 659.3, start: 0.1, dur: 0.18 },
      { freq: 784, start: 0.2, dur: 0.18 },
      { freq: 1046.5, start: 0.3, dur: 0.25 },
    ],
  },
  {
    id: 'bell',
    label: 'Bell',
    // C5 sustained with soft A5 harmonic (bell-like)
    tones: [
      { freq: 523.3, start: 0, dur: 0.8 },
      { freq: 880, start: 0, dur: 0.4, vol: 0.35 },
    ],
  },
  {
    id: 'soft',
    label: 'Soft',
    // A4 + E5 perfect 5th chord, very gentle
    tones: [
      { freq: 440, start: 0, dur: 0.55 },
      { freq: 659.3, start: 0, dur: 0.55, vol: 0.5 },
    ],
  },
  {
    id: 'ding',
    label: 'Ding',
    // E5 with bright E6 octave — classic doorbell feel
    tones: [
      { freq: 659.3, start: 0, dur: 0.6 },
      { freq: 1318.5, start: 0.02, dur: 0.35, vol: 0.45 },
    ],
  },
  {
    id: 'drop',
    label: 'Drop',
    // A5 → E5 → A4 descending
    tones: [
      { freq: 880, start: 0, dur: 0.22 },
      { freq: 659.3, start: 0.2, dur: 0.25 },
      { freq: 440, start: 0.4, dur: 0.3 },
    ],
  },
  {
    id: 'pop',
    label: 'Pop',
    // Short G5 burst with quick A5 follow — like a notification pop
    tones: [
      { freq: 784, start: 0, dur: 0.12 },
      { freq: 880, start: 0.09, dur: 0.2 },
    ],
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

// Per-tone ADSR: fast linear attack → exponential release
function runTones(ctx: AudioContext, tones: Tone[], masterVol = 0.22, debugId?: string): void {
  console.warn('[SOUND PLAYED]', debugId ?? 'unknown', new Error().stack?.split('\n').slice(1, 4).join(' | '))
  const now = ctx.currentTime

  for (const tone of tones) {
    const t0 = now + tone.start
    const vol = masterVol * (tone.vol ?? 1.0)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.01)           // 10ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur) // exponential release
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(tone.freq, t0)
    osc.connect(gain)
    osc.start(t0)
    osc.stop(t0 + tone.dur + 0.02)
  }
}

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null)

  const getContext = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext()
    return ctxRef.current
  }, [])

  const play = useCallback((soundId: string, debugId?: string) => {
    if (soundId === SOUND_NONE) return
    const sound = SOUND_MAP.get(soundId)
    if (!sound) return
    const ctx = getContext()
    const doPlay = () => runTones(ctx, sound.tones, 0.22, debugId)
    if (ctx.state === 'suspended') { ctx.resume().then(doPlay) } else { doPlay() }
  }, [getContext])

  const previewSound = useCallback((soundId: string) => { play(soundId, 'preview') }, [play])

  const playSound = useCallback(() => { play(SOUND_LIBRARY[0].id, 'playSound') }, [play])

  const playSenderSound = useCallback((senderId: string) => {
    const stored = getSenderSoundId(senderId)
    if (stored === SOUND_NONE) return
    play(stored && SOUND_MAP.has(stored) ? stored : fallbackSoundId(senderId), `playSenderSound:${senderId.slice(0, 8)}`)
  }, [play])

  return { playSound, playSenderSound, previewSound }
}
