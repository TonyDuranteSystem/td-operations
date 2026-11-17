/**
 * "Start a new company" — the server steps (lib/operations/start-new-company.ts), dev job bf9886a3, run against an in-memory
 * stand-in for the database. Pinned here, each one a bug the bug-hunter review found or a rule the design depends on:
 *   - the OLD formation job is cancelled LAST, and only when every step before it worked, so a press that stopped half-way is
 *     finished by pressing again (the button keeps listing the company);
 *   - the client is told only when the wizard and the old company are ready, and told once;
 *   - a second press never wipes a wizard the client has typed in since;
 *   - the saved wizard is found under the offer's lead OR the offer (the two keys the portal and its reminders use);
 *   - the button only lists the formation THIS person bought;
 *   - a delinquent invoice or a lease out for signature blocks, like the other open states;
 *   - what needs a person is written into the notes, not only shown in the pop-up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state = {
    db: {} as Record<string, Row[]>,
    events: [] as string[],
    inject: [] as Array<{ table: string; mode: string; message: string }>,
    nextId: 1,
    createSDCalls: 0,
    messages: [] as Row[],
    /** Notification types whose next save fails; e-mail failure switch. */
    bellFail: [] as string[],
    emailFail: false,
    bells: [] as string[],
  }

  type Result = { data: unknown; error: { message: string } | null; count?: number | null }

  class Query implements PromiseLike<Result> {
    private filters: Array<(r: Row) => boolean> = []
    private wantRows = false
    private countOn = false
    private head = false
    private max: number | null = null
    private orderBy: { col: string; asc: boolean } | null = null
    constructor(private table: string, private mode: 'select' | 'update' | 'insert', private payload?: Row) {}
    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      this.wantRows = true
      if (opts?.count) this.countOn = true
      if (opts?.head) this.head = true
      return this
    }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
    neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
    not(c: string, _op: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) !== v); return this }
    order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this }
    limit(n: number) { this.max = n; return this }
    maybeSingle() { return this.run().then((res) => ({ ...res, data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data })) }
    single() { return this.maybeSingle() }
    then<A, B>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) { return this.run().then(ok, bad) }
    private async run(): Promise<Result> {
      const hit = state.inject.findIndex((i) => i.table === this.table && i.mode === this.mode)
      if (hit >= 0) {
        const [i] = state.inject.splice(hit, 1)
        return { data: null, error: { message: i.message } }
      }
      const rows = (state.db[this.table] ??= [])
      if (this.mode === 'insert') {
        const row = { id: `${this.table}-${state.nextId++}`, ...(this.payload ?? {}) }
        rows.push(row)
        if (this.table === 'portal_messages') { state.events.push('message'); state.messages.push(row) }
        return { data: this.wantRows ? [{ id: row.id }] : null, error: null }
      }
      let hits = rows.filter((r) => this.filters.every((f) => f(r)))
      if (this.mode === 'update') {
        for (const r of hits) Object.assign(r, this.payload)
        if (this.table === 'accounts' && this.payload?.status === 'Closed') state.events.push('close-account')
        return { data: this.wantRows ? hits.map((r) => ({ id: r.id })) : null, error: null }
      }
      if (this.orderBy) {
        const { col, asc } = this.orderBy
        hits = [...hits].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (asc ? 1 : -1))
      }
      if (this.max !== null) hits = hits.slice(0, this.max)
      return { data: this.head ? null : hits, error: null, count: this.countOn ? hits.length : null }
    }
  }

  return { state, Query }
})

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => new h.Query(table, 'select').select(cols, opts),
      update: (payload: Row) => new h.Query(table, 'update', payload),
      insert: (payload: Row) => new h.Query(table, 'insert', payload),
    }),
  },
}))

