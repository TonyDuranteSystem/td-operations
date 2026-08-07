/**
 * Admin send-scope invariant (lib/portal/admin-send-scope.ts) — the rule that
 * closes the 2026-08-07 portal-chat cross-company leak (dev job 4bad3094).
 *
 * The leak shape: a staff reply addressed to a PERSON silently carrying a
 * company account_id, which made it readable by every member of that company.
 * decideAdminSendScope must reject that shape unless company scope is
 * explicitly declared, and the declared company must be one the person is in.
 */
import { describe, it, expect } from 'vitest'
import {
  decideAdminSendScope,
  isContactLinkedToAccount,
  accountAudience,
} from '@/lib/portal/admin-send-scope'

const ACC = 'aaaaaaaa-0000-0000-0000-000000000001'
const CON = 'cccccccc-0000-0000-0000-000000000001'

describe('decideAdminSendScope (pure invariant)', () => {
  it('allows a personal send: contact only, person context', () => {
    const d = decideAdminSendScope({ accountId: null, contactId: CON, senderContext: 'person' })
    expect(d).toEqual({ ok: true, needsLinkCheck: false })
  })

  it('allows a personal send: contact only, no declared context (legacy shape)', () => {
    const d = decideAdminSendScope({ accountId: null, contactId: CON, senderContext: null })
    expect(d).toEqual({ ok: true, needsLinkCheck: false })
  })

  it('allows an account-thread send: account only, no contact in body', () => {
    const d = decideAdminSendScope({ accountId: ACC, contactId: null, senderContext: null })
    expect(d).toEqual({ ok: true, needsLinkCheck: false })
  })

  it('REJECTS the leak shape: contact + account with no explicit company declaration', () => {
    const d = decideAdminSendScope({ accountId: ACC, contactId: CON, senderContext: null })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toMatch(/addressed to a person/i)
  })

  it('allows contact + account when company scope is explicitly declared — but demands the link check', () => {
    const d = decideAdminSendScope({ accountId: ACC, contactId: CON, senderContext: 'company' })
    expect(d).toEqual({ ok: true, needsLinkCheck: true })
  })

  it('rejects company context without an account (existing contract)', () => {
    const d = decideAdminSendScope({ accountId: null, contactId: CON, senderContext: 'company' })
    expect(d.ok).toBe(false)
  })

  it('rejects person context WITH an account (existing contract)', () => {
    const d = decideAdminSendScope({ accountId: ACC, contactId: CON, senderContext: 'person' })
    expect(d.ok).toBe(false)
  })
})

/** Minimal fake of the query surface the DB helpers use. */
function fakeDb(tables: Record<string, { rows?: unknown[]; error?: { message: string } }>) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const t = tables[table] ?? { rows: [] }
          const result = { data: t.error ? null : (t.rows ?? []), error: t.error ?? null }
          return {
            // thenable so `await` works without a real Promise builder chain
            then: (resolve: (v: typeof result) => unknown) => resolve(result),
          }
        },
      }),
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('isContactLinkedToAccount', () => {
  it('true when the contact is linked to the account', async () => {
    const db = fakeDb({ account_contacts: { rows: [{ contact_id: CON }, { contact_id: 'other' }] } })
    expect(await isContactLinkedToAccount(ACC, CON, db)).toBe(true)
  })

  it('false when the contact is NOT linked', async () => {
    const db = fakeDb({ account_contacts: { rows: [{ contact_id: 'someone-else' }] } })
    expect(await isContactLinkedToAccount(ACC, CON, db)).toBe(false)
  })

  it('fails CLOSED on a query error (blocked send beats a silent leak)', async () => {
    const db = fakeDb({ account_contacts: { error: { message: 'boom' } } })
    expect(await isContactLinkedToAccount(ACC, CON, db)).toBe(false)
  })
})

describe('accountAudience', () => {
  it('counts linked contacts and ONLY active chat-capable teammates', async () => {
    const db = fakeDb({
      account_contacts: { rows: [{ contact_id: CON }, { contact_id: 'x' }] },
      portal_team_members: {
        rows: [
          { capabilities: { chat: true }, status: 'active' },        // counts
          { capabilities: { chat: true }, status: 'revoked' },       // inactive → no
          { capabilities: { documents: true }, status: 'active' },   // no chat → no
          { capabilities: null, status: 'active' },                  // no caps → no
        ],
      },
    })
    expect(await accountAudience(ACC, db)).toEqual({ contactCount: 2, chatTeammateCount: 1 })
  })

  it('degrades to zero counts on query errors (no crash in the composer)', async () => {
    const db = fakeDb({
      account_contacts: { error: { message: 'boom' } },
      portal_team_members: { error: { message: 'boom' } },
    })
    expect(await accountAudience(ACC, db)).toEqual({ contactCount: 0, chatTeammateCount: 0 })
  })

  it('solo company with a chat teammate reports an audience wider than one — the warning case', async () => {
    const db = fakeDb({
      account_contacts: { rows: [{ contact_id: CON }] },
      portal_team_members: { rows: [{ capabilities: { chat: true }, status: 'active' }] },
    })
    const a = await accountAudience(ACC, db)
    expect(a.contactCount + a.chatTeammateCount).toBeGreaterThan(1)
  })
})
