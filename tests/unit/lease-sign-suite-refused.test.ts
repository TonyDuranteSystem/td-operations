import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Signing a lease whose suite is no longer its company's (the company was closed and the number reused): the database
 * refuses the "signed" write with a check violation (23514). The client must see a clear message with status 409, not
 * the generic 500 "Failed to record signature" — and any OTHER database error must still be a 500.
 */

let writeError: { code?: string; message: string } | null

vi.mock('@/lib/esign/access-guard', () => ({ accessCodeError: () => null }))
vi.mock('@/lib/supabase-admin', () => {
  const from = () => {
    let isUpdate = false
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq']) chain[m] = self
    chain.update = () => {
      isUpdate = true
      return chain
    }
    chain.maybeSingle = () =>
      Promise.resolve(isUpdate
        ? { data: writeError ? null : { id: 'l1' }, error: writeError }
        : { data: { id: 'l1', access_code: null, status: 'sent' }, error: null })
    return chain
  }
  return { supabaseAdmin: { from, storage: { from: () => ({ list: async () => ({ data: [{ name: 'lease.pdf' }], error: null }) }) } } }
})

async function sign() {
  const { POST } = await import('@/app/api/lease/[token]/sign/route')
  const req = new NextRequest('http://localhost/api/lease/acme-2026/sign', {
    method: 'POST',
    body: JSON.stringify({ code: 'x', pdf_storage_path: 'acme-2026/lease.pdf' }),
  })
  return POST(req, { params: Promise.resolve({ token: 'acme-2026' }) })
}

describe('lease sign route — a lease whose suite is no longer the company\'s', () => {
  beforeEach(() => vi.resetModules())

  it('a check violation becomes a clear 409 for the client', async () => {
    writeError = { code: '23514', message: 'Lease suite 3D-221 is not the company\'s suite (none assigned).' }
    const res = await sign()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/no longer valid/i)
  })

  it('any other database error is still a 500', async () => {
    writeError = { code: '08006', message: 'connection failure' }
    const res = await sign()
    expect(res.status).toBe(500)
  })

  it('a normal signature still succeeds', async () => {
    writeError = null
    const res = await sign()
    expect(res.status).toBe(200)
  })
})