vi.mock('@/lib/operations/service-delivery', () => ({
  createSD: vi.fn(async (p: Row) => {
    h.state.createSDCalls += 1
    h.state.events.push('createSD')
    const row = { id: `new-${h.state.nextId++}`, status: 'active', stage: p.target_stage, ...p, notes: p.notes ?? null }
    ;(h.state.db.service_deliveries ??= []).push(row)
    return { id: row.id }
  }),
  deactivateSD: vi.fn(async (p: { delivery_id: string }) => {
    const row = (h.state.db.service_deliveries ?? []).find((r) => r.id === p.delivery_id)
    if (!row) return { success: false, outcome: 'not_found', error: 'not found' }
    if (row.status === 'cancelled') return { success: false, outcome: 'already_terminal', error: 'already' }
    row.status = 'cancelled'
    h.state.events.push(`deactivate:${p.delivery_id}`)
    return { success: true, outcome: 'deactivated' }
  }),
}))
vi.mock('@/lib/operations/task', () => ({
  updateTasksBulk: vi.fn(async (p: { ids: string[] }) => {
    for (const t of h.state.db.tasks ?? []) if (p.ids.includes(String(t.id))) t.status = 'Cancelled'
    return { success: true, outcome: 'updated', count: p.ids.length }
  }),
}))
vi.mock('@/lib/operations/sync-tier', () => ({ syncContactTiersForAccount: vi.fn(async () => { h.state.events.push('sync-tier') }) }))
vi.mock('@/lib/operations/suite', () => ({ releaseCompanySuiteIfFree: vi.fn(async () => null) }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/portal/chat-link', () => ({ buildPortalChatLink: () => '/portal/chat' }))
vi.mock('@/lib/portal/mark-thread-read', () => ({
  resolveFallbackReplyTopic: vi.fn(async () => null),
  markClientMessagesReadForStaffReply: vi.fn(async () => 0),
}))
vi.mock('@/lib/portal/notifications', () => ({
  createPortalNotification: vi.fn(async (p: { type: string }) => {
    const i = h.state.bellFail.indexOf(p.type)
    if (i >= 0) { h.state.bellFail.splice(i, 1); return { error: `${p.type} bell broke` } }
    h.state.bells.push(p.type)
    h.state.events.push(`bell:${p.type}`)
    return { error: null }
  }),
  notifyClientOfAdminMessage: vi.fn(async () => { if (h.state.emailFail) throw new Error('mail server down') }),
  waitForClientAlert: vi.fn(async () => undefined),
}))

import { previewStartNewCompany, startNewCompany } from '@/lib/operations/start-new-company'

const BUYER = '11111111-1111-4111-8111-111111111111'
const CO_MEMBER = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = 'acct-novag'
const OLD_JOB = 'old-job'
const TOKEN = 'offer-token-1'
const MESSAGE = 'Ciao Ugo, apriamo una nuova società.'

function seed() {
  h.state.db = {
    contacts: [
      { id: BUYER, full_name: 'Ugo Buyer', first_name: 'Ugo', language: 'Italian' },
      { id: CO_MEMBER, full_name: 'Mia Member', first_name: 'Mia', language: 'English' },
    ],
    accounts: [{ id: ACCOUNT, company_name: 'Novag LLC', state_of_formation: 'Wyoming', status: 'Active', portal_account: true, portal_tier: 'active', notes: null }],
    account_contacts: [
      { account_id: ACCOUNT, contact_id: BUYER, ended_at: null },
      { account_id: ACCOUNT, contact_id: CO_MEMBER, ended_at: null },
    ],
    service_deliveries: [
      { id: OLD_JOB, service_type: 'Company Formation', status: 'active', stage: 'SS-4 Sent to IRS', contact_id: BUYER, account_id: ACCOUNT, source_offer_token: TOKEN, notes: null },
      { id: 'other-service', service_type: 'EIN', status: 'active', stage: 'x', contact_id: BUYER, account_id: ACCOUNT, source_offer_token: null, notes: null },
    ],
    tasks: [{ id: 'task-1', account_id: ACCOUNT, status: 'To Do' }],
    deadlines: [{ id: 'dl-1', account_id: ACCOUNT, status: 'Pending' }],
    payments: [],
    lease_agreements: [],
    offers: [{ id: 'offer-1', token: TOKEN, lead_id: 'lead-1', account_id: ACCOUNT, payment_plan: [{ seq: 2, amount: 1250, currency: 'EUR', trigger: { kind: 'step', service_type: 'Company Formation', stage: 'EIN Received' } }] }],
    wizard_progress: [
      {
        id: 'wiz-1', wizard_type: 'formation', status: 'submitted', lead_id: 'lead-1', offer_id: null, contact_id: BUYER, current_step: 4, updated_at: '2026-11-01T00:00:00Z',
        data: { llc_name_1: 'Novag LLC', llc_name_2: 'Novag Group LLC', disclaimer_accepted: true, members: [{ name: 'Ugo Buyer' }] },
      },
    ],
    portal_messages: [],
  }
  h.state.events = []
  h.state.inject = []
  h.state.nextId = 1
  h.state.createSDCalls = 0
  h.state.messages = []
  h.state.bellFail = []
  h.state.emailFail = false
  h.state.bells = []
}

const press = (over: Partial<Parameters<typeof startNewCompany>[0]> = {}) =>
  startNewCompany({ contactId: BUYER, replaceDeliveryId: OLD_JOB, message: MESSAGE, actorLabel: 'staff@example.com', actorUserId: 'staff-1', ...over })

const sd = (id: string) => (h.state.db.service_deliveries ?? []).find((r) => r.id === id)
const newJob = () => (h.state.db.service_deliveries ?? []).find((r) => r.id !== OLD_JOB && r.service_type === 'Company Formation')
const wizard = () => (h.state.db.wizard_progress ?? [])[0]

beforeEach(() => seed())

describe('the preview', () => {
  it('lists the buyer\'s formation, with the draft in the client\'s language', async () => {
    const p = await previewStartNewCompany(BUYER)
    expect(p.candidates).toHaveLength(1)
    expect(p.candidates[0]).toMatchObject({ deliveryId: OLD_JOB, companyName: 'Novag LLC', blockers: [], peopleOnCompany: 2 })
    expect(p.candidates[0].draftMessage.startsWith('Ciao Ugo,')).toBe(true)
    expect(p.candidates[0].waitingPart).toContain('Part 2')
  })

  it('gives the Italian draft to a client saved as "Italian - englis" or "it-IT"', async () => {
    for (const language of ['Italian - englis', 'it-IT']) {
      h.state.db.contacts[0].language = language
      expect((await previewStartNewCompany(BUYER)).candidates[0].draftMessage.startsWith('Ciao Ugo,')).toBe(true)
    }
  })

  it('does not list the buyer\'s formation on a co-member\'s page', async () => {
    const p = await previewStartNewCompany(CO_MEMBER)
    expect(p.candidates).toEqual([])
  })

  it('refuses a co-member who presses with the buyer\'s job id: nothing is created, nothing is cancelled', async () => {
    const r = await press({ contactId: CO_MEMBER })
    expect(r.success).toBe(false)
    expect(h.state.createSDCalls).toBe(0)
    expect(sd(OLD_JOB)?.status).toBe('active')
    expect(h.state.messages).toHaveLength(0)
  })

  it('treats an unpaid invoice with status Delinquent as a blocker', async () => {
    h.state.db.payments = [{ id: 'p1', account_id: ACCOUNT, invoice_number: 'INV-000001', status: 'Delinquent', invoice_status: 'Sent', amount: 100, amount_currency: 'USD', amount_due: 100, amount_paid: 0 }]
    const c = (await previewStartNewCompany(BUYER)).candidates[0]
    expect(c.blockers.join(' ')).toContain('unpaid invoice')
    const r = await press()
    expect(r.success).toBe(false)
    expect(h.state.createSDCalls).toBe(0)
  })

  it('treats a lease waiting for a signature as a lease in force', async () => {
    h.state.db.lease_agreements = [{ id: 'l1', account_id: ACCOUNT, status: 'awaiting_signature' }]
    expect((await previewStartNewCompany(BUYER)).candidates[0].blockers.join(' ')).toContain('lease')
  })
})

describe('a full press', () => {
  it('does everything, in the order that keeps a half-done press finishable', async () => {
    const r = await press()
    expect(r.success).toBe(true)
    expect(r.finished).toBe(true)
    expect(r.problems).toEqual([])

    // the new job: same offer, no company yet
    expect(newJob()).toMatchObject({ account_id: null, source_offer_token: TOKEN, contact_id: BUYER })
    // the wizard reopened with the refused names gone, the people kept
    expect(wizard()).toMatchObject({ status: 'in_progress', current_step: 0 })
    expect(Object.keys(wizard().data as Row)).toEqual(['members'])
    // the old company closed, its loose ends cancelled
    expect(h.state.db.accounts[0]).toMatchObject({ status: 'Closed', portal_account: false, portal_tier: 'inactive' })
    expect(sd('other-service')?.status).toBe('cancelled')
    expect(h.state.db.tasks[0].status).toBe('Cancelled')
    expect(h.state.db.deadlines[0].status).toBe('Cancelled')
    // the client was told once, in the staff member's words
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({ message: MESSAGE, contact_id: BUYER, sender_id: 'staff-1' })

    // the old formation job is cancelled AFTER the message, and the tier sync comes after it too
    const order = h.state.events
    expect(order.indexOf('message')).toBeLessThan(order.indexOf(`deactivate:${OLD_JOB}`))
    expect(order.indexOf('close-account')).toBeLessThan(order.indexOf(`deactivate:${OLD_JOB}`))
    expect(order.indexOf(`deactivate:${OLD_JOB}`)).toBeLessThan(order.indexOf('sync-tier'))
    expect(order.filter((e) => e === `deactivate:${OLD_JOB}`)).toHaveLength(1)

    // the record: markers on the new job, a note on the company and on the person that keeps the old names
    const notes = String(newJob()?.notes)
    expect(notes).toContain('Replaces job old-job')
    expect(notes).toContain('Wizard reopened')
    expect(notes).toContain('Client message sent')
    expect(String(h.state.db.accounts[0].notes)).toContain('Novag Group LLC')
    expect(String(h.state.db.contacts[0].notes)).toContain('new formation job')
  })

  it('has nothing left to press afterwards', async () => {
    await press()
    const again = await press()
    expect(again.success).toBe(false)
    expect(again.error).toContain('no longer an active formation')
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.createSDCalls).toBe(1)
  })
})

describe('a press that stops half-way is finished by pressing again', () => {
  it('a failed message leaves the old job active and the button available; the second press sends it once and finishes', async () => {
    h.state.inject.push({ table: 'portal_messages', mode: 'insert', message: 'chat is down' })
    const first = await press()
    expect(first.success).toBe(true)
    expect(first.finished).toBe(false)
    expect(first.problems.join(' ')).toContain('chat is down')
    expect(sd(OLD_JOB)?.status).toBe('active') // still listed: the button survives
    expect(h.state.messages).toHaveLength(0)
    expect((await previewStartNewCompany(BUYER)).candidates).toHaveLength(1)
    // what needs a person is in the notes, not only on screen
    expect(String(newJob()?.notes)).toContain('NOT FINISHED')
    expect(String(newJob()?.notes)).toContain('chat is down')

    const second = await press()
    expect(second.finished).toBe(true)
    expect(second.resumed).toBe(true)
    expect(h.state.createSDCalls).toBe(1) // no second new job
    expect(h.state.messages).toHaveLength(1) // told once
    expect(sd(OLD_JOB)?.status).toBe('cancelled')
  })

  it('a failed clean-up step holds the message and the cancellation back', async () => {
    h.state.inject.push({ table: 'deadlines', mode: 'update', message: 'deadlines are locked' })
    const first = await press()
    expect(first.finished).toBe(false)
    expect(h.state.messages).toHaveLength(0) // the client is told only when everything is ready
    expect(sd(OLD_JOB)?.status).toBe('active')
    expect(first.steps.find((s) => s.step === 'message to the client')?.status).toBe('warning')

    const second = await press()
    expect(second.finished).toBe(true)
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.db.deadlines[0].status).toBe('Cancelled')
  })

  it('a second press never wipes what the client typed after the wizard was reopened', async () => {
    h.state.inject.push({ table: 'portal_messages', mode: 'insert', message: 'chat is down' })
    await press()
    // the client opens the reopened wizard, types new names and submits again
    Object.assign(wizard(), { status: 'submitted', data: { llc_name_1: 'Brand New Name LLC', members: [{ name: 'Ugo Buyer' }] } })

    const second = await press()
    expect(second.finished).toBe(true)
    expect(wizard()).toMatchObject({ status: 'submitted' })
    expect((wizard().data as Row).llc_name_1).toBe('Brand New Name LLC')
    expect(second.steps.find((s) => s.step === 'client wizard')?.status).toBe('skipped')
    // and the old names are still in the cancelled job's history
    expect(String(h.state.db.accounts[0].notes)).toContain('Novag Group LLC')
  })

  it('a failure while cancelling the old job itself is reported and the next press retries it', async () => {
    const { deactivateSD } = await import('@/lib/operations/service-delivery')
    ;(deactivateSD as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ success: false, outcome: 'error', error: 'database busy' }))
    const first = await press()
    expect(first.finished).toBe(false)
    expect(first.problems.join(' ')).toContain('database busy')
    expect(sd(OLD_JOB)?.status).toBe('active')
    const second = await press()
    expect(second.finished).toBe(true)
    expect(h.state.messages).toHaveLength(1)
  })
})

