import { describe, it, expect } from 'vitest'
import { isTalkPath, isTeamChatPath, teamChatBase, safeTalkNext, withTalkNext, talkUrlFor, TALK_BASE } from '@/lib/talk/paths'

const ORIGIN = 'https://app.example.com'

describe('isTalkPath / isTeamChatPath', () => {
  it('matches the app and its sub-paths only', () => {
    expect(isTalkPath('/talk')).toBe(true)
    expect(isTalkPath('/talk/')).toBe(true)
    expect(isTalkPath('/talk/anything')).toBe(true)
    expect(isTalkPath('/talking')).toBe(false)
    expect(isTalkPath('/talk-sw.js')).toBe(false)
    expect(isTalkPath('/team-chat')).toBe(false)
    expect(isTalkPath('')).toBe(false)
    expect(isTalkPath(null)).toBe(false)
    expect(isTalkPath(undefined)).toBe(false)
  })
  it('knows the CRM Team Chat page', () => {
    expect(isTeamChatPath('/team-chat')).toBe(true)
    expect(isTeamChatPath('/team-chat/x')).toBe(true)
    expect(isTeamChatPath('/team-chats')).toBe(false)
    expect(isTeamChatPath('/talk')).toBe(false)
  })
  it('teamChatBase follows the app the person is in', () => {
    expect(teamChatBase('/talk')).toBe('/talk')
    expect(teamChatBase('/talk/x')).toBe('/talk')
    expect(teamChatBase('/team-chat')).toBe('/team-chat')
    expect(teamChatBase('/accounts')).toBe('/team-chat')
    expect(teamChatBase(null)).toBe('/team-chat')
  })
})

describe('safeTalkNext — the only thing the login page will follow', () => {
  it('accepts TD Talk addresses, with query and hash', () => {
    expect(safeTalkNext('/talk')).toBe('/talk')
    expect(safeTalkNext('/talk?thread=abc&root=def')).toBe('/talk?thread=abc&root=def')
    expect(safeTalkNext('/talk/x#y')).toBe('/talk/x#y')
  })
  it('refuses every other destination (no open redirect)', () => {
    for (const bad of [
      '/', '/accounts', '/team-chat?thread=1', '/talking', '/talk-sw.js',
      '//evil.com', '//evil.com/talk', 'https://evil.com/talk', 'javascript:alert(1)', '/\\evil.com', '\\talk',
      'talk', '', '/talk\n/evil', '/talk\u0000', '/talk\\..\\evil',
    ]) {
      expect(safeTalkNext(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(safeTalkNext(null)).toBeNull()
    expect(safeTalkNext(undefined)).toBeNull()
    expect(safeTalkNext(42)).toBeNull()
    expect(safeTalkNext('/talk?' + 'a'.repeat(2100))).toBeNull()
  })
  it('does not treat a talk path hidden after ? as a talk path', () => {
    expect(safeTalkNext('/evil?x=/talk')).toBeNull()
    expect(safeTalkNext('/evil#/talk')).toBeNull()
  })
})

describe('withTalkNext', () => {
  it('carries a valid TD Talk destination to the next page', () => {
    expect(withTalkNext('/mfa/enroll', '?next=%2Ftalk%3Fthread%3Dabc')).toBe('/mfa/enroll?next=%2Ftalk%3Fthread%3Dabc')
  })
  it('leaves the path alone when there is nothing valid to carry', () => {
    expect(withTalkNext('/mfa/enroll', '')).toBe('/mfa/enroll')
    expect(withTalkNext('/mfa/enroll', '?next=%2Faccounts')).toBe('/mfa/enroll')
    expect(withTalkNext('/mfa/enroll', '?next=https%3A%2F%2Fevil.com')).toBe('/mfa/enroll')
  })
})

describe('talkUrlFor — where a notification tap lands', () => {
  it('turns a CRM Team Chat address into the same chat inside TD Talk', () => {
    expect(talkUrlFor('/team-chat?thread=abc&root=def', ORIGIN)).toBe('/talk?thread=abc&root=def')
    expect(talkUrlFor('/team-chat', ORIGIN)).toBe('/talk')
    expect(talkUrlFor(`${ORIGIN}/team-chat?thread=abc`, ORIGIN)).toBe('/talk?thread=abc')
  })
  it('keeps TD Talk addresses', () => {
    expect(talkUrlFor('/talk?thread=abc', ORIGIN)).toBe('/talk?thread=abc')
  })
  it('sends everything else to plain /talk so a tap can never leave the app', () => {
    for (const other of ['/portal-chats', '/accounts/123', 'https://evil.com/team-chat', '//evil.com', 'javascript:x', '', null, undefined]) {
      expect(talkUrlFor(other, ORIGIN), String(other)).toBe(TALK_BASE)
    }
  })
})
