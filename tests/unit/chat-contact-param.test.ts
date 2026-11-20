import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callerContactIdAllowed } from '@/lib/portal/chat-contact-param'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

describe('callerContactIdAllowed — who may name a contact id in a portal chat request', () => {
  it('staff may name any contact (the dashboard reads and answers every thread)', () => {
    expect(callerContactIdAllowed({ isClientUser: false, authContactId: null, callerContactId: OTHER })).toBe(true)
    expect(callerContactIdAllowed({ isClientUser: false, authContactId: ME, callerContactId: OTHER })).toBe(true)
  })

  it('a client may name their OWN contact id', () => {
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: ME, callerContactId: ME })).toBe(true)
  })

  it("a client may NOT name another person's contact id — whatever else the request carries", () => {
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: ME, callerContactId: OTHER })).toBe(false)
  })

  it('a client that names no contact id is unaffected (company threads, the team login screen)', () => {
    for (const none of [null, undefined, '']) {
      expect(callerContactIdAllowed({ isClientUser: true, authContactId: ME, callerContactId: none })).toBe(true)
    }
  })

  it('a team login (client login, no person) may never name a contact id — not even a real one', () => {
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: null, callerContactId: OTHER })).toBe(false)
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: null, callerContactId: ME })).toBe(false)
  })

  it('a team login that names no contact id is unaffected (its own company chat)', () => {
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: null, callerContactId: null })).toBe(true)
    expect(callerContactIdAllowed({ isClientUser: true, authContactId: null, callerContactId: undefined })).toBe(true)
  })
})

describe('the chat route uses the rule on BOTH the read and the send', () => {
  // The route is too large to run without a database, so this pins the wiring: the rule must be called in GET and in POST,
  // before the thread is chosen / the message is stored. If someone removes a call, this fails.
  const src = readFileSync(join(process.cwd(), 'app/api/portal/chat/route.ts'), 'utf8')
  const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'))
  const post = src.slice(src.indexOf('export async function POST'))

  it('imports the rule', () => {
    expect(src).toMatch(/from '@\/lib\/portal\/chat-contact-param'/)
  })

  it('the read refuses a contact id that is not the caller\'s, before any query is built', () => {
    const rule = get.indexOf('callerContactIdAllowed(')
    expect(rule).toBeGreaterThan(-1)
    expect(get.slice(rule, rule + 260)).toContain('callerContactId: contactIdParam')
    expect(rule).toBeLessThan(get.indexOf("supabaseAdmin\n    .from('portal_messages')"))
  })

  it('the send refuses a contact id that is not the caller\'s, before the sender is resolved', () => {
    const rule = post.indexOf('callerContactIdAllowed(')
    expect(rule).toBeGreaterThan(-1)
    expect(post.slice(rule, rule + 260)).toContain('callerContactId: bodyContactId')
    expect(rule).toBeLessThan(post.indexOf('resolvedContactId = bodyContactId || authContactId'))
  })
})
