/**
 * Team Powers bug hunt, batch 1 — six doors that were left open (dev job e59dd470, 20 Nov hunt; Antonio "do all of them", 23 Nov):
 *   1. the formation page shows its one-time "add your members" link to a team login (token + code are the whole credential);
 *   2. "report an issue" files a High-priority task under ANY company id the caller types;
 *   3. the test-alert button works for a team login with no Chat power (or one still waiting for its notice);
 *   4. a TD invoice PDF opens by id past a team login's history start date;
 *   5. opening an owner's shared passport / ID leaves no trace;
 *   6. the staff chat-attach tool can put a PERSONAL paper into a company thread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { User } from '@supabase/supabase-js'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const h = vi.hoisted(() => ({
  docs: [] as Array<Record<string, unknown>>,
  audit: [] as Array<Record<string, unknown>>,
  sharedOwners: [] as Array<{ contactId: string; accountId: string | null }>,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.limit = () => c
      c.not = () => c
      c.single = async () => ({ data: table === 'documents' ? h.docs[0] ?? null : null, error: null })
      c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === 'documents' ? h.docs : [], error: null }).then(res, rej)
      return c
    },
  },
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/portal/audit', () => ({ logPortalAction: (e: Record<string, unknown>) => { h.audit.push(e) } }))
vi.mock('@/lib/portal/team/personal-docs-server', () => ({ getSharedPersonalDocOwners: async () => h.sharedOwners }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', app_metadata: { role: 'client', kind: 'team_member' } } } }) } }) }))
vi.mock('@/lib/portal-auth', () => ({ getClientContactId: () => null, getClientAccountIds: async () => [] }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: async () => false }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => ({ buffer: Buffer.from('x'), mimeType: 'application/pdf', fileName: 'a.pdf' }), downloadFileBinaryForSend: vi.fn(), getFileMetadata: vi.fn() }))
vi.mock('@/lib/documents/open-document', () => ({ classifyPointer: (id: string) => (id.startsWith('store:') ? 'store' : 'drive'), openDocument: vi.fn() }))

import { accountIdForIssueReport, type ReportScopeDeps } from '@/lib/portal/report-issue-scope'
import { mayTestPushForAccount } from '@/lib/portal/push-test-access'
import { teammateMayOpenPayment } from '@/lib/portal/team/history'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const user = (app: Record<string, unknown>) => ({ id: 'u1', app_metadata: app }) as unknown as User
const team = (caps: Record<string, boolean>, over: Record<string, unknown> = {}) =>
  ({ kind: 'teammate', teamMemberId: 't1', accountId: 'A1', displayName: 'T', email: null, capabilities: caps, createdAt: '2026-06-01T00:00:00Z', ...over }) as unknown as PortalIdentity

beforeEach(() => { h.docs = []; h.audit = []; h.sharedOwners = [] })

describe('1. formation page: no "add your members" link for a team login', () => {
  const page = read('app/portal/flows/[id]/page.tsx')
  it('the link is only built for a viewer who is not a team login, and chat links stay hidden for the same viewer', () => {
    expect(page).toContain("const teamLoginViewer = !contactId && (user.app_metadata as Record<string, unknown> | undefined)?.kind === 'team_member'")
    expect(page).toContain("if (!teamLoginViewer && sd.service_type === 'Company Formation' && sd.account_id) {")
    expect(page).toContain('teamLoginViewer ? hideCredentialLinks(allMessages) : allMessages')
  })
})

describe('2. report-issue: the company must really be the caller\'s', () => {
  const deps = (over: Partial<ReportScopeDeps> = {}): ReportScopeDeps => ({
    getContactId: () => null,
    getAccountIds: async () => [],
    resolveIdentity: async () => ({ kind: 'none' }) as PortalIdentity,
    ...over,
  })
  it('staff may name any company (as before)', async () => {
    expect(await accountIdForIssueReport(user({ role: 'admin' }), 'ANY', deps())).toBe('ANY')
  })
  it('a client with a contact keeps only a company linked to that contact', async () => {
    const d = deps({ getContactId: () => 'c1', getAccountIds: async () => ['A1', 'A2'] })
    expect(await accountIdForIssueReport(user({ role: 'client', contact_id: 'c1' }), 'A2', d)).toBe('A2')
    expect(await accountIdForIssueReport(user({ role: 'client', contact_id: 'c1' }), 'OTHER', d)).toBeNull()
  })
  it('a team login keeps only its OWN company, whatever powers it has (a login with none can still report a problem)', async () => {
    const d = deps({ resolveIdentity: async () => team({}) })
    expect(await accountIdForIssueReport(user({ role: 'client', kind: 'team_member' }), 'A1', d)).toBe('A1')
    expect(await accountIdForIssueReport(user({ role: 'client', kind: 'team_member' }), 'OTHER', d)).toBeNull()
  })
  it('a client with no portal identity, and anything that is not a plain id, gets no company (the report is still saved)', async () => {
    expect(await accountIdForIssueReport(user({ role: 'client' }), 'A1', deps())).toBeNull()
    for (const bad of [undefined, null, '', 42, 'x'.repeat(65)]) expect(await accountIdForIssueReport(user({ role: 'admin' }), bad, deps())).toBeNull()
  })
  it('the route uses it for the lookup, the issue row and the task', () => {
    const route = read('app/api/portal/report-issue/route.ts')
    expect(route).toContain('const account_id = await accountIdForIssueReport(user, requestedAccountId)')
  })
})

describe('3. test alert: a team login needs the Chat power', () => {
  it('own company + Chat power may; no powers, only Documents, or waiting for its notice (powers emptied) may not; another company never', () => {
    expect(mayTestPushForAccount(team({ chat: true }), 'A1')).toBe(true)
    expect(mayTestPushForAccount(team({}), 'A1')).toBe(false)
    expect(mayTestPushForAccount(team({ documents: true }), 'A1')).toBe(false)
    expect(mayTestPushForAccount(team({}, { noticePending: true }), 'A1')).toBe(false)
    expect(mayTestPushForAccount(team({ chat: true }), 'A2')).toBe(false)
  })
})

describe('4. TD invoice PDF follows a team login\'s start date', () => {
  const login = (caps: Record<string, boolean>) => ({ createdAt: '2026-06-01T00:00:00Z', capabilities: caps })
  it('a settled invoice from BEFORE the login joined is hidden; one from after, or still owed, stays visible', () => {
    expect(teammateMayOpenPayment(login({}), { created_at: '2026-01-10T00:00:00Z', status: 'Paid' })).toBe(false)
    expect(teammateMayOpenPayment(login({}), { created_at: '2026-07-10T00:00:00Z', status: 'Paid' })).toBe(true)
    expect(teammateMayOpenPayment(login({}), { created_at: '2026-01-10T00:00:00Z', status: 'Pending' })).toBe(true)
    expect(teammateMayOpenPayment(login({}), { created_at: '2026-01-10T00:00:00Z', status: 'Overdue' })).toBe(true)
  })
  it('with the "see earlier invoices" tick, or with no known start date, everything is visible', () => {
    expect(teammateMayOpenPayment(login({ invoice_history: true }), { created_at: '2020-01-01T00:00:00Z', status: 'Paid' })).toBe(true)
    expect(teammateMayOpenPayment({ createdAt: null, capabilities: {} }, { created_at: '2020-01-01T00:00:00Z', status: 'Paid' })).toBe(true)
  })
  it('the PDF route applies it to a team login and answers "not found"', () => {
    const route = read('app/api/portal/payments/[id]/pdf/route.ts')
    expect(route).toContain('teammateMayOpenPayment({ createdAt: identity.createdAt, capabilities: identity.capabilities }')
    expect(route).toContain("{ error: 'Invoice not found' }, { status: 404 }")
  })
})

describe('5. opening an owner\'s shared paper leaves a line in the audit log', () => {
  const call = async (doc: Record<string, unknown>, access: boolean) => {
    h.docs = [doc]
    vi.doMock('@/lib/portal/team/gate', () => ({ canAccessAccount: async () => access }))
    vi.resetModules()
    const { GET } = await import('@/app/api/portal/documents/[id]/route')
    return GET(new Request('http://x/api/portal/documents/d1', { headers: { 'x-forwarded-for': '7.7.7.7' } }) as never, { params: { id: 'd1' } })
  }
  const sharedPassport = { id: 'd1', file_name: 'passport.pdf', account_id: null, contact_id: 'owner1', category: 2, drive_file_id: 'drive1', portal_visible: true, service_delivery_id: null, flow_stage: null, created_at: '2026-01-01T00:00:00Z', visible_to_new_owners: null }
  it('the route logs a shared-document open (who, whose paper, which document, from where) without blocking the open', () => {
    const route = read('app/api/portal/documents/[id]/route.ts')
    expect(route).toContain("action: 'shared_document_opened'")
    expect(route).toContain('!contactId && isPersonal && doc.contact_id && sharedFrom.includes(doc.contact_id)')
    expect(route).toContain("import { logPortalAction } from '@/lib/portal/audit'")
  })
  it('a team login opening a SHARED passport writes one audit line', async () => {
    h.sharedOwners = [{ contactId: 'owner1', accountId: null }]
    await call(sharedPassport, false)
    expect(h.audit).toHaveLength(1)
    expect(h.audit[0]).toMatchObject({ user_id: 'u1', action: 'shared_document_opened', ip: '7.7.7.7' })
    expect(JSON.parse(String(h.audit[0].detail))).toEqual({ document_id: 'd1', owner_contact_id: 'owner1' })
  })
  it('an ordinary company document opened by a team login writes none; a paper nobody shared is refused and writes none', async () => {
    await call({ ...sharedPassport, id: 'd2', category: 1, account_id: 'A1', contact_id: null }, true)
    expect(h.audit).toEqual([])
    h.sharedOwners = []
    const res = await call(sharedPassport, false)
    expect(res.status).toBe(403)
    expect(h.audit).toEqual([])
  })
})

describe('6. the staff chat-attach tool never puts a PERSONAL paper into a company thread', () => {
  type Handler = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
  async function tool(): Promise<Handler> {
    vi.resetModules()
    const handlers: Record<string, Handler> = {}
    const { registerPortalTools } = await import('@/lib/mcp/tools/portal')
    registerPortalTools({ tool: (...args: unknown[]) => { handlers[args[0] as string] = args[args.length - 1] as Handler } } as never)
    return handlers.portal_chat_attach_file
  }
  it('a stored file of category 2 (personal) is refused for a company thread, with a plain reason', async () => {
    h.docs = [{ id: 'd1', category: 2, contact_id: 'c1' }]
    const r = await (await tool())({ source: 'drive', file_id: 'store:abc', account_id: 'A1' })
    expect(r.content[0].text).toMatch(/PERSONAL paper/)
  })
  it('a stored file that is not one of the account\'s documents is still refused (as before)', async () => {
    h.docs = []
    const r = await (await tool())({ source: 'drive', file_id: 'store:abc', account_id: 'A1' })
    expect(r.content[0].text).toMatch(/isn't one of that account's own documents/)
  })
  it('a contact-only thread: the stored file must be one of THAT contact\'s own documents', async () => {
    h.docs = []
    const r = await (await tool())({ source: 'drive', file_id: 'store:abc', contact_id: 'c1' })
    expect(r.content[0].text).toMatch(/isn't one of that contact's own documents/)
  })
})
