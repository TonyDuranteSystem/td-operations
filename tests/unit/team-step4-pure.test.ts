import { describe, it, expect, vi } from 'vitest'
import { TEAM_CAPABILITIES, normalizeCapabilities } from '@/lib/portal/team/capabilities'
import { CAPABILITY_LABELS, CAPABILITY_GROUPS, capabilityLabel, describeCapabilities } from '@/lib/portal/team/capability-labels'
import { buildNotice, cleanName, noticeCheckboxLabel, NOTICE_VERSION } from '@/lib/portal/team/notice'
import { verifyOwnerPassword, checkNoticeAcceptance, type PasswordCheckDeps } from '@/lib/portal/team/confirm'
import { buildTeamNoticeEmail, encodeSubject, escapeHtml } from '@/lib/portal/team/notice-email'
import { enqueueTeamNotices, TEAM_NOTICE_JOB, TEAM_NOTICE_MAX_ATTEMPTS } from '@/lib/portal/team/notify'
import { pickManagers, type ManagerLinkRow } from '@/lib/portal/team/may-manage'
import { toggleWithChildren, addsPower } from '@/components/portal/team-manager'

describe('the tick list lives in one place and matches the real powers', () => {
  it('every real power has a label, and every label is a real power', () => {
    expect(CAPABILITY_LABELS.map(c => c.key).sort()).toEqual([...TEAM_CAPABILITIES].sort())
  })
  it('every label has English and Italian words and a known group', () => {
    const groups = new Set(CAPABILITY_GROUPS.map(g => g.key))
    for (const c of CAPABILITY_LABELS) {
      expect(c.en.label.length).toBeGreaterThan(2); expect(c.it.label.length).toBeGreaterThan(2)
      expect(c.en.hint.length).toBeGreaterThan(5); expect(c.it.hint.length).toBeGreaterThan(5)
      expect(groups.has(c.group)).toBe(true)
    }
  })
  it('the "needs" rules on the screen are the same rules the server applies', () => {
    for (const c of CAPABILITY_LABELS) {
      if (!c.parent) continue
      // ticking the option without its parent is dropped by the server
      expect(normalizeCapabilities({ [c.key]: true })).toEqual({})
      // with its parent it is kept
      expect(normalizeCapabilities({ [c.parent]: true, [c.key]: true })[c.key]).toBe(true)
    }
    // and an option never sits under a parent that is itself an option
    for (const c of CAPABILITY_LABELS) if (c.parent) expect(CAPABILITY_LABELS.find(p => p.key === c.parent)?.parent).toBeUndefined()
  })
  it('an option sits right after its parent in the group, in the order the owner reads', () => {
    for (const c of CAPABILITY_LABELS) {
      if (!c.parent) continue
      const parentAt = CAPABILITY_LABELS.findIndex(p => p.key === c.parent)
      expect(parentAt).toBeGreaterThanOrEqual(0)
      expect(CAPABILITY_LABELS[parentAt].group).toBe(c.group)
    }
  })
  it('describeCapabilities lists only what is ON, in reading order and in the chosen language', () => {
    expect(describeCapabilities({ chat: true, documents: true }, 'en')).toEqual(['Documents', 'Chat'])
    expect(describeCapabilities({ chat: true, documents: true }, 'it')).toEqual(['Documenti', 'Chat'])
    expect(describeCapabilities({}, 'en')).toEqual([])
    expect(describeCapabilities(null, 'en')).toEqual([])
    expect(capabilityLabel('request_services', 'en')).toBe('Can ask for new services')
    expect(capabilityLabel('unknown_thing', 'en')).toBe('unknown_thing')
  })
  it('the screen toggles an option off with its parent and reports a grown set', () => {
    expect(toggleWithChildren({ documents: true, answer_decisions: true }, 'documents')).toEqual({ documents: false, answer_decisions: false })
    expect(addsPower({ chat: true }, { chat: true, documents: true })).toBe(true)
    expect(addsPower({ chat: true, documents: true }, { chat: true })).toBe(false)
    expect(addsPower({ chat: true }, { chat: true })).toBe(false)
  })
})

