import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isClientAllowedApiPath } from '@/lib/auth/client-api-allowlist'

// --- The predicate ---------------------------------------------------------

describe('isClientAllowedApiPath', () => {
  it('allows the portal API family', () => {
    expect(isClientAllowedApiPath('/api/portal/chat')).toBe(true)
    expect(isClientAllowedApiPath('/api/portal/payments/abc/pdf')).toBe(true)
    expect(isClientAllowedApiPath('/api/portal/tax-financials/download')).toBe(true)
  })

  it('allows the two non-portal paths the portal calls', () => {
    expect(isClientAllowedApiPath('/api/forms/lookup/tok/code')).toBe(true)
    expect(isClientAllowedApiPath('/api/td-communication/ai/generate')).toBe(true)
  })

  it('refuses the staff routes that only checked "is logged in"', () => {
    for (const p of [
      '/api/invoices/abc/send',
      '/api/invoices/abc/remind',
      '/api/invoices/abc/pdf',
      '/api/finance/link-transaction',
      '/api/finance/search-paid-invoices',
      '/api/crm/admin-actions/bank-feed-confirm-match',
      '/api/crm/admin-actions/bank-feed-reject-match',
      '/api/crm/admin-actions/bank-feed-retry-activation',
      '/api/crm/admin-actions/contact-actions',
      '/api/feed/create-from-feed',
    ]) {
      expect(isClientAllowedApiPath(p)).toBe(false)
    }
  })

  it('does not treat look-alike prefixes as the portal', () => {
    expect(isClientAllowedApiPath('/api/portal')).toBe(false)
    expect(isClientAllowedApiPath('/api/portal-chats/inbox')).toBe(false)
    expect(isClientAllowedApiPath('/api/portalx/anything')).toBe(false)
    expect(isClientAllowedApiPath('/api/forms/lookupx')).toBe(false)
  })

  it('keeps the td-communication entry exact (partner/staff routes share that prefix)', () => {
    expect(isClientAllowedApiPath('/api/td-communication/ai/generate/x')).toBe(false)
    expect(isClientAllowedApiPath('/api/td-communication/projects')).toBe(false)
    expect(isClientAllowedApiPath('/api/td-communication/ai')).toBe(false)
  })
})

// --- The middleware wiring -------------------------------------------------

let mockUser: Record<string, unknown> | null = null

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' } }) },
    },
  }),
}))

vi.mock('@/lib/auth/mfa-gate', () => ({ resolveMfaGate: () => 'allow' }))
vi.mock('@/lib/auth/mfa-remember-device', () => ({
  verifyMfaRememberDevice: async () => false,
  MFA_RD_COOKIE: 'td_mfa_rd',
}))

async function run(pathname: string, method = 'POST') {
  const { middleware } = await import('@/middleware')
  return middleware(new NextRequest(new URL(`https://crm.example.test${pathname}`), { method }))
}

describe('middleware: client API confinement', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  })

  it('returns 403 JSON when a client calls a staff invoice route', async () => {
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: {} }
    const res = await run('/api/invoices/abc/send')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'CLIENT_FORBIDDEN' })
  })

  it('returns 403 for a client GET of a staff invoice PDF', async () => {
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: {} }
    const res = await run('/api/invoices/abc/pdf', 'GET')
    expect(res.status).toBe(403)
  })

  it('lets a client through to the portal API', async () => {
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: {} }
    const res = await run('/api/portal/chat', 'GET')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('lets a client reach public paths (they return before the role check)', async () => {
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: {} }
    const res = await run('/api/workflows/td-bank-details', 'GET')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('does not touch staff sessions on the same staff route', async () => {
    mockUser = { id: 's1', email: 'staff@example.test', app_metadata: { role: 'team' }, user_metadata: {} }
    const res = await run('/api/invoices/abc/send')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('treats a differently-cased client role as a client', async () => {
    mockUser = { id: 'c2', email: 'client2@example.test', app_metadata: { role: 'Client' }, user_metadata: {} }
    const res = await run('/api/invoices/abc/send')
    expect(res.status).toBe(403)
  })

  it('ignores a self-written user_metadata role (only app_metadata decides)', async () => {
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: { role: 'admin' } }
    const res = await run('/api/crm/admin-actions/contact-actions')
    expect(res.status).toBe(403)
  })
})

// --- The inventory as a gate ----------------------------------------------
// Every '/api/...' literal written in client portal code must be reachable by a client
// session (allowlisted or public). A new portal feature calling a staff-only path fails
// here instead of silently 403ing for clients in production. Template-built URLs are
// only checked up to the first `${`, which is enough to catch the path family.

const PORTAL_SOURCE_DIRS = ['app/portal', 'components/portal', 'lib/portal']

// Literals that appear in portal code but are NOT client calls (verified 2026-10-02):
//  - /api/tools/pnl/…  staff workspace mode of the shared tax-financials review component
//  - /api/admin/view-as  mentioned in a comment describing the staff entry route
const NOT_CLIENT_CALLS = ['/api/tools/pnl/', '/api/admin/view-as']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p)
  }
  return out
}

function portalApiLiterals(): string[] {
  const found = new Set<string>()
  for (const dir of PORTAL_SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8')
      for (const m of Array.from(src.matchAll(/['"`](\/api\/[^'"`?\s$]*)/g))) found.add(m[1])
    }
  }
  return Array.from(found).filter(p => !NOT_CLIENT_CALLS.some(x => p.startsWith(x)))
}

describe('every /api path written in portal code is reachable by a client', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
    mockUser = { id: 'c1', email: 'client@example.test', app_metadata: { role: 'client' }, user_metadata: {} }
  })

  it('finds the portal literals (guards against a vacuous scan)', () => {
    expect(portalApiLiterals().length).toBeGreaterThan(20)
  })

  it('none of them is refused by the client guard', async () => {
    const refused: string[] = []
    for (const p of portalApiLiterals()) {
      const res = await run(p.endsWith('/') ? `${p}x` : p, 'GET')
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}))
        if (body?.code === 'CLIENT_FORBIDDEN') refused.push(p)
      }
    }
    expect(refused).toEqual([])
  })
})
