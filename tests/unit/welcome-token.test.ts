import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── In-memory mock for portal_welcome_tokens ───────────────
interface MockRow {
  token: string
  contact_id: string | null
  email: string
  encrypted_password: string
  language: string
  source: string
  source_id: string | null
  expires_at: string
  first_viewed_at: string | null
  created_at: string
}

const store: { rows: MockRow[] } = { rows: [] }

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'portal_welcome_tokens') {
        throw new Error(`Unexpected table: ${table}`)
      }
      return {
        insert: (row: Partial<MockRow>) => {
          store.rows.push({
            token: row.token!,
            contact_id: row.contact_id ?? null,
            email: row.email!,
            encrypted_password: row.encrypted_password!,
            language: row.language || 'en',
            source: row.source || 'offer',
            source_id: row.source_id ?? null,
            expires_at: row.expires_at!,
            first_viewed_at: row.first_viewed_at ?? null,
            created_at: new Date().toISOString(),
          })
          return Promise.resolve({ data: null, error: null })
        },
        select: (_cols?: string) => {
          // Chainable filter builder
          const filters: Array<(r: MockRow) => boolean> = []
          let nullCol: keyof MockRow | null = null
          const builder = {
            eq(col: keyof MockRow, val: unknown) {
              filters.push((r) => r[col] === val)
              return builder
            },
            order(_col: string, _opts?: unknown) {
              return builder
            },
            limit(_n: number) {
              return builder
            },
            is(col: keyof MockRow, val: null) {
              nullCol = col
              filters.push((r) => r[col] === val)
              return builder
            },
            maybeSingle() {
              const found = store.rows.find((r) => filters.every((f) => f(r)))
              return Promise.resolve({ data: found ?? null, error: null })
            },
          }
          void nullCol
          return builder
        },
        update: (patch: Partial<MockRow>) => {
          const filters: Array<(r: MockRow) => boolean> = []
          const exec = () => {
            for (const r of store.rows) {
              if (filters.every((f) => f(r))) Object.assign(r, patch)
            }
            return Promise.resolve({ data: null, error: null })
          }
          const builder = {
            eq(col: keyof MockRow, val: unknown) {
              filters.push((r) => r[col] === val)
              return builder
            },
            is(col: keyof MockRow, val: null) {
              filters.push((r) => r[col] === val)
              // is() is the terminal call in markWelcomeTokenViewed — execute now
              return exec()
            },
          }
          return builder
        },
      }
    },
  },
}))

// Import AFTER mock is registered
import {
  encryptPassword,
  decryptPassword,
  createWelcomeToken,
  getWelcomeToken,
  isWelcomeTokenExpired,
  markWelcomeTokenViewed,
  findWelcomeTokenBySource,
} from '@/lib/portal/welcome-token'

beforeEach(() => {
  store.rows = []
})

describe('welcome-token encryption', () => {
  it('round-trips a password with the right token', () => {
    const token = '11111111-1111-4111-8111-111111111111'
    const enc = encryptPassword(token, 'Hunter2-Temp-Pwd!')
    expect(enc).not.toContain('Hunter2')
    expect(decryptPassword(token, enc)).toBe('Hunter2-Temp-Pwd!')
  })

  it('produces different ciphertext for identical plaintext (random IV)', () => {
    const token = '22222222-2222-4222-8222-222222222222'
    const a = encryptPassword(token, 'same-password')
    const b = encryptPassword(token, 'same-password')
    expect(a).not.toBe(b)
    expect(decryptPassword(token, a)).toBe('same-password')
    expect(decryptPassword(token, b)).toBe('same-password')
  })

  it('fails to decrypt with a different token (auth tag mismatch)', () => {
    const token = '33333333-3333-4333-8333-333333333333'
    const otherToken = '44444444-4444-4444-8444-444444444444'
    const enc = encryptPassword(token, 'top-secret')
    expect(() => decryptPassword(otherToken, enc)).toThrow()
  })

  it('rejects ciphertext that is too short', () => {
    const token = '55555555-5555-4555-8555-555555555555'
    expect(() => decryptPassword(token, Buffer.from('short').toString('base64'))).toThrow()
  })
})

