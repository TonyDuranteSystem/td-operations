import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUser, resolveIdentity, updateUserById } = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolveIdentity: vi.fn(),
  updateUserById: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    auth: { admin: { updateUserById } },
    storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) },
  },
}))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: resolveIdentity }))

import { POST as onboardingComplete } from '@/app/api/portal/onboarding-complete/route'
import { POST as wizardUploadUrl } from '@/app/api/portal/wizard-upload-url/route'
import { POST as wizardUpload } from '@/app/api/portal/wizard-upload/route'

const teamLogin = { id: 'u-team', email: 'tm-x@teammate.portal.tonydurante.us', app_metadata: { role: 'client', kind: 'team_member', account_id: 'ACC-X' }, user_metadata: { must_change_password: true } }
const clientLogin = { id: 'u-client', email: 'c@example.com', app_metadata: { role: 'client', contact_id: 'C1' }, user_metadata: { must_change_password: true } }
const teammateIdentity = { kind: 'teammate', teamMemberId: 'tm-1', accountId: 'ACC-X', displayName: 'T', email: null, capabilities: { documents: true } }
const contactIdentity = { kind: 'contact', contactId: 'C1', accountIds: ['ACC-X'] }

const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as import('next/server').NextRequest
const formReq = (fields: Record<string, string> = {}) =>
  ({ formData: async () => ({ get: (k: string) => fields[k] ?? null }) }) as unknown as import('next/server').NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  updateUserById.mockResolvedValue({ error: null })
})

describe('POST /api/portal/onboarding-complete — team login keeps its temporary password until it sets its own', () => {
  it('REFUSES a team login clearing the "set your own password" flag', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    const res = await onboardingComplete(jsonReq({ clear_password_flag: true }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('still lets a normal client clear the flag (email reset flow)', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    const res = await onboardingComplete(jsonReq({ clear_password_flag: true }))
    expect(res.status).toBe(200)
    expect(updateUserById).toHaveBeenCalledWith('u-client', { user_metadata: expect.objectContaining({ must_change_password: false }) })
  })

  it('still lets a team login mark onboarding complete (no password flag involved)', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    const res = await onboardingComplete(jsonReq({}))
    expect(res.status).toBe(200)
  })
})

const teamWithTick = (caps: Record<string, boolean>) => ({ ...teammateIdentity, capabilities: caps })
const uploadBody = (over: Record<string, unknown> = {}) => ({ field_name: 'ein_letter', file_name: 'a.pdf', wizard_type: 'banking_payset', identifier: 'OTHER-ACCOUNT', ...over })

describe('wizard file uploads — a team login uploads only for a wizard its tick covers, into its own company only', () => {
  it('wizard-upload-url refuses a team login with NO ticks', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(teammateIdentity)
    const res = await wizardUploadUrl(jsonReq(uploadBody({ wizard_type: 'tax' })))
    expect(res.status).toBe(403)
  })

  it('wizard-upload-url refuses the tax wizard even with every tick', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(teamWithTick({ bank_applications: true, company_data_form: true }))
    const res = await wizardUploadUrl(jsonReq(uploadBody({ wizard_type: 'tax' })))
    expect(res.status).toBe(403)
  })

  it('wizard-upload-url with the Bank applications tick files into the login\'s OWN company, ignoring the company the browser names', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(teamWithTick({ bank_applications: true }))
    const res = await wizardUploadUrl(jsonReq(uploadBody()))
    expect(res.status).toBe(200)
    const path = (await res.json()).path as string
    expect(path).toMatch(/^banking_payset\/ACC-X\/ein_letter_/)
    expect(path).not.toContain('OTHER-ACCOUNT')
  })

  it('wizard-upload refuses a team login with NO ticks before reading any file', async () => {
    getUser.mockResolvedValue({ data: { user: teamLogin } })
    resolveIdentity.mockResolvedValue(teammateIdentity)
    const res = await wizardUpload(formReq({ wizard_type: 'tax' }))
    expect(res.status).toBe(403)
  })

  it('wizard-upload-url still serves a normal client, unchanged', async () => {
    getUser.mockResolvedValue({ data: { user: clientLogin } })
    resolveIdentity.mockResolvedValue(contactIdentity)
    const res = await wizardUploadUrl(jsonReq(uploadBody({ wizard_type: 'onboarding', identifier: 'ACC-X' })))
    expect(res.status).toBe(200)
    expect((await res.json()).path).toMatch(/^onboarding\/ACC-X\/ein_letter_/)
  })
})
