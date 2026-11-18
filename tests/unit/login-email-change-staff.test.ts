import { describe, it, expect, vi, beforeEach } from 'vitest'

// The staff change of a client's login email (dev job beb43385, step 3): the order of the steps, the refusals, the roll-back,
// and that BOTH addresses are told. Everything outside the file under test is replaced, so no database or mail is touched.

const CONTACT = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const updateUserById = vi.fn()
const contactsSelect = vi.fn()
const setContact = vi.fn()
const findLogins = vi.fn()
const findByEmail = vi.fn()
const findOwner = vi.fn()
const sendMail = vi.fn()
const audit = vi.fn()
const readContact = vi.fn()

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    auth: { admin: { updateUserById: (...a: unknown[]) => updateUserById(...a) } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => contactsSelect() }) }) }),
  },
}))
vi.mock('@/lib/auth-admin-helpers', () => ({
  findAuthUsersByContactId: (...a: unknown[]) => findLogins(...a),
  findAuthUserByEmail: (...a: unknown[]) => findByEmail(...a),
}))
vi.mock('@/lib/operations/contact-login-email', () => ({ setContactEmailForLoginChange: (...a: unknown[]) => setContact(...a) }))
vi.mock('@/lib/portal/login-email-owner', () => ({ findEmailOwner: (...a: unknown[]) => findOwner(...a) }))
vi.mock('@/lib/portal/login-email-change-db', () => ({
  audit: (...a: unknown[]) => audit(...a),
  readContact: (...a: unknown[]) => readContact(...a),
  greetingName: (c: { first_name?: string | null; full_name?: string | null } | null) => c?.first_name || c?.full_name || null,
}))
vi.mock('@/lib/portal/login-email-change-mail', async (orig) => ({
  ...(await orig<typeof import('@/lib/portal/login-email-change-mail')>()),
  sendLoginEmailChangeMail: (...a: unknown[]) => sendMail(...a),
}))

import { contactHasClientLogin, staffChangeLoginEmail, viewStaffLogin } from '@/lib/portal/login-email-change-staff'

const loginUser = (over: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'old.login@example.com',
  app_metadata: { role: 'client', contact_id: CONTACT },
  ...over,
})
const contactRow = (over: Record<string, unknown> = {}) => ({
  first_name: 'Maria',
  full_name: 'Maria Rossi',
  language: 'Italian',
  email: 'old.login@example.com',
  alt_emails: ['older@example.com'],
  ...over,
})
const run = (newEmail: unknown = 'New.Login@Example.com') => staffChangeLoginEmail({ contactId: CONTACT, newEmail, actor: 'dashboard:antonio', now: new Date('2026-11-18T15:00:00Z') })

beforeEach(() => {
  vi.clearAllMocks()
  findLogins.mockResolvedValue([loginUser()])
  findByEmail.mockResolvedValue(null)
  findOwner.mockResolvedValue(null)
  readContact.mockResolvedValue(contactRow())
  updateUserById.mockResolvedValue({ error: null })
  setContact.mockResolvedValue({ error: null })
  sendMail.mockResolvedValue('sent')
  audit.mockResolvedValue(undefined)
  contactsSelect.mockResolvedValue({ data: { full_name: 'Giulia Bianchi' } })
})