describe('finding the client\'s saved wizard', () => {
  it('finds a wizard saved under the offer alone, though the offer has a lead (the reminder link\'s key)', async () => {
    Object.assign(wizard(), { lead_id: null, offer_id: 'offer-1' })
    const r = await press()
    expect(r.finished).toBe(true)
    expect(wizard()).toMatchObject({ status: 'in_progress', current_step: 0 })
    expect((wizard().data as Row).llc_name_1).toBeUndefined()
  })

  it('reopens every saved copy under the offer, so no link shows the old names', async () => {
    h.state.db.wizard_progress.push({ id: 'wiz-2', wizard_type: 'formation', status: 'submitted', lead_id: null, offer_id: 'offer-1', contact_id: BUYER, current_step: 4, updated_at: '2026-11-02T00:00:00Z', data: { llc_name_1: 'Novag LLC' } })
    await press()
    for (const w of h.state.db.wizard_progress) {
      expect(w.status).toBe('in_progress')
      expect((w.data as Row).llc_name_1).toBeUndefined()
    }
  })

  it('does not guess when the only saved wizard belongs to the person alone: it is left as it is and reported', async () => {
    Object.assign(wizard(), { lead_id: null, offer_id: null })
    const r = await press()
    expect(r.finished).toBe(true) // the rest still goes ahead
    expect(wizard()).toMatchObject({ status: 'submitted' })
    expect((wizard().data as Row).llc_name_1).toBe('Novag LLC')
    expect(r.problems.join(' ')).toContain('other saved formation wizard')
    expect(String(newJob()?.notes)).toContain('other saved formation wizard')
  })

  it('says plainly that there is nothing to reopen when the person has no saved wizard at all', async () => {
    h.state.db.wizard_progress = []
    const r = await press()
    expect(r.finished).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.steps.find((s) => s.step === 'client wizard')?.detail).toContain('starts a blank one')
  })
})