describe('createWelcomeToken', () => {
  it('inserts a row and returns a usable welcome URL', async () => {
    const result = await createWelcomeToken({
      contactId: 'contact-1',
      email: 'lead@example.com',
      tempPassword: 'Init-Pass-9!',
      language: 'en',
      source: 'offer',
      sourceId: 'offer-token-abc',
    })

    expect(result.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.welcomeUrl).toContain('/welcome/')
    expect(result.welcomeUrl).toContain(result.token)

    expect(store.rows).toHaveLength(1)
    const row = store.rows[0]
    expect(row.email).toBe('lead@example.com')
    expect(row.source).toBe('offer')
    expect(row.source_id).toBe('offer-token-abc')

    // Encrypted_password is not the plaintext
    expect(row.encrypted_password).not.toContain('Init-Pass-9!')

    // expires_at is ~7 days out (allow 60s skew)
    const ms = new Date(row.expires_at).getTime() - Date.now()
    expect(ms).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1000)
    expect(ms).toBeLessThan(7.01 * 24 * 60 * 60 * 1000)

    // The ciphertext decrypts back to the original password with the token
    expect(decryptPassword(result.token, row.encrypted_password)).toBe('Init-Pass-9!')
  })

  it('defaults language to "en" and source to "offer"', async () => {
    await createWelcomeToken({
      contactId: null,
      email: 'no-prefs@example.com',
      tempPassword: 'pw',
    })
    expect(store.rows[0].language).toBe('en')
    expect(store.rows[0].source).toBe('offer')
  })
})

describe('isWelcomeTokenExpired', () => {
  it('returns false for a future expires_at', () => {
    expect(isWelcomeTokenExpired({ expires_at: new Date(Date.now() + 1000).toISOString() })).toBe(false)
  })
  it('returns true for a past expires_at', () => {
    expect(isWelcomeTokenExpired({ expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(true)
  })
})

describe('getWelcomeToken / markWelcomeTokenViewed', () => {
  it('looks up a token and marks first_viewed_at on first call only', async () => {
    const { token } = await createWelcomeToken({
      contactId: null,
      email: 'viewed@example.com',
      tempPassword: 'pw',
    })

    const row = await getWelcomeToken(token)
    expect(row).not.toBeNull()
    expect(row!.first_viewed_at).toBeNull()

    await markWelcomeTokenViewed(token)
    const row2 = await getWelcomeToken(token)
    expect(row2!.first_viewed_at).not.toBeNull()
    const firstView = row2!.first_viewed_at

    // Second mark should be a no-op (is null guard)
    await markWelcomeTokenViewed(token)
    const row3 = await getWelcomeToken(token)
    expect(row3!.first_viewed_at).toBe(firstView)
  })

  it('returns null for an unknown token', async () => {
    const row = await getWelcomeToken('99999999-9999-4999-8999-999999999999')
    expect(row).toBeNull()
  })
})

describe('findWelcomeTokenBySource', () => {
  it('finds the row inserted for a given source + source_id', async () => {
    const created = await createWelcomeToken({
      contactId: null,
      email: 'src@example.com',
      tempPassword: 'pw',
      source: 'offer',
      sourceId: 'offer-token-xyz',
    })
    const found = await findWelcomeTokenBySource('offer', 'offer-token-xyz')
    expect(found).not.toBeNull()
    expect(found!.token).toBe(created.token)
    expect(found!.welcomeUrl).toBe(created.welcomeUrl)
  })

  it('returns null when nothing matches', async () => {
    const found = await findWelcomeTokenBySource('offer', 'does-not-exist')
    expect(found).toBeNull()
  })
})
