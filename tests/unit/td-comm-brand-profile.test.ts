import { describe, it, expect } from 'vitest'
import {
  parseProfileResponse,
  hashAnswers,
  hasBriefContent,
  buildProfilePrompt,
} from '@/lib/td-communication/brand-profile'
import type { BriefSection } from '@/lib/td-communication/pipeline'

const sections: BriefSection[] = [
  { title: 'Business & Strategy', fields: [{ label: 'Business', value: 'We sell coffee' }] },
  { title: 'Visual & Design', fields: [{ label: 'Colour', value: 'warm earthy tones' }] },
]

describe('parseProfileResponse', () => {
  const valid = JSON.stringify({
    color_palette: [
      { hex: '#6F4E37', name: 'Coffee brown' },
      { hex: '#D2B48C', name: 'Tan' },
    ],
    personality: 'Warm, artisanal, grounded.',
    geometric_style: 'Soft rounded forms.',
    mood: 'Cozy morning café.',
  })

  it('parses a clean JSON profile', () => {
    const p = parseProfileResponse(valid)
    expect(p).not.toBeNull()
    expect(p!.color_palette).toHaveLength(2)
    expect(p!.personality).toBe('Warm, artisanal, grounded.')
    expect(p!.mood).toBe('Cozy morning café.')
  })

  it('strips a ```json code fence', () => {
    const p = parseProfileResponse('```json\n' + valid + '\n```')
    expect(p).not.toBeNull()
    expect(p!.geometric_style).toBe('Soft rounded forms.')
  })

  it('drops palette entries without a valid 6-digit hex', () => {
    const p = parseProfileResponse(JSON.stringify({
      color_palette: [
        { hex: '#6F4E37', name: 'Coffee' },
        { hex: 'brown', name: 'Nope' },   // not hex → dropped
        { name: 'No hex' },               // missing hex → dropped
      ],
      personality: 'x',
    }))
    expect(p!.color_palette).toEqual([{ hex: '#6f4e37', name: 'Coffee' }])
  })

  it('returns null on malformed JSON', () => {
    expect(parseProfileResponse('not json at all')).toBeNull()
    expect(parseProfileResponse('')).toBeNull()
    expect(parseProfileResponse('{ "color_palette": [ ')).toBeNull()
  })

  it('returns null when the personality summary is missing (minimum viable profile)', () => {
    expect(parseProfileResponse(JSON.stringify({ color_palette: [], mood: 'x' }))).toBeNull()
    expect(parseProfileResponse(JSON.stringify(['an', 'array']))).toBeNull()
  })
})

describe('hashAnswers', () => {
  it('is stable for the same answers', () => {
    expect(hashAnswers(sections)).toBe(hashAnswers(sections))
  })

  it('changes when an answer changes (staleness signal)', () => {
    const changed: BriefSection[] = [
      { title: 'Business & Strategy', fields: [{ label: 'Business', value: 'We sell TEA now' }] },
      { title: 'Visual & Design', fields: [{ label: 'Colour', value: 'warm earthy tones' }] },
    ]
    expect(hashAnswers(changed)).not.toBe(hashAnswers(sections))
  })
})

describe('hasBriefContent', () => {
  it('true when any section has a field, false otherwise', () => {
    expect(hasBriefContent(sections)).toBe(true)
    expect(hasBriefContent([])).toBe(false)
    expect(hasBriefContent([{ title: 'Empty', fields: [] }])).toBe(false)
  })
})

describe('buildProfilePrompt', () => {
  it('asks for strict JSON and includes the brief text', () => {
    const { systemPrompt, userPrompt } = buildProfilePrompt(sections)
    expect(systemPrompt).toContain('color_palette')
    expect(systemPrompt.toLowerCase()).toContain('only valid json')
    expect(userPrompt).toContain('We sell coffee')
  })
})
