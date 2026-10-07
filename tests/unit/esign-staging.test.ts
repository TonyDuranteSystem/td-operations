import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ESIGN_MAX_PDF_BYTES,
  ESIGN_STAGING_MAX_AGE_MS,
  buildStagingPath,
  claimedPathFor,
  isStagingObjectPath,
  isStaleStagingObject,
  isValidStagingPath,
  sanitizePdfFileName,
  tooLargeMessage,
} from '@/lib/esign/staging-shared'
import { DEFAULT_MAX_BYTES } from '@/lib/esign/upload-guard'

/**
 * E-Sign direct-upload staging rules (dev job 55bdf0dd). The path shape is the ONLY
 * read gate on a private bucket that also holds live signable documents — so the
 * tests are adversarial: every way a client could try to point the server at a file
 * it did not mint must be refused.
 */

const USER = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'
const OBJ = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('staging path shape', () => {
  it('accepts exactly the path the server mints for this user', () => {
    const p = buildStagingPath(USER, OBJ)
    expect(p).toBe(`esign-staging/${USER}/${OBJ}.pdf`)
    expect(isValidStagingPath(p, USER)).toBe(true)
  })

  it('refuses another staff member\'s staged file', () => {
    expect(isValidStagingPath(buildStagingPath(OTHER, OBJ), USER)).toBe(false)
  })

  it.each([
    ['a live envelope PDF', 'esign/abcdefabcdefabcdef/doc.pdf'],
    ['a traversal into live documents', `esign-staging/${USER}/../../esign/tok/doc.pdf`],
    ['a traversal in the uuid slot', `esign-staging/${USER}/..%2f${OBJ}.pdf`],
    ['an extra path segment', `esign-staging/${USER}/x/${OBJ}.pdf`],
    ['a wrong extension', `esign-staging/${USER}/${OBJ}.exe`],
    ['a missing extension', `esign-staging/${USER}/${OBJ}`],
    ['a trailing slash', `esign-staging/${USER}/${OBJ}.pdf/`],
    ['a leading slash', `/esign-staging/${USER}/${OBJ}.pdf`],
    ['a different prefix', `inbox-email/${OBJ}.pdf`],
    ['an unanchored match', `x/esign-staging/${USER}/${OBJ}.pdf`],
    ['a trailing junk suffix', `esign-staging/${USER}/${OBJ}.pdf.bak`],
    ['a claimed (already used) path', `esign-staging/${USER}/claimed-${OBJ}.pdf`],
    ['an empty string', ''],
  ])('refuses %s', (_label, path) => {
    expect(isValidStagingPath(path, USER)).toBe(false)
  })

  it('refuses non-strings and an empty user id', () => {
    expect(isValidStagingPath(undefined, USER)).toBe(false)
    expect(isValidStagingPath(null, USER)).toBe(false)
    expect(isValidStagingPath(42, USER)).toBe(false)
    expect(isValidStagingPath({ path: 'x' }, USER)).toBe(false)
    expect(isValidStagingPath(buildStagingPath(USER, OBJ), '')).toBe(false)
  })

  it('compares user ids case-insensitively (uuids are hex) but nothing else loosely', () => {
    expect(isValidStagingPath(buildStagingPath(USER, OBJ), USER.toUpperCase())).toBe(true)
  })
})

describe('claimed path', () => {
  it('moves the object to a name the staging validator will never accept again', () => {
    const staged = buildStagingPath(USER, OBJ)
    const claimed = claimedPathFor(staged)
    expect(claimed).toBe(`esign-staging/${USER}/claimed-${OBJ}.pdf`)
    expect(isValidStagingPath(claimed, USER)).toBe(false) // cannot be replayed
    expect(isStagingObjectPath(claimed)).toBe(true) // but cleanup/sweep still recognise it
    expect(isStagingObjectPath(staged)).toBe(true)
  })

  it('refuses to derive a claim path from a non-staging path', () => {
    expect(() => claimedPathFor('esign/tok/doc.pdf')).toThrow()
  })

  it('cleanup never recognises a live envelope file', () => {
    expect(isStagingObjectPath('esign/abcdefabcdefabcdef/doc.pdf')).toBe(false)
    expect(isStagingObjectPath(`esign-staging/${USER}/notes.txt`)).toBe(false)
  })
})

describe('size rule', () => {
  it('is the same 25 MB the PDF guard enforces', () => {
    expect(ESIGN_MAX_PDF_BYTES).toBe(DEFAULT_MAX_BYTES)
    expect(ESIGN_MAX_PDF_BYTES).toBe(25 * 1024 * 1024)
  })

  it('says the real size, the limit and what to do', () => {
    const msg = tooLargeMessage(30 * 1048576)
    expect(msg).toContain('30.0 MB')
    expect(msg).toContain('25 MB')
    expect(msg.toLowerCase()).toContain('compress')
  })
})

