/**
 * Antonio, 2026-11-26 (dev job 8d077f3b): (A1) in a person's chat the reply starts where the client's latest message was written, not always on
 * Personal; (B2) a staff message shows who answered (Antonio, Luca, Jodi) instead of "TD Team", in the CRM / TD Social and in the client's portal chat.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  adminSenderName,
  newStaffLabelCache,
  resolveStaffLabels,
  staffFirstName,
  STAFF_LABEL_TTL_MS,
} from '@/lib/portal/staff-display-name'
import { defaultReplyCompanyId, type DefaultReplyMessage } from '@/lib/portal-chats/default-reply-company'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('which first name a staff login shows', () => {
  it('uses the first word of the full name', () => {
    expect(staffFirstName('Luca Degasper', 'luca@tonydurante.us')).toBe('Luca')
    expect(staffFirstName('Jodi', 'jodi@tonydurante.us')).toBe('Jodi')
    expect(staffFirstName('  maría josé López ', 'x@y.us')).toBe('María')
    expect(staffFirstName("O'Brien Pat", 'x@y.us')).toBe("O'Brien")
  })

  it('works the name out from the email when the login has no full name (Antonio\'s own login has none)', () => {
    expect(staffFirstName(null, 'antonio.durante@tonydurante.us')).toBe('Antonio')
    expect(staffFirstName('', 'luca_degasper@tonydurante.us')).toBe('Luca')
    expect(staffFirstName(undefined, 'jodi@tonydurante.us')).toBe('Jodi')
  })

  it('a shared login belongs to no one: the label stays "TD Team"', () => {
    expect(staffFirstName('Support', 'support@tonydurante.us')).toBeNull()
    expect(staffFirstName('Anna Rossi', 'support@tonydurante.us')).toBeNull()
    expect(staffFirstName(null, 'qa-staff@tonydurante.us')).toBeNull()
    expect(staffFirstName('QA Staff', 'someone@tonydurante.us')).toBeNull()
    expect(staffFirstName('Team', null)).toBeNull()
  })

  it('a name that is not a real word, or nothing at all, gives nothing (never a number or a stray letter)', () => {
    expect(staffFirstName(null, '123456@x.us')).toBeNull()
    expect(staffFirstName('X', 'x@y.us')).toBeNull()
    expect(staffFirstName(null, null)).toBeNull()
    expect(staffFirstName('', '')).toBeNull()
    expect(staffFirstName('4ever', null)).toBeNull()
  })
})

describe('what a staff message\'s sender_name says', () => {
  it('the name stored on the row wins, then the one worked out from the login, otherwise nothing', () => {
    expect(adminSenderName('Antonio', 'Luca')).toBe('Antonio')
    expect(adminSenderName('  ', 'Luca')).toBe('Luca')
    expect(adminSenderName(null, 'Jodi')).toBe('Jodi')
    expect(adminSenderName('', '')).toBeNull()
    expect(adminSenderName(undefined, null)).toBeNull()
  })
})

describe('looking staff names up', () => {
  const users: Record<string, { email: string; user_metadata: { full_name?: string } } | null> = {
    a: { email: 'antonio.durante@tonydurante.us', user_metadata: {} },
    l: { email: 'luca@tonydurante.us', user_metadata: { full_name: 'Luca Degasper' } },
    s: { email: 'support@tonydurante.us', user_metadata: { full_name: 'Support' } },
    gone: null,
  }

  it('names each different sender once, ignores blanks and repeats', async () => {
    const lookup = vi.fn(async (id: string) => users[id] ?? null)
    const out = await resolveStaffLabels(['a', 'l', 'a', null, undefined, ''], lookup, newStaffLabelCache())
    expect(out.get('a')).toBe('Antonio')
    expect(out.get('l')).toBe('Luca')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('a shared login and a login that no longer exists both stay "TD Team" (null)', async () => {
    const out = await resolveStaffLabels(['s', 'gone'], async id => users[id] ?? null, newStaffLabelCache())
    expect(out.get('s')).toBeNull()
    expect(out.get('gone')).toBeNull()
  })

  it('remembers an answer for ten minutes, then looks again', async () => {
    const lookup = vi.fn(async (id: string) => users[id] ?? null)
    const cache = newStaffLabelCache()
    await resolveStaffLabels(['a'], lookup, cache, 1_000)
    await resolveStaffLabels(['a'], lookup, cache, 1_000 + STAFF_LABEL_TTL_MS - 1)
    expect(lookup).toHaveBeenCalledTimes(1)
    await resolveStaffLabels(['a'], lookup, cache, 1_000 + STAFF_LABEL_TTL_MS + 1)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('a lookup that fails gives "TD Team" for now and is NOT remembered', async () => {
    let fail = true
    const lookup = vi.fn(async (id: string) => { if (fail) throw new Error('auth down'); return users[id] ?? null })
    const cache = newStaffLabelCache()
    const first = await resolveStaffLabels(['a'], lookup, cache, 5_000)
    expect(first.get('a')).toBeNull()
    fail = false
    const second = await resolveStaffLabels(['a'], lookup, cache, 5_001)
    expect(second.get('a')).toBe('Antonio')
  })

  it('never looks up more than 20 different senders in one go', async () => {
    const lookup = vi.fn(async () => null)
    await resolveStaffLabels(Array.from({ length: 50 }, (_, i) => `u${i}`), lookup, newStaffLabelCache())
    expect(lookup).toHaveBeenCalledTimes(20)
  })
})

describe('where a reply starts in a person\'s chat', () => {
  const companies = [{ id: 'co-1' }, { id: 'co-2' }, { id: 'co-closed', closed: true }]
  const msg = (over: Record<string, unknown>) => ({ sender_type: 'client', sender_context: 'company' as const, account_id: 'co-1', created_at: '2026-11-26T10:00:00Z', ...over })

  it('follows the company the client\'s latest message was written from', () => {
    expect(defaultReplyCompanyId([msg({}), msg({ account_id: 'co-2', created_at: '2026-11-26T11:00:00Z' })], companies)).toBe('co-2')
  })

  it('goes to Personal when the latest client message was written as Personal', () => {
    expect(defaultReplyCompanyId([msg({}), msg({ sender_context: 'person', account_id: null, created_at: '2026-11-26T11:00:00Z' })], companies)).toBeNull()
  })

  it('uses the LATEST client message whatever the order of the list', () => {
    expect(defaultReplyCompanyId([msg({ account_id: 'co-2', created_at: '2026-11-26T11:00:00Z' }), msg({})], companies)).toBe('co-2')
  })

  it('our own replies and automatic notices never move it', () => {
    const list: DefaultReplyMessage[] = [msg({}), { sender_type: 'admin', sender_context: 'person', account_id: null, created_at: '2026-11-26T12:00:00Z' }, { sender_type: 'system', sender_context: null, account_id: 'co-2', created_at: '2026-11-26T13:00:00Z' }]
    expect(defaultReplyCompanyId(list, companies)).toBe('co-1')
  })

  it('a deleted client message is not "the latest thing the client said"', () => {
    expect(defaultReplyCompanyId([msg({}), msg({ account_id: 'co-2', created_at: '2026-11-26T11:00:00Z', deleted_at: '2026-11-26T11:05:00Z' })], companies)).toBe('co-1')
  })

  it('falls back to Personal when nothing safe can be chosen', () => {
    expect(defaultReplyCompanyId([], companies)).toBeNull()
    expect(defaultReplyCompanyId(null, companies)).toBeNull()
    expect(defaultReplyCompanyId([msg({})], [])).toBeNull()
    expect(defaultReplyCompanyId([msg({})], null)).toBeNull()
    expect(defaultReplyCompanyId([msg({ account_id: 'co-other' })], companies)).toBeNull() // a company this chat does not list
    expect(defaultReplyCompanyId([msg({ account_id: 'co-closed' })], companies)).toBeNull() // nothing can be sent to a closed company
    expect(defaultReplyCompanyId([msg({ sender_context: null })], companies)).toBeNull() // an old message with no tag
    expect(defaultReplyCompanyId([msg({ account_id: null })], companies)).toBeNull()
    expect(defaultReplyCompanyId([msg({ created_at: 'not a date' })], companies)).toBeNull()
  })
})

describe('wiring', () => {
  const route = read('app/api/portal/chat/route.ts')
  const page = read('app/(dashboard)/portal-chats/page.tsx')
  const portal = read('components/portal/portal-chat.tsx')

  it('reading messages: a staff row takes its name from the row or the login, never from the row\'s contact', () => {
    expect(route).toContain("msg.sender_type === 'admin'")
    expect(route).toContain('adminSenderName((rest as { sender_name?: string | null }).sender_name, staffNames.get(msg.sender_id as string) ?? null)')
    expect(route).toContain('await staffLabelsFor(')
  })

  it('sending: the staff member\'s first name is kept on the row and returned, so a live message already carries it', () => {
    expect(route).toContain('const staffSenderName = senderType === \'admin\'')
    expect(route).toContain('staffSenderName ? { sender_name: staffSenderName } : {}')
    expect(route).toContain('adminSenderName((msgData as { sender_name?: string | null }).sender_name, staffSenderName)')
  })

  it('the CRM / TD Social bubble shows the name, with "TD Team" only as the fallback', () => {
    expect(page).toContain("{msg.sender_name?.trim() || 'TD Team'}")
    expect(page).not.toMatch(/>TD Team<\/p>/)
  })

  it('the client\'s portal chat shows the name too (bubble and quoted reply), with "Team" as the fallback', () => {
    expect(portal).toContain("msg.sender_type === 'admin' ? (msg.sender_name?.trim() || t('chat.team'))")
    expect(portal).toContain("replyMsg.sender_type === 'admin' ? (replyMsg.sender_name?.trim() || t('chat.team'))")
  })

  it('the reply default follows the client until staff pick; every pick site goes through chooseCompany; a typed reply is never moved', () => {
    expect(page).toContain('const chooseCompany = (id: string | null) => { companyPickedRef.current = true; setSelectedCompanyId(id) }')
    expect((page.match(/chooseCompany\(/g) ?? []).length).toBe(4) // two company chips + two Personal chips (the website row and the pop-up)
    expect(page).toContain('onCompany={chooseCompany}')
    expect(page).toContain('useEffect(() => { companyPickedRef.current = false }, [selectedAccountId, selectedContactId])')
    expect(page).toContain('if (!selectedContactId || selectedAccountId || companyPickedRef.current || replyIsBeingTyped) return')
    expect(page).toContain('defaultReplyCompanyId((messages ?? []).filter(m => m.contact_id === selectedContactId), selectedThreadCompanies)')
  })

  it('WhatsApp keeps its own "TD Team" label (25 Sep decision): this change does not touch it', () => {
    expect(read('lib/messaging/wabridge-outbox.ts')).toContain('export const OUTBOX_TEAM_LABEL = "TD Team"')
  })
})
