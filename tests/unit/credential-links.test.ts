import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { holdsCredentialLink, hideCredentialLinks, HIDDEN_LINK_NOTICE, CREDENTIAL_LINK_PAGES } from '@/lib/portal/credential-links'

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
const HOST = 'https://app.tonydurante.us'
const CODE = 'a1B2c3D4e5F6'

describe('holdsCredentialLink — a link that works without a login', () => {
  it.each([
    ['the member information form', `Hi! Please fill out this short form:\n\n${HOST}/member-info/0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b/${CODE}`],
    ['the add-a-contact form', `Please add a contact:\n\n${HOST}/contact-request/0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b/${CODE}`],
    ['an operating-agreement signing page with its short code', `${HOST}/operating-agreement/example-llc-oa-2026/53b38eb7?portal=true&signer=2e4f6a25`],
    ['an SS-4 page', `${HOST}/ss4/ss4-example-llc-2026/${CODE}`],
    ['a lease', `${HOST}/lease/example-lease-2026/${CODE}`],
    ['an offer', `${HOST}/offer/example-offer-2026/${CODE}`],
    ['the portal wrapper of a form (it still carries token + code)', `https://portal.tonydurante.us/portal/form/0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b/${CODE}`],
    ['a public sign page', `${HOST}/sign/${CODE}`],
    ['a markdown link', `[open the form](${HOST}/member-info/0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b/${CODE})`],
    ['an upper-case address', `HTTPS://APP.TONYDURANTE.US/MEMBER-INFO/0B8E4F2A/${CODE}`],
    ['the legacy offer host', `https://offerte.tonydurante.us/${CODE}`],
    ['a link in the middle of a sentence', `Great news! Please use ${HOST}/banking-form/example-2026/${CODE}, thank you.`],
  ])('%s', (_name, text) => {
    expect(holdsCredentialLink(text)).toBe(true)
  })

  it.each([
    ['a login-protected portal sign page', 'Please sign here: https://portal.tonydurante.us/portal/sign/ss4'],
    ['a login-protected operating-agreement page', 'https://portal.tonydurante.us/portal/sign/oa?account=0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b&oa=1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'],
    ['a link back into the portal chat', 'https://portal.tonydurante.us/portal/chat/open?account=0b8e4f2a-1c3d-4e5f-8a9b-1c2d3e4f5a6b&topic=general'],
    ['an invoice page in the portal', 'https://portal.tonydurante.us/portal/invoices/8038afbc-d766-420c-bef4-9a07ded83e54'],
    ['plain text that only names a page', 'We sent you the member-info form and the lease. Please check your email.'],
    ['a bare path with no host', 'open /member-info/0b8e4f2a/abcdef in the app'],
    ['an ordinary web link', 'See https://www.irs.gov/forms-pubs/about-form-ss-4 for details'],
    ['a company web site that merely starts with a page name', 'https://leasing-partners.example.com/home'],
    ['an empty message', ''],
  ])('does NOT match %s', (_name, text) => {
    expect(holdsCredentialLink(text)).toBe(false)
  })

  it('handles missing text', () => {
    expect(holdsCredentialLink(null)).toBe(false)
    expect(holdsCredentialLink(undefined)).toBe(false)
  })

  it('gives the same answer every time (no stateful regex)', () => {
    const t = `${HOST}/member-info/0b8e4f2a/${CODE}`
    expect([1, 2, 3, 4].map(() => holdsCredentialLink(t))).toEqual([true, true, true, true])
  })
})