describe('the responsibility notice', () => {
  const base = { memberName: '  Anna   Rossi ', companyName: 'Acme LLC', caps: { documents: true, chat: true } }
  it('says who, which company and which powers, and the lines nobody can give away', () => {
    const n = buildNotice({ ...base, lang: 'en', mode: 'add' })
    expect(n.title).toBe('You are about to give Anna Rossi access to Acme LLC.')
    expect(n.powers).toEqual(['Documents', 'Chat'])
    expect(n.text).toContain('- Documents')
    expect(n.text).toContain('you are responsible for what they do')
    expect(n.text).toContain('Tony Durante LLC does not check their actions')
    expect(n.text).toContain('never sign anything, generate documents, change owners or members, manage the team or change your login')
    expect(n.text).toContain(`[${NOTICE_VERSION}]`)
  })
  it('never guesses a pronoun', () => {
    const t = buildNotice({ ...base, lang: 'en', mode: 'add' }).text.toLowerCase()
    for (const w of [' she ', ' he ', ' her ', ' his ', ' him ']) expect(t.includes(w)).toBe(false)
  })
  it('is available in Italian and for "more powers"', () => {
    const it = buildNotice({ ...base, lang: 'it', mode: 'more' })
    expect(it.title).toBe('Stai per dare a Anna Rossi più poteri in Acme LLC.')
    expect(it.powers).toEqual(['Documenti', 'Chat'])
    expect(it.text).toContain('sei tu il responsabile')
    expect(buildNotice({ ...base, lang: 'en', mode: 'more' }).title).toContain('more powers')
  })
  it('the same facts always give the same words (what the owner saw is what the server saves)', () => {
    expect(buildNotice({ ...base, lang: 'en', mode: 'add' }).text).toBe(buildNotice({ ...base, memberName: 'Anna Rossi', lang: 'en', mode: 'add' }).text)
    expect(buildNotice({ ...base, lang: 'en', mode: 'add' }).text).not.toBe(buildNotice({ ...base, caps: { documents: true }, lang: 'en', mode: 'add' }).text)
  })
  it('handles an empty name, no powers, and a checkbox sentence in both languages', () => {
    const n = buildNotice({ lang: 'en', mode: 'add', memberName: '', companyName: 'Acme LLC', caps: {} })
    expect(n.title).toContain('this person')
    expect(n.text).toContain('(no powers ticked)')
    expect(cleanName('  a   b ')).toBe('a b')
    expect(cleanName(null)).toBe('')
    expect(noticeCheckboxLabel('en')).toContain('responsible')
    expect(noticeCheckboxLabel('it')).toContain('responsabile')
  })
})

