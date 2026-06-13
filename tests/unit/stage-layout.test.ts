import { describe, it, expect } from 'vitest'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { daysSince } from '@/lib/flows/workspace-format'

describe('parseStageLayout', () => {
  it('parses a real layout with mixed components', () => {
    const layout = parseStageLayout({
      components: [
        { type: 'info_panel' },
        { type: 'document_upload', label: 'Upload Extension Receipt' },
        { type: 'action_buttons', actions: ['start_review'] },
      ],
      description: 'File the extension',
    })
    expect(layout).not.toBeNull()
    expect(layout!.components).toHaveLength(3)
    expect(layout!.components[1]).toEqual({ type: 'document_upload', label: 'Upload Extension Receipt', url: undefined, actions: undefined })
    expect(layout!.components[2].actions).toEqual(['start_review'])
    expect(layout!.description).toBe('File the extension')
  })

  it('drops unknown component types but keeps valid ones', () => {
    const layout = parseStageLayout({ components: [{ type: 'info_panel' }, { type: 'bogus_widget' }] })
    expect(layout!.components.map((c) => c.type)).toEqual(['info_panel'])
  })

  it('returns null for non-layout values', () => {
    expect(parseStageLayout(null)).toBeNull()
    expect(parseStageLayout(undefined)).toBeNull()
    expect(parseStageLayout('string')).toBeNull()
    expect(parseStageLayout({ description: 'no components' })).toBeNull()
  })

  it('coerces a layout with empty components to an empty array (graceful)', () => {
    const layout = parseStageLayout({ components: [] })
    expect(layout).not.toBeNull()
    expect(layout!.components).toEqual([])
  })
})

describe('daysSince', () => {
  const now = new Date('2026-06-14T12:00:00Z')
  it('counts whole days, clamped at 0', () => {
    expect(daysSince('2026-06-14T00:00:00Z', now)).toBe(0)
    expect(daysSince('2026-06-12T12:00:00Z', now)).toBe(2)
    expect(daysSince('2099-01-01T00:00:00Z', now)).toBe(0) // future → clamped
  })
  it('returns null for missing/invalid', () => {
    expect(daysSince(null, now)).toBeNull()
    expect(daysSince(undefined, now)).toBeNull()
    expect(daysSince('not-a-date', now)).toBeNull()
  })
})