describe('staff change: the happy path', () => {
  it('moves the login by its own id, then the contact, then tells BOTH addresses, then writes the audit row', async () => {
    const r = await run()
    expect(r).toMatchObject({ ok: true, oldEmail: 'old.login@example.com', newEmail: 'new.login@example.com', noticeToNew: 'sent', noticeToOld: 'sent' })
    expect(updateUserById).toHaveBeenCalledTimes(1)
    expect(updateUserById).toHaveBeenCalledWith(USER_ID, { email: 'new.login@example.com', email_confirm: true })
    expect(setContact).toHaveBeenCalledTimes(1)
    expect(updateUserById.mock.invocationCallOrder[0]).toBeLessThan(setContact.mock.invocationCallOrder[0])
    expect(sendMail.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual(['new.login@example.com', 'old.login@example.com'])
    expect(audit).toHaveBeenCalledWith('portal_login_email_changed', 'dashboard:antonio', { authUserId: USER_ID, contactId: CONTACT }, expect.stringContaining('by staff'), expect.objectContaining({ by: 'staff', old_email: 'old.login@example.com', new_email: 'new.login@example.com' }))
  })

  it('keeps the old login address as an alternate, and the contact\'s own previous email when it differed', async () => {
    readContact.mockResolvedValue(contactRow({ email: 'crm.only@example.com' }))
    await run()
    expect(setContact).toHaveBeenCalledWith({ contactId: CONTACT, email: 'new.login@example.com', altEmails: ['older@example.com', 'old.login@example.com', 'crm.only@example.com'] })
  })

  it('writes the notes in the client\'s language (Italian contact → Italian notes)', async () => {
    await run()
    const toNew = (sendMail.mock.calls[0][0] as { email: { subject: string } }).email.subject
    const toOld = (sendMail.mock.calls[1][0] as { email: { subject: string } }).email.subject
    expect(toNew).toContain('aggiornata')
    expect(toOld).toContain('cambiata')
  })

  it('does NOT put a "This wasn\'t me" button in the note to the old address', async () => {
    await run()
    const html = (sendMail.mock.calls[1][0] as { email: { html: string } }).email.html
    expect(html).not.toContain('undo-email-change')
    expect(html).not.toContain('<a ')
    expect(html).toContain('support@tonydurante.us')
  })

  it('reports a note that could not be sent, instead of saying everything went out', async () => {
    sendMail.mockResolvedValueOnce('sent').mockResolvedValueOnce('send_failed')
    const r = await run()
    expect(r).toMatchObject({ ok: true, noticeToNew: 'sent', noticeToOld: 'send_failed' })
  })
})

describe('staff change: refusals change nothing', () => {
  const nothingChanged = () => {
    expect(updateUserById).not.toHaveBeenCalled()
    expect(setContact).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  }

  it('a bad email', async () => {
    expect(await run('not an email')).toMatchObject({ ok: false, code: 'invalid_email' })
    nothingChanged()
  })
  it('a contact id that is not an id', async () => {
    expect(await staffChangeLoginEmail({ contactId: 'x', newEmail: 'a@b.co', actor: 'a' })).toMatchObject({ ok: false, code: 'no_contact' })
    nothingChanged()
  })
  it('a contact that does not exist', async () => {
    readContact.mockResolvedValue(null)
    expect(await run()).toMatchObject({ ok: false, code: 'no_contact' })
    nothingChanged()
  })
  it('a contact with no client login', async () => {
    findLogins.mockResolvedValue([])
    expect(await run()).toMatchObject({ ok: false, code: 'no_login' })
    nothingChanged()
  })
  it('a partner login tied to the contact is not a client login', async () => {
    findLogins.mockResolvedValue([loginUser({ app_metadata: { role: 'partner', contact_id: CONTACT } })])
    expect(await run()).toMatchObject({ ok: false, code: 'no_login' })
    nothingChanged()
  })
  it('two client logins on one contact', async () => {
    findLogins.mockResolvedValue([loginUser(), loginUser({ id: 'x' })])
    expect(await run()).toMatchObject({ ok: false, code: 'several_logins' })
    nothingChanged()
  })
  it('a login with the contact\'s email that is NOT tied to this contact (a team login) is never moved from here', async () => {
    findLogins.mockResolvedValue([])
    findByEmail.mockResolvedValue({ id: 'team', email: 'old.login@example.com', app_metadata: { role: 'client' } })
    const r = await run()
    expect(r).toMatchObject({ ok: false, code: 'unlinked_login' })
    expect((r as { message: string }).message).toContain('not linked')
    nothingChanged()
  })
  it('the same email as today', async () => {
    expect(await run('OLD.login@example.com')).toMatchObject({ ok: false, code: 'same_email' })
    nothingChanged()
  })
  it('an email that is another contact\'s: staff are told WHO has it', async () => {
    findOwner.mockResolvedValue({ kind: 'contact', contactId: 'c2', column: 'email' })
    const r = await run()
    expect(r).toMatchObject({ ok: false, code: 'email_taken' })
    expect((r as { message: string }).message).toContain('Giulia Bianchi')
    nothingChanged()
  })
  it('an email that is another client\'s login: staff are told whose', async () => {
    findOwner.mockResolvedValue({ kind: 'login', authUserId: 'u2', contactId: 'c2', role: 'client' })
    const r = await run()
    expect((r as { message: string }).message).toContain('portal login of Giulia Bianchi')
    nothingChanged()
  })
  it('an email that is a login tied to no contact (team / marketing)', async () => {
    findOwner.mockResolvedValue({ kind: 'login', authUserId: 'u2', contactId: null, role: 'admin' })
    const r = await run()
    expect(r).toMatchObject({ ok: false, code: 'email_taken' })
    expect((r as { message: string }).message).toContain('not linked to a client contact')
    nothingChanged()
  })
  it('asks the clash rule with the login and the contact being changed as "me"', async () => {
    await run()
    expect(findOwner).toHaveBeenCalledWith('new.login@example.com', { authUserId: USER_ID, contactId: CONTACT })
  })
})

describe('staff change: when a step fails the two never drift apart', () => {
  it('login update fails → nothing else happens', async () => {
    updateUserById.mockResolvedValueOnce({ error: { message: 'Error updating user' } })
    expect(await run()).toMatchObject({ ok: false, code: 'failed' })
    expect(setContact).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
  it('contact update fails → the login is put back to the old email, no mail is sent', async () => {
    setContact.mockResolvedValue({ error: 'boom' })
    const r = await run()
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(updateUserById).toHaveBeenCalledTimes(2)
    expect(updateUserById).toHaveBeenLastCalledWith(USER_ID, { email: 'old.login@example.com', email_confirm: true })
    expect(sendMail).not.toHaveBeenCalled()
  })
  it('contact update THROWS → the login is put back too', async () => {
    setContact.mockRejectedValue(new Error('network'))
    expect(await run()).toMatchObject({ ok: false, code: 'failed' })
    expect(updateUserById).toHaveBeenLastCalledWith(USER_ID, { email: 'old.login@example.com', email_confirm: true })
  })
  it('contact fails AND the login cannot be put back → the message says to tell a developer NOW', async () => {
    setContact.mockResolvedValue({ error: 'boom' })
    updateUserById.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'down' } })
    const r = await run()
    expect((r as { message: string }).message).toContain('NOW')
  })
  it('an unexpected throw is a plain failure, never a crash', async () => {
    findLogins.mockRejectedValue(new Error('auth down'))
    expect(await run()).toMatchObject({ ok: false, code: 'failed' })
  })
})

