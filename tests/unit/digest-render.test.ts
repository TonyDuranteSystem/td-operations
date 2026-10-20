import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_TYPE_LABELS,
  mergeTypeLabels,
  buildDigestSections,
  pickDigestButtonHref,
  buildDigestHeadline,
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
    expect(pickDigestButtonHref(['/portal/chat/open?chatlink=1&account=A&topic=Tax%202026'], BASE)).toBe(`${BASE}/portal/chat/open?chatlink=1&account=A&topic=Tax%202026`)
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

describe('service_started section (S3 grouped email)', () => {
  const labels = mergeTypeLabels(undefined)
  it('has its own heading in both languages', () => {
    const items = [
      { type: 'service_started', title: 'Public Notary — nothing needed from you for now' },
      { type: 'service_started', title: 'Shipping Service — nothing needed from you for now' },
    ]
    const [en] = buildDigestSections(items, labels, false)
    expect(en).toContain('What we are doing (2)')
    const [it] = buildDigestSections(items, labels, true)
    expect(it).toContain('Cosa stiamo facendo noi (2)')
  })
})

describe('buildDigestHeadline', () => {
  it('a normal digest keeps today\'s wording exactly', () => {
    expect(buildDigestHeadline({ types: ['chat', 'document'], isItalian: false })).toEqual({
      subject: '2 new updates in your portal',
      intro: 'You have new updates in your portal:',
      closing: null,
    })
    expect(buildDigestHeadline({ types: ['chat'], isItalian: false }).subject).toBe('1 new update in your portal')
    expect(buildDigestHeadline({ types: ['chat'], isItalian: true }).subject).toBe('1 nuovo aggiornamento nel tuo portale')
    expect(buildDigestHeadline({ types: ['chat', 'chat'], isItalian: true })).toEqual({
      subject: '2 nuovi aggiornamenti nel tuo portale',
      intro: 'Hai nuovi aggiornamenti nel tuo portale:',
      closing: null,
    })
  })

  it('a digest with a started service is the grouped email: approved subject, opening line with the company, closing line', () => {
    expect(buildDigestHeadline({ types: ['service', 'service_started', 'service_started'], isItalian: false, companyName: 'Acme Holdings LLC' })).toEqual({
      subject: 'Your services have started — here is what happens next',
      intro: 'Here is what has started for Acme Holdings LLC:',
      closing: 'We will also message you in your portal chat at every step.',
    })
    expect(buildDigestHeadline({ types: ['service_started'], isItalian: true, companyName: 'Acme Holdings LLC' })).toEqual({
      subject: 'I tuoi servizi sono partiti — ecco cosa succede ora',
      intro: 'Ecco cosa è partito per Acme Holdings LLC:',
      closing: 'Ti scriveremo anche nella chat del portale a ogni passo.',
    })
  })

  it('the activation welcome and a question card may sit in the same email; anything else means the email is about more than a start, so it keeps the normal wording', () => {
    const grouped = buildDigestHeadline({ types: ['service', 'service_started', 'decision'], isItalian: false, companyName: 'Acme LLC' })
    expect(grouped.subject).toBe('Your services have started — here is what happens next')
    for (const other of ['invoice', 'sign_document', 'deadline', 'chat', 'document', 'new_document', 'tax_document_uploaded', 'anything_else']) {
      const mixed = buildDigestHeadline({ types: ['service_started', other], isItalian: false, companyName: 'Acme LLC' })
      expect(mixed.subject, other).toBe('2 new updates in your portal')
      expect(mixed.intro, other).toBe('You have new updates in your portal:')
      expect(mixed.closing, other).toBeNull()
    }
  })

  it('no company: the opening line addresses the client instead', () => {
    expect(buildDigestHeadline({ types: ['service_started'], isItalian: false, companyName: null }).intro).toBe('Here is what has started for you:')
    expect(buildDigestHeadline({ types: ['service_started'], isItalian: true, companyName: '  ' }).intro).toBe('Ecco cosa è partito per te:')
  })
})

describe('portal digest cron — S3 wiring', () => {
  const cron = readFileSync(join(process.cwd(), 'app/api/cron/portal-digest/route.ts'), 'utf8')
  it('the company in the opening line comes from the "service started" rows only, and only when they all belong to ONE company', () => {
    expect(cron).toContain("emailNotifs.filter(n => n.type === SERVICE_STARTED_NOTIFICATION_TYPE).map(n => n.account_id)")
    expect(cron).toContain('if (startedAccounts.length === 1) {')
    expect(cron).toContain('companyName: startedCompany,')
  })
  it('the opening line and the footer company name are HTML-escaped (a company name is typed by the client)', () => {
    expect(cron).toContain('escapeHtml(introText)')
    expect(cron).toContain('escapeHtml(companyName)')
  })
})