describe('verifyOwnerPassword', () => {
  const deps = (over: Partial<PasswordCheckDeps> = {}): PasswordCheckDeps & { fails: string[]; clears: string[] } => {
    const fails: string[] = []; const clears: string[] = []
    return {
      signIn: async (_e, p) => p === 'right',
      checkLimit: () => ({ allowed: true }),
      recordFailure: (k) => { fails.push(k) },
      clearFailures: (k) => { clears.push(k) },
      fails, clears, ...over,
    }
  }
  const call = (password: unknown, d = deps(), email: string | null = 'owner@example.com') => verifyOwnerPassword({ userId: 'u1', email, password }, d)

  it('accepts the right password and clears the wrong-guess counter', async () => {
    const d = deps()
    expect(await call('right', d)).toEqual({ ok: true })
    expect(d.clears).toEqual(['team-confirm:u1'])
  })
  it('refuses a wrong password and counts it', async () => {
    const d = deps()
    expect(await call('nope', d)).toMatchObject({ ok: false, status: 403 })
    expect(d.fails).toEqual(['team-confirm:u1'])
  })
  it('refuses an empty or non-text password without trying', async () => {
    const signIn = vi.fn()
    expect(await call('', deps({ signIn }))).toMatchObject({ ok: false, status: 400 })
    expect(await call(undefined, deps({ signIn }))).toMatchObject({ ok: false, status: 400 })
    expect(await call(12345, deps({ signIn }))).toMatchObject({ ok: false, status: 400 })
    expect(signIn).not.toHaveBeenCalled()
  })
  it('stops after too many wrong passwords and says how long to wait, without trying the password', async () => {
    const signIn = vi.fn()
    const r = await call('right', deps({ signIn, checkLimit: () => ({ allowed: false, retryAfter: 600 }) }))
    expect(r).toMatchObject({ ok: false, status: 429 })
    expect((r as { error: string }).error).toContain('10 minutes')
    expect(signIn).not.toHaveBeenCalled()
  })
  it('treats a sign-in error as a wrong password, and a login with no email as not checkable', async () => {
    expect(await call('right', deps({ signIn: async () => { throw new Error('auth down') } }))).toMatchObject({ ok: false, status: 403 })
    expect(await call('right', deps(), null)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('checkNoticeAcceptance', () => {
  const expected = buildNotice({ lang: 'en', mode: 'add', memberName: 'Anna Rossi', companyName: 'Acme LLC', caps: { chat: true } })
  const good = { notice_accepted: true, notice_version: expected.version, notice_text: expected.text }
  it('accepts exactly the notice the server expects, and keeps the words and the address', () => {
    expect(checkNoticeAcceptance(good, expected, '1.2.3.4')).toEqual({ ok: true, confirmation: { version: expected.version, text: expected.text, ip: '1.2.3.4' } })
  })
  it('refuses when the box was not ticked (true is the only yes)', () => {
    for (const v of [false, undefined, 'true', 1]) expect(checkNoticeAcceptance({ ...good, notice_accepted: v }, expected, null)).toMatchObject({ ok: false, status: 400 })
  })
  it('refuses an old version or different words (the owner must read the current ones)', () => {
    expect(checkNoticeAcceptance({ ...good, notice_version: 'v0' }, expected, null)).toMatchObject({ ok: false, status: 409 })
    expect(checkNoticeAcceptance({ ...good, notice_text: expected.text + ' extra' }, expected, null)).toMatchObject({ ok: false, status: 409 })
    expect(checkNoticeAcceptance({ notice_accepted: true }, expected, null)).toMatchObject({ ok: false, status: 409 })
  })
})

describe('the email to every owner and member', () => {
  const base = {
    language: 'English', recipientFirstName: 'Marco', actorName: 'Marco Bianchi', memberName: 'Anna Rossi', companyName: 'Acme LLC',
    kind: 'added' as const, powers: ['Documents', 'Chat'], newPowers: [] as string[],
    when: new Date('2026-11-18T20:12:00Z'), teamUrl: 'https://portal.tonydurante.us/portal/team',
  }
  it('says who added whom, when (New York time), what they can do, and how to switch them off', () => {
    const e = buildTeamNoticeEmail(base)
    expect(e.subject).toBe('New team access at Acme LLC: Anna Rossi')
    expect(e.html).toContain('Marco Bianchi added Anna Rossi to the Acme LLC team')
    expect(e.html).toContain('3:12') // 20:12 UTC = 3:12 pm in New York
    expect(e.html).toContain('<li>Documents</li><li>Chat</li>')
    expect(e.html).toContain('switch Anna Rossi off')
    expect(e.html).toContain('href="https://portal.tonydurante.us/portal/team"')
  })
  it('carries no secret and no one-click undo: no password, no token, no link other than the fixed Team address', () => {
    const e = buildTeamNoticeEmail(base)
    expect(e.html.toLowerCase()).not.toContain('password')
    const links = [...e.html.matchAll(/href="([^"]+)"/g)].map(m => m[1])
    expect(links).toEqual(['https://portal.tonydurante.us/portal/team'])
    expect(e.text).not.toMatch(/token|undo/i)
  })
  it('is in Italian for an Italian recipient (free-text language is understood)', () => {
    for (const language of ['Italian', 'it', 'Italiano']) {
      const e = buildTeamNoticeEmail({ ...base, language })
      expect(e.subject).toBe('Nuovo accesso al team di Acme LLC: Anna Rossi')
      expect(e.html).toContain('ha aggiunto Anna Rossi')
    }
  })
  it('for more powers, names the new ones', () => {
    const e = buildTeamNoticeEmail({ ...base, kind: 'more', newPowers: ['Can ask for new services'] })
    expect(e.subject).toBe('Team access changed at Acme LLC: Anna Rossi')
    expect(e.html).toContain('gave Anna Rossi more powers')
    expect(e.html).toContain('New powers: Can ask for new services.')
  })
  it('escapes a colleague\'s name typed by an owner, in the body, the greeting and the company', () => {
    const e = buildTeamNoticeEmail({ ...base, memberName: '<script>alert(1)</script>', companyName: 'A&B "LLC"', recipientFirstName: '<b>M</b>' })
    expect(e.html).not.toContain('<script>')
    expect(e.html).not.toContain('<b>M</b>')
    expect(e.html).toContain('&lt;script&gt;')
    expect(e.html).toContain('A&amp;B &quot;LLC&quot;')
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
  it('works with no first name and no powers, and the subject is RFC 2047 encoded for accents', () => {
    const e = buildTeamNoticeEmail({ ...base, recipientFirstName: null, powers: [] })
    expect(e.html).toContain('Hi,')
    expect(e.html).toContain('(nothing)')
    const enc = encodeSubject('Zoë — café')
    expect(enc).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    expect(Buffer.from(enc.slice(10, -2), 'base64').toString()).toBe('Zoë — café')
  })
})

describe('telling the managers (one background job per person)', () => {
  const m = (id: string, email: string | null) => ({ contactId: id, fullName: id, email, language: null })
  const args = { accountId: 'a1', teamMemberId: 't1', kind: 'added' as const, actorContactId: 'c-actor' }
  it('queues one job for each owner or member who has an email, none for TD, with a long retry budget', async () => {
    const queued: Array<Record<string, unknown>> = []
    const n = await enqueueTeamNotices(args, {
      listManagers: async () => [m('c1', 'a@x.com'), m('c2', null), m('c3', 'not-an-email'), m('c4', 'b@x.com')],
      enqueue: async (jobs) => { queued.push(...jobs) },
      now: () => new Date('2026-11-18T20:00:00Z'),
    })
    expect(n).toBe(2)
    expect(queued.map(j => (j.payload as { recipient_contact_id: string }).recipient_contact_id)).toEqual(['c1', 'c4'])
    expect(queued[0]).toMatchObject({ job_type: TEAM_NOTICE_JOB, max_attempts: TEAM_NOTICE_MAX_ATTEMPTS, account_id: 'a1', related_entity_id: 't1' })
    expect(queued[0].payload).toMatchObject({ team_member_id: 't1', kind: 'added', actor_contact_id: 'c-actor', at: '2026-11-18T20:00:00.000Z', added_keys: [] })
    expect(TEAM_NOTICE_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5)
  })
  it('refuses (so the grant is undone) when nobody at all can be told', async () => {
    const enqueue = vi.fn()
    await expect(enqueueTeamNotices(args, { listManagers: async () => [m('c1', null)], enqueue })).rejects.toThrow(/nobody could be told/)
    await expect(enqueueTeamNotices(args, { listManagers: async () => [], enqueue })).rejects.toThrow(/nobody could be told/)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('passes the powers just added for a "more" notice', async () => {
    const queued: Array<Record<string, unknown>> = []
    await enqueueTeamNotices({ ...args, kind: 'more', addedKeys: ['chat'] }, { listManagers: async () => [m('c1', 'a@x.com')], enqueue: async (j) => { queued.push(...j) } })
    expect(queued[0].payload).toMatchObject({ kind: 'more', added_keys: ['chat'] })
  })
})

describe('pickManagers (who is told)', () => {
  const link = (id: string, role: string, over: Partial<ManagerLinkRow> = {}): ManagerLinkRow => ({
    contact_id: id, role, ended_at: null, access_revoked_at: null, access_until: null, contacts: { full_name: id, email: `${id}@x.com`, language: 'en' }, ...over,
  })
  const NOW = new Date('2026-11-18T15:00:00Z')
  it('is exactly the people who may manage the team', () => {
    const got = pickManagers([
      link('owner1', 'owner'), link('member1', 'Member'), link('rep', 'authorized_representative'),
      link('left', 'owner', { ended_at: '2026-01-01T00:00:00Z' }), link('partner', 'Partner - Tax'),
    ], [], NOW)
    expect(got.map(g => g.contactId)).toEqual(['owner1', 'member1'])
    expect(got[0]).toMatchObject({ email: 'owner1@x.com', language: 'en' })
  })
  it('uses the members list when there is one (a stray Member link is not told)', () => {
    const got = pickManagers([link('a', 'Member'), link('stray', 'Member')], [{ contact_id: 'a', start_date: null, end_date: null }], NOW)
    expect(got.map(g => g.contactId)).toEqual(['a'])
  })
})
