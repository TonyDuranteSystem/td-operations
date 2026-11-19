import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// The staff screens and the routes around the staff change of a client's login email (dev job beb43385, step 3).

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ─── the two notes ───────────────────────────────────────────────────────────────────────────────
import { buildStaffChangedNewEmail, buildStaffChangedOldEmail } from '@/lib/portal/login-email-change-mail'

describe('the notes for a staff change', () => {
  const base = { fullName: 'Maria <Rossi>', oldEmail: 'old@example.com', newEmail: 'new@example.com' }
  it('new address (EN): says the sign-in email changed, password unchanged, and links to the portal login', () => {
    const m = buildStaffChangedNewEmail({ ...base, locale: 'en', loginUrl: 'https://portal.example/portal/login' })
    expect(m.subject).toBe('Your portal login email was updated')
    expect(m.html).toContain('new@example.com')
    expect(m.html).toContain('Your password has not changed.')
    expect(m.html).toContain('href="https://portal.example/portal/login"')
    expect(m.html).toContain('Maria &lt;Rossi&gt;') // escaped
  })
  it('new address (IT) is in Italian', () => {
    const m = buildStaffChangedNewEmail({ ...base, locale: 'it', loginUrl: 'https://portal.example/portal/login' })
    expect(m.subject).toContain('aggiornata')
    expect(m.html).toContain('La password non è cambiata.')
  })
  it('old address (EN): names both emails and the day, and has NO button and NO link of any kind', () => {
    const m = buildStaffChangedOldEmail({ ...base, locale: 'en', changedAt: new Date('2026-11-18T15:00:00Z') })
    expect(m.subject).toBe('Your portal login email was changed by our team')
    expect(m.html).toContain('old@example.com')
    expect(m.html).toContain('new@example.com')
    expect(m.html).toContain('18 Nov 2026')
    expect(m.html).not.toContain('<a ')
    expect(m.html).not.toContain('href')
    expect(m.html).toContain('support@tonydurante.us')
  })
  it('old address (IT) is in Italian and also has no link', () => {
    const m = buildStaffChangedOldEmail({ ...base, locale: 'it', changedAt: new Date('2026-11-18T15:00:00Z') })
    expect(m.html).toContain('18 novembre 2026')
    expect(m.html).not.toContain('href')
  })
})

// ─── the Email box on the contact page ──────────────────────────────────────────────────────────
const updateWithLock = vi.fn()
const contactHasClientLogin = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'antonio@x.com' } } }) }, from: () => ({ insert: () => Promise.resolve({}) }) }) }))
vi.mock('@/lib/server-action', () => ({
  updateWithLock: (...a: unknown[]) => updateWithLock(...a),
  safeAction: async (fn: () => Promise<unknown>) => { try { return { success: true, data: await fn() } } catch (e) { return { success: false, error: (e as Error).message } } },
}))
vi.mock('@/lib/portal/login-email-change-staff', () => ({ contactHasClientLogin: (...a: unknown[]) => contactHasClientLogin(...a) }))

import { updateContactField } from '@/app/(dashboard)/contacts/[id]/actions'
import { LOGIN_LINKED_ERROR } from '@/lib/portal/login-email-change-staff-shared'

describe('the contact page Email box when the contact HAS a portal login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateWithLock.mockResolvedValue({ success: true })
  })
  it('does NOT change the contact alone: it hands back the marker so the screen opens "Change login email"', async () => {
    contactHasClientLogin.mockResolvedValue(true)
    const r = await updateContactField('c1', 'email', 'new@example.com', 't')
    expect(r).toEqual({ success: false, error: LOGIN_LINKED_ERROR })
    expect(updateWithLock).not.toHaveBeenCalled()
  })
  it('a contact WITHOUT a login saves the email as before', async () => {
    contactHasClientLogin.mockResolvedValue(false)
    expect((await updateContactField('c1', 'email', 'new@example.com', 't')).success).toBe(true)
    expect(updateWithLock).toHaveBeenCalledWith('contacts', 'c1', { email: 'new@example.com' }, 't')
  })
  it('other fields are untouched by the guard (no lookup, saved as before), the second email included', async () => {
    contactHasClientLogin.mockResolvedValue(true)
    expect((await updateContactField('c1', 'phone', '123', 't')).success).toBe(true)
    expect((await updateContactField('c1', 'email_2', 'two@example.com', 't')).success).toBe(true)
    expect(contactHasClientLogin).not.toHaveBeenCalled()
  })
})

// ─── the route ──────────────────────────────────────────────────────────────────────────────────
const getUser = vi.fn()
const isAdmin = vi.fn()
const staffChange = vi.fn()
const viewLogin = vi.fn()
vi.mock('@/lib/auth', () => ({ isAdmin: (...a: unknown[]) => isAdmin(...a) }))

