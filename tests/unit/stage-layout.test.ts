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

  it('carries the document_upload folder + rename fields through the parser', () => {
    // Whitelist guard: parseStageLayout rebuilds each component from a fixed key
    // set, so any field it does not explicitly read is dropped. The EIN-letter
    // filing policy (folder + rename) MUST survive DB → renderer.
    const layout = parseStageLayout({
      components: [
        {
          type: 'document_upload',
          label: 'Upload EIN Letter (CP 575)',
          folder: '1. Company',
          rename: 'EIN Official – {company_name}',
        },
      ],
    })
    expect(layout!.components[0]).toMatchObject({
      type: 'document_upload',
      folder: '1. Company',
      rename: 'EIN Official – {company_name}',
    })
  })

  it('leaves folder/rename undefined when absent (no regression to other uploads)', () => {
    const layout = parseStageLayout({ components: [{ type: 'document_upload', label: 'Upload Articles' }] })
    expect(layout!.components[0].folder).toBeUndefined()
    expect(layout!.components[0].rename).toBeUndefined()
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

  it('parses an advance_next object action with label + target', () => {
    const layout = parseStageLayout({
      components: [
        { type: 'action_buttons', actions: [{ key: 'advance_next', label: 'Open Wizard for Client', target: 'Wizard Available' }] },
      ],
    })
    expect(layout!.components[0].actions).toEqual([
      { key: 'advance_next', label: 'Open Wizard for Client', target: 'Wizard Available' },
    ])
  })

  it('keeps mixed string + object actions and drops object actions with no string key', () => {
    const layout = parseStageLayout({
      components: [
        { type: 'action_buttons', actions: ['approve', { key: 'advance_next', target: 'X' }, { label: 'no key' }, 42] },
      ],
    })
    expect(layout!.components[0].actions).toEqual(['approve', { key: 'advance_next', target: 'X' }])
  })

  it('parses the waiting_notice component type with its label', () => {
    const layout = parseStageLayout({
      components: [{ type: 'waiting_notice', label: 'Waiting for the client to submit data.' }],
    })
    expect(layout!.components[0]).toMatchObject({ type: 'waiting_notice', label: 'Waiting for the client to submit data.' })
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
