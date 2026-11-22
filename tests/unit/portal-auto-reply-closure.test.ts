import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The out-of-office reply: which words, which language, which throttle marker — normally, in the days before a planned closure, and during it.
// A fake database records what is looked up and inserted, so the language and marker rules are proved without a real one.

const db = vi.hoisted(() => ({
  contactLanguage: null as string | null,
  dedupHit: null as { id: string } | null,
  likePatterns: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (result: () => unknown): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      limit: () => c,
      like: (_col: string, pattern: string) => { db.likePatterns.push(pattern); return c },
      maybeSingle: async () => result(),
    }
    return c
  }
  return {
    supabaseAdmin: {
      from: (table: string) => table === 'portal_messages'
        ? {
            ...chain(() => ({ data: db.dedupHit })),
            insert: async (row: Record<string, unknown>) => { db.inserted.push(row); return { error: null } },
          }
        : chain(() => ({ data: { language: db.contactLanguage } })),
    },
  }
})

import {
  AUTO_REPLY_MARKER,
  CLOSURE_REPLY_MARKER,
  autoReplyMarker,
  buildAutoReplyText,
  sendOfficeClosedAutoReply,
} from '@/lib/portal/auto-reply'
import { OFFICE_CLOSURES } from '@/lib/portal/office-closures'

const TUE_NORMAL = new Date('2026-11-17T21:00:00Z') // Tue 17 Nov 4 PM ET, no closure near
const TUE_HEADS_UP = new Date('2026-11-24T21:00:00Z') // Tue 24 Nov 4 PM ET, closure starts tomorrow
const WED_CLOSED = new Date('2026-11-25T16:00:00Z') // Wed 25 Nov 11 AM ET, closed
const c = OFFICE_CLOSURES[0]

describe('buildAutoReplyText', () => {
  it('normal day: the office-hours reply in each language', () => {
    expect(buildAutoReplyText('en', TUE_NORMAL)).toContain('next business day')
    expect(buildAutoReplyText('it', TUE_NORMAL)).toContain('prossimo giorno lavorativo')
    expect(buildAutoReplyText('en', TUE_NORMAL)).not.toContain('Thanksgiving')
  })

  it('the day before the closure: the normal reply plus the heads-up (it would otherwise promise "the next business day", which is a closed day)', () => {
    const en = buildAutoReplyText('en', TUE_HEADS_UP)
    expect(en).toContain('next business day')
    expect(en).toContain(c.copy.en.noticeMessage)
    const it = buildAutoReplyText('it', TUE_HEADS_UP)
    expect(it).toContain('prossimo giorno lavorativo')
    expect(it).toContain(c.copy.it.noticeMessage)
  })

  it('during the closure: only the closure reply, with the reopen day and no "next business day"', () => {
    expect(buildAutoReplyText('en', WED_CLOSED)).toBe(c.copy.en.autoReply)
    expect(buildAutoReplyText('it', WED_CLOSED)).toBe(c.copy.it.autoReply)
    expect(buildAutoReplyText('en', WED_CLOSED)).not.toContain('next business day')
    expect(buildAutoReplyText('en', WED_CLOSED)).toContain('Monday, November 30')
    expect(buildAutoReplyText('it', WED_CLOSED)).toContain('lunedì 30 novembre')
  })
})

describe('autoReplyMarker — the 4-hour throttle must not mix the two kinds', () => {
  it('normal and heads-up days use the normal marker; closed days use the closure marker', () => {
    expect(autoReplyMarker(TUE_NORMAL)).toBe(AUTO_REPLY_MARKER)
    expect(autoReplyMarker(TUE_HEADS_UP)).toBe(AUTO_REPLY_MARKER)
    expect(autoReplyMarker(WED_CLOSED)).toBe(CLOSURE_REPLY_MARKER)
  })
  it('neither marker is a piece of the other (the throttle looks for the text with LIKE %marker%)', () => {
    expect(AUTO_REPLY_MARKER).not.toBe(CLOSURE_REPLY_MARKER)
    expect(AUTO_REPLY_MARKER.includes(CLOSURE_REPLY_MARKER)).toBe(false)
    expect(CLOSURE_REPLY_MARKER.includes(AUTO_REPLY_MARKER)).toBe(false)
    // the plain `office-closed` token inside the normal marker must not match the closure marker either
    expect(CLOSURE_REPLY_MARKER.includes('auto-reply:office-closed')).toBe(false)
  })
})

describe('sendOfficeClosedAutoReply', () => {
  beforeEach(() => {
    db.contactLanguage = null
    db.dedupHit = null
    db.likePatterns = []
    db.inserted = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const params = { account_id: 'acc-1', contact_id: 'con-1', topic: 'general' }

  it('a client saved as "Italian" gets the ITALIAN reply (the old exact lookup sent them English)', async () => {
    vi.setSystemTime(TUE_NORMAL)
    db.contactLanguage = 'Italian'
    await sendOfficeClosedAutoReply(params)
    expect(db.inserted).toHaveLength(1)
    expect(String(db.inserted[0].message)).toContain('Siamo attualmente chiusi')
    expect(String(db.inserted[0].message)).toContain(AUTO_REPLY_MARKER)
  })

  it('other ways the language is written: "Italiano" reads Italian; "English", blank and unknown read English', async () => {
    vi.setSystemTime(TUE_NORMAL)
    for (const [language, expected] of [['Italiano', 'Siamo attualmente chiusi'], ['English', 'We are currently closed'], [null, 'We are currently closed'], ['Deutsch', 'We are currently closed']] as const) {
      db.inserted = []
      db.contactLanguage = language
      await sendOfficeClosedAutoReply(params)
      expect(String(db.inserted[0].message), String(language)).toContain(expected)
    }
  })

  it('during the closure it sends the closure reply under the closure marker, in the client\'s language', async () => {
    vi.setSystemTime(WED_CLOSED)
    db.contactLanguage = 'Italian'
    await sendOfficeClosedAutoReply(params)
    expect(db.likePatterns).toEqual([`%${CLOSURE_REPLY_MARKER}%`])
    expect(String(db.inserted[0].message)).toContain(c.copy.it.autoReply)
    expect(String(db.inserted[0].message)).toContain(CLOSURE_REPLY_MARKER)

    db.inserted = []
    db.contactLanguage = 'English'
    await sendOfficeClosedAutoReply(params)
    expect(String(db.inserted[0].message)).toContain(c.copy.en.autoReply)
  })

  it('a normal after-hours reply sent the evening before does not silence the closure reply (different marker)', async () => {
    vi.setSystemTime(WED_CLOSED)
    db.dedupHit = null // nothing under the CLOSURE marker yet, whatever the normal marker found
    await sendOfficeClosedAutoReply(params)
    expect(db.likePatterns[0]).not.toContain('office-closed')
    expect(db.inserted).toHaveLength(1)
  })

  it('throttle: a reply of the same kind in the last 4 hours means no second one', async () => {
    vi.setSystemTime(WED_CLOSED)
    db.dedupHit = { id: 'already' }
    await sendOfficeClosedAutoReply(params)
    expect(db.inserted).toHaveLength(0)
  })

  it('with neither a contact nor an account there is nothing to reply to', async () => {
    vi.setSystemTime(WED_CLOSED)
    await sendOfficeClosedAutoReply({ account_id: null, contact_id: null, topic: null })
    expect(db.inserted).toHaveLength(0)
  })
})
