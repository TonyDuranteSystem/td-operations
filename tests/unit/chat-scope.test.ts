import { describe, it, expect } from 'vitest'
import {
  mayIncludePersonalNull,
  buildChatQueryPlan,
  messageVisibleInPlan,
  isChatEventMessage,
} from '@/lib/portal/chat-scope'

describe('mayIncludePersonalNull (leak-proof personal inclusion)', () => {
  it('includes personal NULL only for a sole-owned account (1 contact == viewer)', () => {
    expect(mayIncludePersonalNull({ linkedContactCount: 1, viewerIsSoleLinkedContact: true })).toBe(true)
  })
  it('excludes when the account has more than one linked contact (MMLLC / shared)', () => {
    expect(mayIncludePersonalNull({ linkedContactCount: 2, viewerIsSoleLinkedContact: false })).toBe(false)
    expect(mayIncludePersonalNull({ linkedContactCount: 3, viewerIsSoleLinkedContact: false })).toBe(false)
  })
  it('excludes a 1-contact account when the viewer is NOT that contact (defensive)', () => {
    expect(mayIncludePersonalNull({ linkedContactCount: 1, viewerIsSoleLinkedContact: false })).toBe(false)
  })
  it('excludes a 0-contact account', () => {
    expect(mayIncludePersonalNull({ linkedContactCount: 0, viewerIsSoleLinkedContact: false })).toBe(false)
  })
  it('does NOT leak even if a 2-contact account erroneously flags viewer as sole', () => {
    // count is the hard gate — a stray second contact always wins.
    expect(mayIncludePersonalNull({ linkedContactCount: 2, viewerIsSoleLinkedContact: true })).toBe(false)
  })
})

describe('buildChatQueryPlan', () => {
  const me = 'contact-1'
  const acct = 'acct-1'

  it('company scope, sole-owned → account_plus_personal', () => {
    expect(
      buildChatQueryPlan({ scope: 'company', accountId: acct, contactId: me, includePersonalNull: true }),
    ).toEqual({ mode: 'account_plus_personal', accountId: acct, contactId: me })
  })

  it('company scope, shared (MMLLC) → account only, no personal NULL', () => {
    expect(
      buildChatQueryPlan({ scope: 'company', accountId: acct, contactId: me, includePersonalNull: false }),
    ).toEqual({ mode: 'account', accountId: acct })
  })

  it('company scope with includePersonalNull but no contact (teammate) → account only', () => {
    expect(
      buildChatQueryPlan({ scope: 'company', accountId: acct, contactId: null, includePersonalNull: true }),
    ).toEqual({ mode: 'account', accountId: acct })
  })

  it('company scope without an account → null (caller 400s)', () => {
    expect(
      buildChatQueryPlan({ scope: 'company', accountId: null, contactId: me, includePersonalNull: true }),
    ).toBeNull()
  })

  it('personal / formation scope → personal_only', () => {
    expect(
      buildChatQueryPlan({ scope: 'personal', accountId: null, contactId: me, includePersonalNull: false }),
    ).toEqual({ mode: 'personal_only', contactId: me })
  })

  it('personal scope without a contact → null', () => {
    expect(
      buildChatQueryPlan({ scope: 'personal', accountId: null, contactId: null, includePersonalNull: false }),
    ).toBeNull()
  })
})

describe('messageVisibleInPlan (realtime drop filter mirrors the server query)', () => {
  const me = 'contact-1'
  const other = 'contact-2'
  const acctA = 'acct-A'
  const acctB = 'acct-B'

  it('account plan: only messages tagged to that account', () => {
    const plan = { mode: 'account' as const, accountId: acctA }
    expect(messageVisibleInPlan(plan, { account_id: acctA, contact_id: me })).toBe(true)
    expect(messageVisibleInPlan(plan, { account_id: acctA, contact_id: other })).toBe(true) // shared MMLLC
    expect(messageVisibleInPlan(plan, { account_id: acctB, contact_id: me })).toBe(false)
    expect(messageVisibleInPlan(plan, { account_id: null, contact_id: me })).toBe(false) // personal NEVER in MMLLC
  })

  it('account_plus_personal plan: account messages + own personal NULL', () => {
    const plan = { mode: 'account_plus_personal' as const, accountId: acctA, contactId: me }
    expect(messageVisibleInPlan(plan, { account_id: acctA, contact_id: me })).toBe(true)
    expect(messageVisibleInPlan(plan, { account_id: null, contact_id: me })).toBe(true)
    expect(messageVisibleInPlan(plan, { account_id: null, contact_id: other })).toBe(false) // someone else's personal
    expect(messageVisibleInPlan(plan, { account_id: acctB, contact_id: me })).toBe(false) // other company
  })

  it('personal_only plan: only the viewer’s own untagged messages', () => {
    const plan = { mode: 'personal_only' as const, contactId: me }
    expect(messageVisibleInPlan(plan, { account_id: null, contact_id: me })).toBe(true)
    expect(messageVisibleInPlan(plan, { account_id: null, contact_id: other })).toBe(false)
    expect(messageVisibleInPlan(plan, { account_id: acctA, contact_id: me })).toBe(false)
  })
})

describe('isChatEventMessage (chat-event marker detection)', () => {
  it('detects the marker lib/portal/chat-events.ts actually writes', () => {
    const body =
      'Abbiamo ricevuto le tue informazioni.\n\n<!-- chat-event: kind=wizard_submitted src=tax_return_submissions:abc123 -->'
    expect(isChatEventMessage(body)).toBe(true)
  })

  it('is case-insensitive, mirroring the server-side SQL ILIKE check', () => {
    expect(isChatEventMessage('note <!-- CHAT-EVENT: kind=payment_received -->')).toBe(true)
  })

  it('returns false for a plain client or system message', () => {
    expect(isChatEventMessage('ok perfetto grazie mille')).toBe(false)
    expect(isChatEventMessage('We are currently closed. Our office is open Monday to Friday.')).toBe(false)
  })

  it('returns false for an unrelated HTML comment', () => {
    expect(isChatEventMessage('some text <!-- not an event marker --> more text')).toBe(false)
  })

  it('handles an empty string without throwing', () => {
    expect(isChatEventMessage('')).toBe(false)
  })
})