describe('the lookups the CRM screens use', () => {
  it('viewStaffLogin shows the real login email, the contact email, the name and whether it is suspended', async () => {
    findLogins.mockResolvedValue([loginUser({ banned_until: '2999-01-01T00:00:00Z' })])
    expect(await viewStaffLogin(CONTACT)).toEqual({ state: 'linked', loginEmail: 'old.login@example.com', contactEmail: 'old.login@example.com', contactName: 'Maria Rossi', suspended: true })
  })
  it('viewStaffLogin says why there is no login, in plain words', async () => {
    findLogins.mockResolvedValue([])
    const v = await viewStaffLogin(CONTACT)
    expect(v).toMatchObject({ state: 'none' })
    expect((v as { message: string }).message).toContain('no client portal login')
  })
  it('viewStaffLogin never throws', async () => {
    findLogins.mockRejectedValue(new Error('down'))
    expect(await viewStaffLogin(CONTACT)).toMatchObject({ state: 'none' })
    expect(await viewStaffLogin('nope')).toMatchObject({ state: 'no_contact' })
  })
  it('contactHasClientLogin: true when linked, false when not, and FAILS SAFE (true) when it cannot tell', async () => {
    expect(await contactHasClientLogin(CONTACT)).toBe(true)
    findLogins.mockResolvedValue([])
    expect(await contactHasClientLogin(CONTACT)).toBe(false)
    findLogins.mockRejectedValue(new Error('down'))
    expect(await contactHasClientLogin(CONTACT)).toBe(true)
  })
})
