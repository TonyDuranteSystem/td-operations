import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TYPE_LABELS,
  mergeTypeLabels,
  buildDigestSections,
  pickDigestButtonHref,
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

describe('pickDigestButtonHref', () => {
  const BASE = 'https://portal.tonydurante.us'
  const HOME = `${BASE}/portal`

  it('goes straight to the one shared destination', () => {
    expect(pickDigestButtonHref(['/portal/sign', '/portal/sign'], BASE)).toBe(`${BASE}/portal/sign`)
    expect(pickDigestButtonHref(['/portal/chat/open?account=A&topic=Tax%202026'], BASE)).toBe(`${BASE}/portal/chat/open?account=A&topic=Tax%202026`)
  })

  it('mixed destinations → home', () => {
    expect(pickDigestButtonHref(['/portal/sign', '/portal/documents'], BASE)).toBe(HOME)
  })

  it('a missing link counts as home (so it mixes with any real destination)', () => {
    expect(pickDigestButtonHref([null, '/portal/sign'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref([undefined], BASE)).toBe(HOME)
    expect(pickDigestButtonHref([], BASE)).toBe(HOME)
  })

  it('accepts an absolute link on the portal origin and normalises it', () => {
    expect(pickDigestButtonHref(['https://portal.tonydurante.us/portal'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['https://portal.tonydurante.us/portal/services'], BASE)).toBe(`${BASE}/portal/services`)
  })

  it('treats an absolute home link and a relative home link as the same destination', () => {
    expect(pickDigestButtonHref(['https://portal.tonydurante.us/portal', '/portal'], BASE)).toBe(HOME)
  })

  it('rejects foreign and look-alike hosts, protocol-relative and non-portal paths', () => {
    expect(pickDigestButtonHref(['https://evil.com/portal/sign'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['https://portal.tonydurante.us.evil.com/portal/sign'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['//evil.com/portal/sign'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['/admin'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['/portalx'], BASE)).toBe(HOME)
    expect(pickDigestButtonHref(['javascript:alert(1)'], BASE)).toBe(HOME)
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(pickDigestButtonHref(['/portal/sign'], `${BASE}/`)).toBe(`${BASE}/portal/sign`)
  })
})
