import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The two Annual Report / RA filing routes (review findings before the suite go-live):
 *  - /api/calendar/file-renewal is STAFF ONLY (a logged-in portal client must not be able to file for any company);
 *  - /api/crm/renewal/file must answer an ERROR when fileRenewal reports { success: false } — never "ok" for a filing that
 *    did not happen (the To-Do card would be closed with nothing filed).
 */

let authUser: { id: string; app_metadata?: Record<string, unknown> } | null
const fileRenewalMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }) }))
vi.mock('@/lib/auth', () => ({
  isDashboardUser: (u: { app_metadata?: { role?: string } } | null) => !!u && u.app_metadata?.role !== 'client',
}))
vi.mock('@/lib/operations/file-renewal', () => ({ fileRenewal: (...a: unknown[]) => fileRenewalMock(...a) }))

const pdf = () => new File([new Uint8Array([1, 2, 3])], 'r.pdf', { type: 'application/pdf' })

beforeEach(() => {
  vi.clearAllMocks()
  authUser = { id: 'staff-1', app_metadata: { role: 'admin' } }
})

describe('POST /api/calendar/file-renewal', () => {
  async function call() {
    const { POST } = await import('@/app/api/calendar/file-renewal/route')
    const fd = new FormData()
    fd.set('account_id', 'a1'); fd.set('kind', 'ar'); fd.set('filed_date', '2026-10-02')
    fd.set('principal_office', JSON.stringify({ changed: false }))
    fd.set('receipt', pdf())
    return POST(new NextRequest('http://localhost/api/calendar/file-renewal', { method: 'POST', body: fd }))
  }

  it('401 when nobody is logged in', async () => {
    authUser = null
    expect((await call()).status).toBe(401)
    expect(fileRenewalMock).not.toHaveBeenCalled()
  })

  it('403 for a logged-in portal CLIENT — nothing is filed', async () => {
    authUser = { id: 'client-1', app_metadata: { role: 'client' } }
    const res = await call()
    expect(res.status).toBe(403)
    expect(fileRenewalMock).not.toHaveBeenCalled()
  })

  it('staff can file', async () => {
    fileRenewalMock.mockResolvedValue({ success: true, data: { delivery_id: 'd1' } })
    const res = await call()
    expect(res.status).toBe(200)
    expect(fileRenewalMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/crm/renewal/file (the To-Do card)', () => {
  async function call() {
    const { POST } = await import('@/app/api/crm/renewal/file/route')
    return POST(new NextRequest('http://localhost/api/crm/renewal/file', {
      method: 'POST',
      body: JSON.stringify({
        account_id: 'a1', kind: 'ar', filed_date: '2026-10-02', principal_office: { changed: false },
        receipt: { file_name: 'r.pdf', mime_type: 'application/pdf', data_base64: Buffer.from('x').toString('base64') },
      }),
    }))
  }

  it('answers an ERROR (not 200 ok) when the filing failed', async () => {
    fileRenewalMock.mockResolvedValue({ success: false, error: 'No Drive folder for this account' })
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/No Drive folder/)
  })

  it('answers ok and carries the principal-office warning when the filing worked', async () => {
    fileRenewalMock.mockResolvedValue({ success: true, data: { delivery_id: 'd1', principal_office_warning: 'could not save the address' } })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.principal_office_warning).toBe('could not save the address')
  })
})