describe('the signed offer follows the replacement (second bug-hunter pass)', () => {
  const offer = () => h.state.db.offers[0]

  it('is taken off the old company, so the new company picks it up when it is created', async () => {
    expect(offer().account_id).toBe(ACCOUNT)
    const r = await press()
    expect(r.finished).toBe(true)
    expect(offer().account_id).toBeNull()
    expect(r.steps.find((s) => s.step === 'signed offer')?.status).toBe('ok')
  })

  it('is left alone when it points somewhere else (never moves an offer it does not own)', async () => {
    offer().account_id = 'some-other-company'
    await press()
    expect(offer().account_id).toBe('some-other-company')
  })

  it('is left alone when it already waits for a company, and a repeat press finds nothing to do', async () => {
    offer().account_id = null
    const r = await press()
    expect(r.finished).toBe(true)
    expect(r.steps.find((s) => s.step === 'signed offer')).toBeUndefined()
  })

  it('a failed write holds the press back, and the repeat finishes it', async () => {
    h.state.inject.push({ table: 'offers', mode: 'update', message: 'offers are locked' })
    const first = await press()
    expect(first.finished).toBe(false)
    expect(first.problems.join(' ')).toContain('offers are locked')
    expect(sd(OLD_JOB)?.status).toBe('active')
    expect(h.state.messages).toHaveLength(0)
    const second = await press()
    expect(second.finished).toBe(true)
    expect(offer().account_id).toBeNull()
  })
})