describe('stale staging objects (daily sweep)', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z')
  it('keeps a fresh upload', () => {
    expect(isStaleStagingObject('2026-10-08T11:00:00Z', NOW)).toBe(false)
  })
  it('removes an upload older than 24 h', () => {
    expect(isStaleStagingObject('2026-10-07T11:59:00Z', NOW)).toBe(true)
  })
  it('is exactly at the boundary: not yet stale at the limit', () => {
    expect(isStaleStagingObject(new Date(NOW - ESIGN_STAGING_MAX_AGE_MS).toISOString(), NOW)).toBe(false)
  })
  it('treats a missing or unparseable timestamp as removable (cannot prove it is fresh)', () => {
    expect(isStaleStagingObject(null, NOW)).toBe(true)
    expect(isStaleStagingObject(undefined, NOW)).toBe(true)
    expect(isStaleStagingObject('not a date', NOW)).toBe(true)
  })
})

describe('sanitizePdfFileName', () => {
  it('keeps a normal name and forces .pdf', () => {
    expect(sanitizePdfFileName('2025_UGC ITALIA LLC_1120.pdf')).toBe('2025_UGC_ITALIA_LLC_1120.pdf')
    expect(sanitizePdfFileName('report')).toBe('report.pdf')
  })
  it('never returns an empty, dots-only or traversal name', () => {
    expect(sanitizePdfFileName('')).toBe('document.pdf')
    expect(sanitizePdfFileName('...')).toBe('document.pdf')
    expect(sanitizePdfFileName('../../etc/passwd')).not.toContain('/')
    expect(sanitizePdfFileName('日本語.pdf')).toBe('document.pdf')
    expect(sanitizePdfFileName(undefined, 'template')).toBe('template.pdf')
  })
  it('bounds the length', () => {
    expect(sanitizePdfFileName('a'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(124)
  })
})

// ─── server side: claim + sweep against a fake storage ───────────────────────

type Obj = { name: string; id: string | null; created_at?: string; metadata?: { size: number } }

const state = vi.hoisted(() => ({
  files: new Map<string, { bytes: Uint8Array; created_at: string }>(),
  moveError: false,
  downloadError: false,
  calls: [] as string[],
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        list: async (dir: string, opts: { search?: string } = {}) => {
          state.calls.push(`list:${dir}`)
          const out: Obj[] = []
          const seenFolders = new Set<string>()
          for (const [path, f] of Array.from(state.files.entries())) {
            if (!path.startsWith(dir + '/')) continue
            const rest = path.slice(dir.length + 1)
            if (rest.includes('/')) {
              const folder = rest.split('/')[0]
              if (!seenFolders.has(folder)) { seenFolders.add(folder); out.push({ name: folder, id: null }) }
              continue
            }
            if (opts.search && !rest.includes(opts.search)) continue
            out.push({ name: rest, id: 'x', created_at: f.created_at, metadata: { size: f.bytes.length } })
          }
          return { data: out, error: null }
        },
        move: async (from: string, to: string) => {
          state.calls.push(`move:${from}->${to}`)
          if (state.moveError || !state.files.has(from)) return { data: null, error: { message: 'not found' } }
          state.files.set(to, state.files.get(from)!)
          state.files.delete(from)
          return { data: {}, error: null }
        },
        download: async (path: string) => {
          state.calls.push(`download:${path}`)
          const f = state.files.get(path)
          if (state.downloadError || !f) return { data: null, error: { message: 'gone' } }
          return { data: new Blob([f.bytes as unknown as BlobPart]), error: null }
        },
        remove: async (paths: string[]) => {
          state.calls.push(`remove:${paths.join(',')}`)
          for (const p of paths) state.files.delete(p)
          return { data: [], error: null }
        },
      }),
    },
  },
}))

import { claimStagedPdf, discardStaged, sweepEsignStaging } from '@/lib/esign/staging'

function stage(bytes = new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]), createdAt = '2026-10-08T11:00:00Z') {
  const path = buildStagingPath(USER, OBJ)
  state.files.set(path, { bytes, created_at: createdAt })
  return path
}

beforeEach(() => {
  state.files.clear()
  state.moveError = false
  state.downloadError = false
  state.calls.length = 0
})

