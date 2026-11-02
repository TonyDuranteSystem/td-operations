import { describe, it, expect } from 'vitest'
import { assessSubstance, staffNames, MIN_VOICE_WORDS, MIN_VOICE_TURNS } from '@/lib/leads/call-substance'

const internal = (e: string) => e.endsWith('@tonydurante.us')
const attendees = [
  { name: 'Antonio Durante', email: 'antonio.durante@tonydurante.us' },
  { name: 'Fireflies.ai Notetaker Tony', email: null },
  { name: 'Pierre L', email: 'pierre@example.com' },
]
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
function lines(speaker: string, turns: number, wordsPerTurn: number) {
  return Array.from({ length: turns }, () => ({ speaker, text: words(wordsPerTurn), timestamp: 1 }))
}

describe('assessSubstance', () => {
  it('a normal sales call (two voices, hundreds of words) is a real conversation', () => {
    const t = [...lines('Antonio Durante - Tony Durante LLC', 48, 26), ...lines('Pierre L', 48, 12)]
    const s = assessSubstance(t, attendees, internal)
    expect(s?.enough).toBe(true)
    expect(s?.reason).toMatch(/Pierre L/)
  })
  it('a mistaken connection with one voice is not', () => {
    const s = assessSubstance(lines('Antonio Durante - Tony Durante LLC', 30, 20), attendees, internal)
    expect(s?.enough).toBe(false)
    expect(s?.reason).toMatch(/Only one voice/)
  })
  it('two team members talking while the lead never came is not', () => {
    const att = [...attendees, { name: 'Luca', email: 'luca@tonydurante.us' }]
    const t = [...lines('Antonio Durante', 20, 20), ...lines('Luca', 20, 20)]
    const s = assessSubstance(t, att, internal)
    expect(s?.enough).toBe(false)
    expect(s?.reason).toMatch(/Only the team/)
  })
  it('a lead who only says hello is not enough', () => {
    const t = [...lines('Antonio Durante', 30, 20), ...lines('Pierre L', 3, 2)]
    expect(assessSubstance(t, attendees, internal)?.enough).toBe(false)
  })
  it('a short real call still passes just above the floors', () => {
    const t = [...lines('Antonio Durante', MIN_VOICE_TURNS, MIN_VOICE_WORDS / MIN_VOICE_TURNS), ...lines('Pierre L', MIN_VOICE_TURNS, MIN_VOICE_WORDS / MIN_VOICE_TURNS)]
    expect(assessSubstance(t, attendees, internal)?.enough).toBe(true)
  })
  it('cannot be judged without a usable transcript', () => {
    expect(assessSubstance(undefined, attendees, internal)).toBeNull()
    expect(assessSubstance([], attendees, internal)).toBeNull()
    expect(assessSubstance('text', attendees, internal)).toBeNull()
    expect(assessSubstance([{ nothing: true }], attendees, internal)).toBeNull()
  })
  it('does not care about the order, spelling or lines without text', () => {
    const t = [{ speaker: 'Pierre L', text: '' }, ...lines('Pierre L', 6, 20), null, ...lines('Antonio Durante', 6, 20)]
    expect(assessSubstance(t as unknown[], attendees, internal)?.enough).toBe(true)
  })
})

describe('staffNames', () => {
  it('keeps internal attendees and the notetaker bot only', () => {
    expect(staffNames(attendees, internal)).toEqual(['antonio durante', 'fireflies ai notetaker tony'])
    expect(staffNames(null, internal)).toEqual([])
  })
})
