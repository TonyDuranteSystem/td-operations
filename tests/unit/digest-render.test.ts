import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TYPE_LABELS,
  mergeTypeLabels,
  buildDigestSections,
} from '@/lib/portal/digest-render'

describe('mergeTypeLabels', () => {
  it('returns code defaults when no overrides exist', () => {
    const merged = mergeTypeLabels(undefined)
    expect(merged.chat).toEqual(DEFAULT_TYPE_LABELS.chat)
    expect(merged.new_document?.show_body).toBe(true)
  })

  it('merges per-type overrides over defaults (partial override keeps the rest)', () => {
    const merged = mergeTypeLabels({ document: { label_en: 'Files' } })
    expect(merged.document.label_en).toBe('Files')
    expect(merged.document.label_it).toBe(DEFAULT_TYPE_LABELS.document.label_it)
    expect(merged.document.show_body).toBe(true)
  })

  it('accepts brand-new types from overrides', () => {
    const merged = mergeTypeLabels({ wire_received: { label_en: 'Wires', icon: 'W' } })
    expect(merged.wire_received.label_en).toBe('Wires')
  })

  it('ignores malformed override shapes instead of crashing', () => {
    expect(mergeTypeLabels('garbage').chat).toEqual(DEFAULT_TYPE_LABELS.chat)
    expect(mergeTypeLabels([1, 2]).chat).toEqual(DEFAULT_TYPE_LABELS.chat)
    expect(mergeTypeLabels({ chat: 'nope' }).chat).toEqual(DEFAULT_TYPE_LABELS.chat)
  })
})

describe('buildDigestSections', () => {
  const labels = mergeTypeLabels(undefined)

  it('groups by type and renders one section per type', () => {
    const sections = buildDigestSections(
      [
        { type: 'chat', title: 'New message from Tony Durante Team' },
        { type: 'document', title: 'New document available', body: 'Forms 1120.pdf' },
        { type: 'chat', title: 'New message from Tony Durante Team' },
      ],
      labels,
      false
    )
    expect(sections).toHaveLength(2)
    expect(sections[0]).toContain('Messages (2)')
    expect(sections[1]).toContain('Documents (1)')
  })

  it('renders the file name under document items (show_body)', () => {
    const [section] = buildDigestSections(
      [{ type: 'new_document', title: 'New document available', body: 'Tax_Data_LLC.pdf has been added to your portal.' }],
      labels,
      false
    )
    expect(section).toContain('New document available')
    expect(section).toContain('Tax_Data_LLC.pdf')
  })

  it('does NOT render bodies for types without show_body (chat stays title-only)', () => {
    const [section] = buildDigestSections(
      [{ type: 'chat', title: 'New message', body: 'private message preview' }],
      labels,
      false
    )
    expect(section).not.toContain('private message preview')
  })

  it('uses Italian labels when isItalian', () => {
    const [section] = buildDigestSections(
      [{ type: 'document', title: 'New document available', body: 'x.pdf' }],
      labels,
      true
    )
    expect(section).toContain('Documenti (1)')
  })

  it('falls back to the raw type name for unknown types', () => {
    const [section] = buildDigestSections([{ type: 'mystery', title: 'T' }], labels, false)
    expect(section).toContain('mystery (1)')
  })

  it('escapes HTML in titles and bodies', () => {
    const [section] = buildDigestSections(
      [{ type: 'document', title: '<b>x</b>', body: 'a<script>.pdf' }],
      labels,
      false
    )
    expect(section).not.toContain('<b>x</b>')
    expect(section).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(section).toContain('a&lt;script&gt;.pdf')
  })

  it('skips the body line when it duplicates the title', () => {
    const [section] = buildDigestSections(
      [{ type: 'document', title: 'Same.pdf', body: 'Same.pdf' }],
      labels,
      false
    )
    expect(section.match(/Same\.pdf/g)).toHaveLength(1)
  })
})