describe('the staff route', () => {
  beforeEach(() => {
    vi.resetModules()
    getUser.mockReset(); isAdmin.mockReset(); staffChange.mockReset(); viewLogin.mockReset()
    vi.doMock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: () => getUser() } }) }))
    vi.doMock('@/lib/portal/login-email-change-staff', () => ({
      staffChangeLoginEmail: (...a: unknown[]) => staffChange(...a),
      viewStaffLogin: (...a: unknown[]) => viewLogin(...a),
    }))
  })
  const req = (body?: unknown, url = 'http://x/api/crm/admin-actions/contact-login-email?contact_id=c1') =>
    ({ nextUrl: new URL(url), json: async () => body ?? {} }) as never

  it('GET and POST refuse anyone who is not an admin, and call nothing', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'client@x.com' } } })
    isAdmin.mockReturnValue(false)
    const { GET, POST } = await import('@/app/api/crm/admin-actions/contact-login-email/route')
    expect((await GET(req())).status).toBe(403)
    expect((await POST(req({ contact_id: 'c1', new_email: 'a@b.co' }))).status).toBe(403)
    expect(staffChange).not.toHaveBeenCalled()
    expect(viewLogin).not.toHaveBeenCalled()
  })
  it('POST passes the contact, the new email and the staff member\'s name to the change', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'antonio@tonydurante.us' } } })
    isAdmin.mockReturnValue(true)
    staffChange.mockResolvedValue({ ok: true, oldEmail: 'o@x.com', newEmail: 'n@x.com', noticeToNew: 'sent', noticeToOld: 'sent' })
    const { POST } = await import('@/app/api/crm/admin-actions/contact-login-email/route')
    const res = await POST(req({ contact_id: 'c1', new_email: 'n@x.com' }))
    expect(staffChange).toHaveBeenCalledWith({ contactId: 'c1', newEmail: 'n@x.com', actor: 'dashboard:antonio' })
    expect(await res.json()).toEqual({ ok: true, old_email: 'o@x.com', new_email: 'n@x.com', notice_to_new: 'sent', notice_to_old: 'sent' })
  })
  it('POST turns each refusal into a status and plain words for staff', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'antonio@tonydurante.us' } } })
    isAdmin.mockReturnValue(true)
    const { POST } = await import('@/app/api/crm/admin-actions/contact-login-email/route')
    for (const [code, status] of [['email_taken', 400], ['invalid_email', 400], ['no_contact', 404], ['failed', 500]] as const) {
      staffChange.mockResolvedValueOnce({ ok: false, code, message: `words for ${code}` })
      const res = await POST(req({ contact_id: 'c1', new_email: 'n@x.com' }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ ok: false, code, error: `words for ${code}` })
    }
  })
  it('GET returns what the dialog shows', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'antonio@tonydurante.us' } } })
    isAdmin.mockReturnValue(true)
    viewLogin.mockResolvedValue({ state: 'linked', loginEmail: 'l@x.com', contactEmail: 'c@x.com', contactName: 'M R', suspended: false })
    const { GET } = await import('@/app/api/crm/admin-actions/contact-login-email/route')
    expect(await (await GET(req())).json()).toMatchObject({ state: 'linked', loginEmail: 'l@x.com' })
    expect(viewLogin).toHaveBeenCalledWith('c1')
  })
})

// ─── the screens (source checks: the wiring that must not be lost) ──────────────────────────────
describe('the screens', () => {
  const dialog = read('components/contacts/change-login-email-staff-dialog.tsx')
  it('the dialog has the big red block with the tick, says "right now, with no code", and a grey button until ticked', () => {
    expect(dialog).toContain("import { MustReadBlock } from '@/components/portal/must-read-block'")
    expect(dialog).toContain('Read well before proceeding.')
    expect(dialog).toContain('I read it')
    expect(dialog).toContain('right now, with no code.')
    expect(dialog).toContain('stays signed in.')
    expect(dialog).toContain('Send new password')
    expect(dialog).toContain("if (!read) { setTried(true); return }")
    expect(dialog).toContain('bg-zinc-200')
  })
  it('the dialog shows the REAL login email and says when the contact record differs', () => {
    expect(dialog).toContain('staff-current-login-email')
    expect(dialog).toContain('The contact record has a different email')
  })
  it('the Portal tab has the button, the real login email, and an amber contact email when they differ', () => {
    const detail = read('components/contacts/contact-detail.tsx')
    expect(detail).toContain('data-testid="change-login-email-button"')
    expect(detail).toContain('data-testid="portal-login-email"')
    expect(detail).toContain('data-testid="portal-contact-email"')
    expect(detail).toContain('onChangeLoginEmail={() => setLoginEmailDialog({})}')
  })
  it('both Email boxes open the dialog when the server says the contact has a login', () => {
    for (const f of ['components/contacts/contact-detail.tsx', 'components/accounts/account-detail.tsx']) {
      const src = read(f)
      expect(src, f).toContain('LOGIN_LINKED_ERROR')
      expect(src, f).toContain('ChangeLoginEmailStaffDialog')
      expect(src, f).toContain("field === 'email' && !result.success && result.error === LOGIN_LINKED_ERROR")
    }
  })
  it('both server actions guard the email field the same way', () => {
    for (const f of ['app/(dashboard)/contacts/[id]/actions.ts', 'app/(dashboard)/accounts/actions.ts']) {
      const src = read(f)
      expect(src, f).toContain("field === 'email' && await contactHasClientLogin(contactId)")
      expect(src, f).toContain('LOGIN_LINKED_ERROR')
    }
  })
  it('the contact page asks for the login email by the CONTACT id, not by email', () => {
    const page = read('app/(dashboard)/contacts/[id]/page.tsx')
    expect(page).toContain('findAuthUsersByContactId(params.id)')
  })
})

// ─── the rules the client change and the staff change share ──────────────────────────────────────
describe('one clash rule for both', () => {
  it('the client service asks the shared rule (login-email-owner), not its own copy', () => {
    const svc = read('lib/portal/login-email-change-service.ts')
    expect(svc).toContain("import { findEmailOwner } from \"@/lib/portal/login-email-owner\"")
    expect(svc).not.toContain('likeEscape')
  })
  it('the staff change never writes the client\'s code/undo table', () => {
    const staff = read('lib/portal/login-email-change-staff.ts')
    expect(staff).not.toMatch(/from\(\s*["']portal_login_email_changes/)
    expect(staff).not.toContain('generateUndoToken')
    expect(staff).not.toContain('undoUrl')
  })
})