describe('what the client is sent is checked, not assumed (second bug-hunter pass)', () => {
  it('sends the way into the wizard BEFORE the chat message', async () => {
    await press()
    const order = h.state.events
    expect(order.indexOf('bell:wizard_reminder')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('bell:wizard_reminder')).toBeLessThan(order.indexOf('message'))
  })

  it('a wizard notification that cannot be saved stops everything: nothing is sent, the old job stays, the repeat finishes', async () => {
    h.state.bellFail.push('wizard_reminder')
    const first = await press()
    expect(first.finished).toBe(false)
    expect(first.problems.join(' ')).toContain('wizard_reminder bell broke')
    expect(h.state.messages).toHaveLength(0) // the client has been told nothing
    expect(sd(OLD_JOB)?.status).toBe('active')
    expect(String(newJob()?.notes)).not.toContain('Client message sent')

    const second = await press()
    expect(second.finished).toBe(true)
    expect(h.state.messages).toHaveLength(1)
  })

  it('a chat notification that fails after the message is in is reported, but the press is still finished', async () => {
    h.state.bellFail.push('chat')
    const r = await press()
    expect(r.finished).toBe(true)
    expect(h.state.messages).toHaveLength(1)
    expect(String(newJob()?.notes)).toContain('Client message sent')
    const w = r.steps.find((s) => s.step === 'client notification')
    expect(w?.status).toBe('warning')
    expect(r.problems.join(' ')).toContain('chat notification could not be saved')
    expect(String(newJob()?.notes)).toContain('Needs a person')
  })

  it('an e-mail that fails after the message is in is reported the same way', async () => {
    h.state.emailFail = true
    const r = await press()
    expect(r.finished).toBe(true)
    expect(h.state.messages).toHaveLength(1)
    expect(r.problems.join(' ')).toContain('mail server down')
  })
})

describe('the names the client had given are all remembered (second bug-hunter pass)', () => {
  it('a newer blank draft does not hide the names an older submitted copy held', async () => {
    Object.assign(wizard(), { lead_id: null, offer_id: 'offer-1' })
    h.state.db.wizard_progress.push({ id: 'wiz-new', wizard_type: 'formation', status: 'in_progress', lead_id: null, offer_id: 'offer-1', contact_id: BUYER, current_step: 0, updated_at: '2026-11-15T00:00:00Z', data: {} })
    await press()
    expect(String(h.state.db.accounts[0].notes)).toContain('Novag Group LLC')
    expect(String(newJob()?.notes)).toContain('Novag Group LLC')
  })

  it('the older single-name keys are cleared too, so the refused name cannot return through them', async () => {
    Object.assign(wizard().data as Row, { chosen_name_final: 'Novag LLC', company_name: 'Novag LLC' })
    await press()
    expect(Object.keys(wizard().data as Row)).toEqual(['members'])
  })
})
