import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MUST_ACT_NOTIFICATION_TYPES,
  isMustActNotification,
  decideNotificationOwnership,
  splitReadable,
  previewMessageText,
  reactionNoticeText,
  reactionSeenKey,
  shouldPulseReaction,
} from '@/lib/portal/notification-read'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const ME = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'

describe('must-act notification types', () => {
  it('covers every type that asks the client to do something', () => {
    for (const t of ['sign_document', 'signature_request', 'action_required', 'action', 'decision', 'form_reminder_7d', 'form_reminder_3d', 'wizard_reminder']) {
      expect(isMustActNotification(t)).toBe(true)
    }
    expect(MUST_ACT_NOTIFICATION_TYPES.size).toBe(8)
  })
  it('lets informational types be cleared by a tap', () => {
    for (const t of ['chat', 'reaction', 'service', 'document', 'new_document', 'invoice', 'ein_received']) {
      expect(isMustActNotification(t)).toBe(false)
    }
    expect(isMustActNotification(null)).toBe(false)
    expect(isMustActNotification(undefined)).toBe(false)
  })
  it('splitReadable leaves must-act rows unread', () => {
    const { markable, skipped } = splitReadable([
      { id: A, type: 'chat' },
      { id: B, type: 'sign_document' },
      { id: C, type: 'reaction' },
    ])
    expect(markable.map(r => r.id)).toEqual([A, C])
    expect(skipped.map(r => r.id)).toEqual([B])
  })
})

describe('decideNotificationOwnership', () => {
  const client = { kind: 'client' as const, contactId: ME, accountIds: [A] }
  it('allows rows on the client’s company or addressed to them with no company', () => {
    const rows = [
      { id: B, account_id: A, contact_id: OTHER },
      { id: C, account_id: null, contact_id: ME },
    ]
    expect(decideNotificationOwnership([B, C], rows, client).ok).toBe(true)
  })
  it('rejects a row with no company and someone else’s contact (the old hole)', () => {
    const d = decideNotificationOwnership([B], [{ id: B, account_id: null, contact_id: OTHER }], client)
    expect(d.ok).toBe(false)
    expect(d.status).toBe(403)
  })
  it('rejects a row on another company even when it carries the client’s contact id', () => {
    const d = decideNotificationOwnership([B], [{ id: B, account_id: C, contact_id: ME }], client)
    expect(d.ok).toBe(false)
    expect(d.status).toBe(403)
  })
  it('rejects the whole batch when an id does not exist', () => {
    const d = decideNotificationOwnership([B, C], [{ id: B, account_id: A, contact_id: ME }], client)
    expect(d.ok).toBe(false)
    expect(d.status).toBe(404)
  })
  it('counts duplicate ids once', () => {
    expect(decideNotificationOwnership([B, B], [{ id: B, account_id: A, contact_id: ME }], client).ok).toBe(true)
  })
  it('a teammate owns only their own company’s rows, never personal ones', () => {
    const tm = { kind: 'teammate' as const, accountId: A }
    expect(decideNotificationOwnership([B], [{ id: B, account_id: A, contact_id: null }], tm).ok).toBe(true)
    expect(decideNotificationOwnership([B], [{ id: B, account_id: null, contact_id: ME }], tm).ok).toBe(false)
    expect(decideNotificationOwnership([B], [{ id: B, account_id: C, contact_id: null }], tm).ok).toBe(false)
  })
})

describe('reaction notice text', () => {
  it('names the message, in English by default', () => {
    const n = reactionNoticeText('English', '👍', 'Here is my passport')
    expect(n.title).toBe('New reaction from Tony Durante Team')
    expect(n.body).toBe('👍 on your message: “Here is my passport”')
  })
  it('speaks Italian to an Italian contact (free-text language values)', () => {
    for (const lang of ['it', 'Italian', 'Italiano', 'italian - english']) {
      const n = reactionNoticeText(lang, '❤️', 'Ciao')
      expect(n.title).toBe('Nuova reazione dal Team Tony Durante')
      expect(n.body).toContain('sul tuo messaggio')
    }
  })
  it('keeps the message text off the lock screen: push shows only the emoji', () => {
    const n = reactionNoticeText('en', '👍', 'Secret tax number 123')
    expect(n.pushBody).toBe('👍 on your message')
    expect(n.pushBody).not.toContain('Secret')
    expect(n.body).toContain('Secret')
  })
  it('works with no preview', () => {
    expect(reactionNoticeText('en', '👍', '').body).toBe('👍 on your message')
  })
})

