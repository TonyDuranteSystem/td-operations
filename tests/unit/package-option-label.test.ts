import { describe, it, expect } from 'vitest'
import { formatOptionLabel } from '@/lib/offers/package-option-label'

describe('formatOptionLabel', () => {
  it('combines state and entity type as "State — Entity Type"', () => {
    expect(formatOptionLabel('MMLLC', 'FL')).toBe('Florida — Multi-Member LLC')
    expect(formatOptionLabel('SMLLC', 'WY')).toBe('Wyoming — Single-Member LLC')
    expect(formatOptionLabel('Corp', 'DE')).toBe('Delaware — C-Corp')
  })

  it('falls back to just the state when entity type is not picked yet', () => {
    expect(formatOptionLabel('', 'FL')).toBe('Florida')
    expect(formatOptionLabel(undefined, 'NM')).toBe('New Mexico')
  })

  it('falls back to just the entity type when state is not picked yet', () => {
    expect(formatOptionLabel('MMLLC', '')).toBe('Multi-Member LLC')
    expect(formatOptionLabel('SMLLC', undefined)).toBe('Single-Member LLC')
  })

  it('is empty when neither is picked yet', () => {
    expect(formatOptionLabel('', '')).toBe('')
    expect(formatOptionLabel(undefined, undefined)).toBe('')
  })
})