describe('claimStagedPdf', () => {
  it('returns the bytes and leaves the original path empty (claimed)', async () => {
    const path = stage()
    const r = await claimStagedPdf(path, USER)
    expect(r.ok).toBe(true)
    if (r.kind === "claimed") {
      expect(Array.from(r.bytes)).toEqual([37, 80, 68, 70, 45, 1, 2, 3])
      expect(r.claimedPath).toBe(claimedPathFor(path))
    }
    expect(state.files.has(path)).toBe(false)
  })

  it('a SECOND claim of the same file finds nothing — no duplicate envelope', async () => {
    const path = stage()
    expect((await claimStagedPdf(path, USER)).ok).toBe(true)
    const again = await claimStagedPdf(path, USER)
    expect(again.ok).toBe(false)
    if (again.kind === "refused") expect(again.status).toBe(404)
  })

  it('never touches storage for a path it did not mint', async () => {
    const r = await claimStagedPdf('esign/tok/doc.pdf', USER)
    expect(r.ok).toBe(false)
    if (r.kind === "refused") expect(r.status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it('refuses another user\'s staged file without touching storage', async () => {
    const r = await claimStagedPdf(buildStagingPath(OTHER, OBJ), USER)
    expect(r.ok).toBe(false)
    expect(state.calls).toEqual([])
  })

  it('rejects an oversized object by its REAL size before downloading it, and deletes it', async () => {
    const path = stage(new Uint8Array(ESIGN_MAX_PDF_BYTES + 1))
    const r = await claimStagedPdf(path, USER)
    expect(r.ok).toBe(false)
    if (r.kind === "refused") {
      expect(r.status).toBe(400)
      expect(r.error).toContain('25 MB')
    }
    expect(state.calls.some(c => c.startsWith('download:'))).toBe(false)
    expect(state.files.has(path)).toBe(false)
  })

  it('a missing upload gives a plain "choose the file again" message', async () => {
    const r = await claimStagedPdf(buildStagingPath(USER, OBJ), USER)
    expect(r.ok).toBe(false)
    if (r.kind === "refused") expect(r.error).toContain('choose the file again')
  })

  it('a lost claim race (move fails) stops without reading', async () => {
    const path = stage()
    state.moveError = true
    const r = await claimStagedPdf(path, USER)
    expect(r.ok).toBe(false)
    if (r.kind === "refused") expect(r.status).toBe(409)
    expect(state.calls.some(c => c.startsWith('download:'))).toBe(false)
  })

  it('a failed read after claiming removes the claimed object (no PII left behind)', async () => {
    const path = stage()
    state.downloadError = true
    const r = await claimStagedPdf(path, USER)
    expect(r.ok).toBe(false)
    expect(state.files.size).toBe(0)
  })
})

describe('discardStaged', () => {
  it('removes a claimed staging object', async () => {
    const path = stage()
    const r = await claimStagedPdf(path, USER)
    if (r.kind === "refused") throw new Error('claim failed')
    await discardStaged(r.claimedPath)
    expect(state.files.size).toBe(0)
  })

  it('refuses to delete anything that is not a staging object (a live envelope file)', async () => {
    state.files.set('esign/tok/doc.pdf', { bytes: new Uint8Array([1]), created_at: '2026-10-08T00:00:00Z' })
    await discardStaged('esign/tok/doc.pdf')
    await discardStaged(undefined)
    expect(state.files.has('esign/tok/doc.pdf')).toBe(true)
    expect(state.calls.some(c => c.startsWith('remove:'))).toBe(false)
  })
})

describe('sweepEsignStaging', () => {
  const NOW = new Date('2026-10-08T12:00:00Z')

  it('removes only stale staging objects (unclaimed and claimed) and never a live envelope file', async () => {
    const stale = buildStagingPath(USER, OBJ)
    const staleClaimed = claimedPathFor(buildStagingPath(OTHER, 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'))
    const fresh = buildStagingPath(USER, 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    state.files.set(stale, { bytes: new Uint8Array([1]), created_at: '2026-10-06T00:00:00Z' })
    state.files.set(staleClaimed, { bytes: new Uint8Array([1]), created_at: '2026-10-06T00:00:00Z' })
    state.files.set(fresh, { bytes: new Uint8Array([1]), created_at: '2026-10-08T11:30:00Z' })
    state.files.set('esign/tok/doc.pdf', { bytes: new Uint8Array([1]), created_at: '2020-01-01T00:00:00Z' })

    const r = await sweepEsignStaging(NOW)
    expect(r.removed).toBe(2)
    expect(state.files.has(stale)).toBe(false)
    expect(state.files.has(staleClaimed)).toBe(false)
    expect(state.files.has(fresh)).toBe(true)
    expect(state.files.has('esign/tok/doc.pdf')).toBe(true)
  })

  it('does nothing and does not throw when there is nothing staged', async () => {
    const r = await sweepEsignStaging(NOW)
    expect(r).toEqual({ removed: 0 })
  })
})
