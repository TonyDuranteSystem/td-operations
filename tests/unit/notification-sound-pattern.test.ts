import { describe, it, expect } from 'vitest'
import { SOUND_LIBRARY, SOUND_NONE } from '@/lib/hooks/use-notification-sound'

describe('SOUND_LIBRARY', () => {
  it('has at least 5 sounds', () => {
    expect(SOUND_LIBRARY.length).toBeGreaterThanOrEqual(5)
  })

  it('every sound has an id, label, and at least one tone', () => {
    for (const s of SOUND_LIBRARY) {
      expect(s.id).toBeTruthy()
      expect(s.label).toBeTruthy()
      expect(s.tones.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('every tone has a positive frequency and duration', () => {
    for (const s of SOUND_LIBRARY) {
      for (const t of s.tones) {
        expect(t.freq).toBeGreaterThan(0)
        expect(t.dur).toBeGreaterThan(0)
        expect(t.start).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('all ids are unique', () => {
    const ids = SOUND_LIBRARY.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('SOUND_NONE is not an id in SOUND_LIBRARY', () => {
    expect(SOUND_LIBRARY.every(s => s.id !== SOUND_NONE)).toBe(true)
  })
})
