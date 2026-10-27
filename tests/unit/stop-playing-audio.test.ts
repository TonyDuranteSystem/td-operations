import { describe, it, expect } from 'vitest'
import { stopPlayingAudio } from '@/lib/media/stop-playing-audio'

const player = (paused: boolean) => { const p = { paused, pause() { p.paused = true } }; return p }

describe('stopPlayingAudio', () => {
  it('pauses only the players that are playing', () => {
    const a = player(false), b = player(true), c = player(false)
    const n = stopPlayingAudio(undefined, { querySelectorAll: () => [a, b, c] })
    expect(n).toBe(2)
    expect([a.paused, b.paused, c.paused]).toEqual([true, true, true])
  })
  it('leaves the kept player alone', () => {
    const a = player(false), b = player(false)
    expect(stopPlayingAudio(a, { querySelectorAll: () => [a, b] })).toBe(1)
    expect(a.paused).toBe(false)
    expect(b.paused).toBe(true)
  })
  it('does nothing without a page', () => {
    expect(stopPlayingAudio(undefined, null)).toBe(0)
  })
})
