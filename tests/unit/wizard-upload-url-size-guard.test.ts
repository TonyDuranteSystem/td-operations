/**
 * The wizard-upload-url mint endpoint must reject an oversized file with a
 * clear, user-facing message BEFORE minting a storage path — the
 * authoritative server-side half of the max-file-size check (the browser's
 * own pre-check can be bypassed). dev_task: Turcanu/Tacoli passport
 * investigation — a client had no way to know their upload was too large
 * until it silently failed downstream, days later, invisibly.
 */
import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'client@example.com' } } }),
    },
  }),
}))

vi.mock('@/lib/auth', () => ({ isClient: () => true }))

import { POST } from '@/app/api/portal/wizard-upload-url/route'
import { WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES } from '@/lib/portal/wizard-uploads'

function req(body: Record<string, unknown>): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

describe('POST /api/portal/wizard-upload-url — file size guard', () => {
  it('rejects a file over the max size with a clear message, before minting a path', async () => {
    const res = await POST(
      req({
        field_name: 'passport_owner',
        file_name: 'passport.png',
        file_size: WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES + 1,
        wizard_type: 'formation',
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/too large/i)
    expect(body.error).toMatch(/100 MB/)
    expect(body.path).toBeUndefined()
  })

  it('mints a path normally when file_size is under the max', async () => {
    const res = await POST(
      req({
        field_name: 'passport_owner',
        file_name: 'passport.png',
        file_size: 5 * 1024 * 1024,
        wizard_type: 'formation',
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toContain('passport_owner')
  })

  it('mints a path normally when file_size is omitted (older client / non-size caller)', async () => {
    const res = await POST(
      req({
        field_name: 'passport_owner',
        file_name: 'passport.png',
        wizard_type: 'formation',
      }),
    )
    expect(res.status).toBe(200)
  })

  it('accepts a file exactly at the max size', async () => {
    const res = await POST(
      req({
        field_name: 'passport_owner',
        file_name: 'passport.png',
        file_size: WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES,
        wizard_type: 'formation',
      }),
    )
    expect(res.status).toBe(200)
  })
})