describe('hideCredentialLinks — what a team login is shown', () => {
  const rows = [
    { id: 'a', sender_type: 'admin', message: `Fill this in:\n${HOST}/member-info/0b8e4f2a/${CODE}`, original_message: null as string | null, created_at: '2026-11-12T10:00:00Z' },
    { id: 'b', sender_type: 'client', message: 'Thanks, done!', original_message: null as string | null, created_at: '2026-11-12T10:05:00Z' },
    { id: 'c', sender_type: 'admin', message: 'Edited text without a link', original_message: `first draft ${HOST}/contact-request/0b8e4f2a/${CODE}`, created_at: '2026-11-12T10:06:00Z' },
  ]

  it('replaces the text of a message that holds a link and keeps everything else on the row', () => {
    const out = hideCredentialLinks(rows)
    expect(out[0].message).toBe(HIDDEN_LINK_NOTICE)
    expect(out[0]).toMatchObject({ id: 'a', sender_type: 'admin', created_at: '2026-11-12T10:00:00Z' })
    expect(JSON.stringify(out[0])).not.toContain(CODE)
  })

  it('leaves a message without a link exactly as it was (same object)', () => {
    const out = hideCredentialLinks(rows)
    expect(out[1]).toBe(rows[1])
  })

  it('also hides the saved original text of an edited message', () => {
    const out = hideCredentialLinks(rows)
    expect(out[2].message).toBe('Edited text without a link')
    expect(out[2].original_message).toBe(HIDDEN_LINK_NOTICE)
    expect(JSON.stringify(out[2])).not.toContain(CODE)
  })

  it('does not change the input rows', () => {
    const before = JSON.stringify(rows)
    hideCredentialLinks(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('handles an empty list', () => {
    expect(hideCredentialLinks([])).toEqual([])
  })
})

describe('the page list stays in step with the middleware', () => {
  // Every public (no-login) page prefix in middleware.ts must be either a page whose link belongs on this list, or consciously listed here
  // as "its link is not a secret". A NEW public token page therefore fails this test until someone decides.
  const NOT_A_SECRET_LINK = new Set([
    'login', 'auth', 'portal/login', 'portal/forgot-password', 'portal/reset-password', 'portal/auth/callback', 'portal/view-as',
    'portal/undo-email-change', 'marketing/accept', 'marketing/forgot', 'marketing/reset', 'marketing/book', '.well-known', 'oauth',
    'manifest.webmanifest', 'portal/manifest.webmanifest', 'talk/manifest.webmanifest', 'dashboard-sw.js', 'portal-sw.js', 'talk-sw.js',
    'marketing-sw.js', 'offline', 'privacy', 'support', 'portfolio', 'site', 'esign/pdf.worker.min.mjs',
  ])
  const middleware = read('middleware.ts')
  const start = middleware.indexOf('const PUBLIC_PREFIXES = [')
  const block = middleware.slice(start, middleware.indexOf('\n]', start))
  const prefixes = Array.from(block.matchAll(/^\s+'(\/[^']*)'/gm)).map((m) => m[1])
  const pages = prefixes.filter((p) => !p.startsWith('/api/')).map((p) => p.replace(/^\/|\/$/g, ''))

  it('finds the public prefixes in the middleware', () => {
    expect(prefixes.length).toBeGreaterThan(50)
    expect(pages).toContain('member-info')
  })

  it.each(pages)('/%s is either on the credential-link list or marked "not a secret link"', (page) => {
    const covered = (CREDENTIAL_LINK_PAGES as readonly string[]).includes(page)
    expect(covered || NOT_A_SECRET_LINK.has(page), `public page "/${page}" is on neither list in tests/unit/credential-links.test.ts / lib/portal/credential-links.ts`).toBe(true)
  })

  it('every page on the list really is a public page of the middleware (no typo, nothing stale)', () => {
    for (const page of CREDENTIAL_LINK_PAGES) {
      if (page === 'portal/form') continue // the portal wrapper of a form: login-protected, but it carries token + code
      expect(pages, `"${page}" is on the credential-link list but is not a public prefix in middleware.ts`).toContain(page)
    }
  })
})

describe('the team login is shown the neutral line where the app reads chat for it', () => {
  // The routes are too large to run without a database, so this pins the wiring.
  it('the chat read hides credential links for a team login (client login with no person), after the rows are read and before they are returned', () => {
    const src = read('app/api/portal/chat/route.ts')
    const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'))
    expect(src).toMatch(/from '@\/lib\/portal\/credential-links'/)
    const use = get.indexOf('hideCredentialLinks(')
    expect(use).toBeGreaterThan(-1)
    expect(get.slice(Math.max(0, use - 220), use)).toContain('isClientUser && !authContactId')
    expect(use).toBeGreaterThan(get.indexOf('const { data: rawData, error } = await query'))
  })

  it("the flow page hides them from a team login too (it reads the flow's chat messages)", () => {
    const src = read('app/portal/flows/[id]/page.tsx')
    expect(src).toMatch(/from '@\/lib\/portal\/credential-links'/)
    const use = src.indexOf('hideCredentialLinks(')
    expect(use).toBeGreaterThan(-1)
    expect(src.slice(Math.max(0, use - 260), use)).toContain("kind === 'team_member'")
  })
})

describe('the detector, compiled the way production compiles it (R115)', () => {
  // Next 14's production compiler can change a regex that dev and tests run as written (a template-string regex lost a backspace on 2026-11-08).
  // This compiles the file with Next's own compiler, minified, and runs the compiled code.
  const SOURCE = read('lib/portal/credential-links.ts')
  type Mod = { holdsCredentialLink: (t: string) => boolean; hideCredentialLinks: (r: Array<{ message?: string | null }>) => Array<{ message?: string | null }> }

  async function compiled(target: 'es2017' | 'es5'): Promise<Mod> {
    const { transform } = await import('next/dist/build/swc')
    const out = await transform(SOURCE, {
      filename: 'credential-links.ts',
      jsc: { parser: { syntax: 'typescript' }, target, minify: { compress: true, mangle: true } },
      module: { type: 'commonjs' },
      minify: true,
      sourceMaps: false,
    })
    const mod = { exports: {} as Record<string, unknown> }
    new Function('module', 'exports', 'require', out.code)(mod, mod.exports, () => { throw new Error('the detector must not import anything') })
    return mod.exports as unknown as Mod
  }

  for (const target of ['es2017', 'es5'] as const) {
    it(`target ${target}: finds the links and leaves the login pages alone`, async () => {
      const m = await compiled(target)
      expect(m.holdsCredentialLink(`Fill this in:\n${HOST}/member-info/0b8e4f2a/${CODE}`)).toBe(true)
      expect(m.holdsCredentialLink(`${HOST}/operating-agreement/example-llc-oa-2026/53b38eb7?portal=true`)).toBe(true)
      expect(m.holdsCredentialLink(`https://portal.tonydurante.us/portal/form/0b8e4f2a/${CODE}`)).toBe(true)
      expect(m.holdsCredentialLink('https://portal.tonydurante.us/portal/sign/ss4')).toBe(false)
      expect(m.holdsCredentialLink('We sent you the member-info form.')).toBe(false)
      const rows = m.hideCredentialLinks([{ message: `x ${HOST}/lease/example-2026/${CODE}` }, { message: 'hello' }])
      expect(rows[0].message).toBe(HIDDEN_LINK_NOTICE)
      expect(rows[1].message).toBe('hello')
    })
  }
})