describe('previewMessageText', () => {
  it('collapses whitespace and strips tags', () => {
    expect(previewMessageText('  hello\n\n <b>world</b>  ')).toBe('hello world')
  })
  it('cuts long text with an ellipsis and never splits an emoji', () => {
    const long = '👍'.repeat(100)
    const p = previewMessageText(long, 10)
    expect(p.endsWith('…')).toBe(true)
    expect(Array.from(p.slice(0, -1)).every(c => c === '👍')).toBe(true)
    expect(Array.from(p).length).toBe(11)
  })
  it('handles null and empty', () => {
    expect(previewMessageText(null)).toBe('')
    expect(previewMessageText('   ')).toBe('')
  })
})

describe('shouldPulseReaction', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  it('pulses a team reaction newer than the last look', () => {
    expect(shouldPulseReaction({ reactor_type: 'staff', created_at: '2026-10-06T11:00:00Z' }, now - 3600_000 * 2, now)).toBe(true)
  })
  it('does not pulse one the client already saw', () => {
    expect(shouldPulseReaction({ reactor_type: 'staff', created_at: '2026-10-06T09:00:00Z' }, now - 3600_000, now)).toBe(false)
  })
  it('never pulses the client’s own reaction', () => {
    expect(shouldPulseReaction({ reactor_type: 'client', created_at: '2026-10-06T11:59:00Z' }, null, now)).toBe(false)
  })
  it('on a device that never looked, only recent reactions pulse (14 days)', () => {
    expect(shouldPulseReaction({ reactor_type: 'staff', created_at: '2026-10-01T00:00:00Z' }, null, now)).toBe(true)
    expect(shouldPulseReaction({ reactor_type: 'staff', created_at: '2026-08-01T00:00:00Z' }, null, now)).toBe(false)
  })
  it('ignores malformed timestamps', () => {
    expect(shouldPulseReaction({ reactor_type: 'staff', created_at: 'nope' }, null, now)).toBe(false)
    expect(shouldPulseReaction({ reactor_type: 'staff' }, null, now)).toBe(false)
  })
})

describe('reactionSeenKey', () => {
  it('is per company and per person, so one company’s look never clears another', () => {
    expect(reactionSeenKey(A, ME)).not.toBe(reactionSeenKey(B, ME))
    expect(reactionSeenKey(null, ME)).toBe(`td-reaction-seen:personal:${ME}`)
  })
})

// Wiring guards — the pieces that make the rules above actually apply.
describe('wiring', () => {
  const route = read('app/api/portal/notifications/route.ts')
  it('the mark-read route refuses non-client logins, checks ownership, skips must-act rows and reports DB errors', () => {
    expect(route).toContain("user.app_metadata?.role !== 'client'")
    expect(route).toContain('decideNotificationOwnership')
    expect(route).toContain('splitReadable')
    expect(route).toContain('updErr')
    expect(route).toContain("body.type === 'reaction'")
  })
  it('the reaction route builds a named, localised, deep-linked notice and keeps the preview off the push', () => {
    const react = read('app/api/portal/chat/message/[id]/react/route.ts')
    expect(react).toContain('reactionNoticeText')
    expect(react).toContain('buildPortalChatLink')
    expect(react).toContain('pushBody: notice.pushBody')
  })
  it('the bell and the notifications page mark one item on tap with keepalive and respect must-act types', () => {
    for (const f of ['components/portal/notification-bell.tsx', 'app/portal/notifications/page.tsx']) {
      const src = read(f)
      expect(src).toContain('isMustActNotification')
      expect(src).toContain('keepalive')
      expect(src).toContain('onItemTap')
    }
  })
  it('the chat pulses the reaction until seen and tells the sidebar', () => {
    const chat = read('components/portal/portal-chat.tsx')
    expect(chat).toContain('reactionSeenKey')
    expect(chat).toContain('portal-reactions-seen')
    expect(chat).toContain('pulseSince={isOwn ? reactionSeenAt : undefined}')
    const side = read('components/portal/portal-sidebar.tsx')
    expect(side).toContain('reactionPulse')
    expect(side).toContain('portal-reactions-seen')
  })
})
