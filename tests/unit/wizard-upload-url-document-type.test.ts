/**
 * The wizard's document boxes (Articles, EIN letter, SS-4, passports) take a document or a picture only — enforced by the SERVER when it mints the
 * upload path (production end-to-end test 2026-11-10: the closure wizard took a ".txt" as the company's Articles). The file picker's `accept` can be
 * skipped, so this is the control. Other boxes stay open.
 */
import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'client@example.com' } } }) } }),
}))
vi.mock('@/lib/auth', () => ({ isClient: () => true }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { storage: { from: () => ({ upload: async () => ({ error: null }) }) } } }))

import { POST } from '@/app/api/portal/wizard-upload-url/route'
import { POST as POST_FORM } from '@/app/api/portal/wizard-upload/route'

const req = (body: Record<string, unknown>): NextRequest => ({ json: async () => body }) as unknown as NextRequest
const base = { wizard_type: 'closure', file_size: 1000 }

describe('POST /api/portal/wizard-upload-url — document boxes take documents and pictures only', () => {
  it('refuses a .txt as the Articles, with the sentence in both languages and no path minted', async () => {
    const res = await POST(req({ ...base, field_name: 'articles_of_organization', file_name: 'notes.txt' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/PDF/)
    expect(body.error).toMatch(/Questo campo/)
    expect(body.path).toBeUndefined()
  })

  it('refuses a .zip as the EIN letter and an .exe as a passport', async () => {
    expect((await POST(req({ ...base, field_name: 'ein_letter', file_name: 'a.zip' }))).status).toBe(400)
    expect((await POST(req({ ...base, field_name: 'passport_owner', file_name: 'a.exe' }))).status).toBe(400)
  })

  it('mints the path for a PDF, a phone photo and a Word file', async () => {
    for (const f of ['Articles.pdf', 'IMG_0001.HEIC', 'scan.jpg', 'letter.docx']) {
      const res = await POST(req({ ...base, field_name: 'articles_of_organization', file_name: f }))
      expect(res.status).toBe(200)
    }
  })

  it('leaves the other boxes open (any file in "other documents")', async () => {
    const res = await POST(req({ ...base, field_name: 'other_documents', file_name: 'notes.txt' }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/portal/wizard-upload (form upload) — same rule', () => {
  it('refuses a .txt in the Articles box before storing anything', async () => {
    const fd = new FormData()
    fd.append('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    fd.append('field_name', 'articles_of_organization')
    fd.append('wizard_type', 'closure')
    const res = await POST_FORM({ formData: async () => fd } as unknown as NextRequest)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/PDF/)
  })
})
