import { describe, it, expect } from 'vitest'
import { buildPortalChatLink, chatLinkAfterLogin, chatLinkTargetEntity, chatPathForTopic, entityCookieWrites, needsFullPageLoad, resolveChatEntityFromLink } from '@/lib/portal/chat-link'
import type { PortalChatEntity } from '@/lib/portal/queries'

describe('buildPortalChatLink', () => {
  it('carries company and topic, encoding spaces as %20', () => {
    expect(buildPortalChatLink({ accountId: 'acc-1', topic: 'Documenti da firmare' }))
      .toBe('/portal/chat/open?chatlink=1&account=acc-1&topic=Documenti%20da%20firmare')
  })

  it('omits topic for General (null, empty, whitespace)', () => {
    expect(buildPortalChatLink({ accountId: 'acc-1', topic: null })).toBe('/portal/chat/open?chatlink=1&account=acc-1')
    expect(buildPortalChatLink({ accountId: 'acc-1', topic: '' })).toBe('/portal/chat/open?chatlink=1&account=acc-1')
    expect(buildPortalChatLink({ accountId: 'acc-1', topic: '   ' })).toBe('/portal/chat/open?chatlink=1&account=acc-1')
  })

  it('uses the personal marker for a company-less message', () => {
    expect(buildPortalChatLink({ accountId: null })).toBe('/portal/chat/open?chatlink=1&account=personal')
    expect(buildPortalChatLink({})).toBe('/portal/chat/open?chatlink=1&account=personal')
  })

  it('encodes quotes, ampersands and accents so the link cannot break out of an href', () => {
    const link = buildPortalChatLink({ accountId: 'a', topic: 'Tax "2026" & più' })
    expect(link).not.toContain('"')
    expect(link).not.toMatch(/&(?!(topic|account)=)/)
    expect(decodeURIComponent(new URL(`https://x.test${link}`).searchParams.get('topic')!)).toBe('Tax "2026" & più')
  })
})

const company = (id: string, includePersonalNull: boolean): PortalChatEntity =>
  ({ id, kind: 'company', label: id, accountId: id, isShared: !includePersonalNull, includePersonalNull })
const personal: PortalChatEntity = { id: 'personal', kind: 'personal', label: 'Personal', accountId: null, isShared: false, includePersonalNull: false }
const formation: PortalChatEntity = { id: 'f1', kind: 'formation', label: 'New LLC', accountId: null, isShared: false, includePersonalNull: false }

describe('resolveChatEntityFromLink', () => {
  const soleA = company('A', true)
  const sharedB = company('B', false)

  it('switches to the linked company when the saved one is different', () => {
    expect(resolveChatEntityFromLink([soleA, sharedB], 'B', soleA)).toBe(sharedB)
  })

  it('returns null when the linked company is already selected', () => {
    expect(resolveChatEntityFromLink([soleA, sharedB], 'A', soleA)).toBeNull()
  })

  it("ignores an account that is not one of this client's", () => {
    expect(resolveChatEntityFromLink([soleA], 'someone-else', soleA)).toBeNull()
  })

  it('ignores an absent param', () => {
    expect(resolveChatEntityFromLink([soleA], null, soleA)).toBeNull()
    expect(resolveChatEntityFromLink([soleA], undefined, soleA)).toBeNull()
  })

  it('personal: keeps a selection that already shows personal messages (sole-owned company)', () => {
    expect(resolveChatEntityFromLink([soleA, sharedB], 'personal', soleA)).toBeNull()
  })

  it('personal: moves off a shared (multi-member) company, where personal messages are hidden', () => {
    expect(resolveChatEntityFromLink([sharedB, personal], 'personal', sharedB)).toBe(personal)
    expect(resolveChatEntityFromLink([sharedB, soleA], 'personal', sharedB)).toBe(soleA)
    expect(resolveChatEntityFromLink([sharedB, formation], 'personal', sharedB)).toBe(formation)
  })

  it('personal: returns null when no view hosts personal messages', () => {
    expect(resolveChatEntityFromLink([sharedB], 'personal', sharedB)).toBeNull()
  })
})

describe('chatPathForTopic', () => {
  it('General → plain chat', () => {
    expect(chatPathForTopic(null)).toBe('/portal/chat')
    expect(chatPathForTopic('  ')).toBe('/portal/chat')
  })
  it('encodes the topic', () => {
    expect(chatPathForTopic('Documenti da firmare')).toBe('/portal/chat?topic=Documenti%20da%20firmare')
  })
  it('caps the topic at 100 chars like the chat page', () => {
    expect(chatPathForTopic('x'.repeat(150))).toBe(`/portal/chat?topic=${'x'.repeat(100)}`)
  })
})

describe('entityCookieWrites (same state as the company switcher)', () => {
  it('company → account id, clears formation + onboarding', () => {
    expect(entityCookieWrites(company('A', true))).toEqual([
      { name: 'portal_account_id', value: 'A', maxAge: 31536000 },
      { name: 'portal_formation', value: '', maxAge: 0 },
      { name: 'portal_onboarding', value: '', maxAge: 0 },
    ])
  })
  it('personal → the personal sentinel', () => {
    expect(entityCookieWrites(personal)[0]).toEqual({ name: 'portal_account_id', value: 'personal', maxAge: 31536000 })
  })
  it('formation → formation id, clears onboarding, leaves the account cookie alone', () => {
    expect(entityCookieWrites(formation)).toEqual([
      { name: 'portal_formation', value: 'f1', maxAge: 31536000 },
      { name: 'portal_onboarding', value: '', maxAge: 0 },
    ])
  })
})

describe('needsFullPageLoad', () => {
  it('only chat deep links', () => {
    expect(needsFullPageLoad(buildPortalChatLink({ accountId: 'A' }))).toBe(true)
    expect(needsFullPageLoad('/portal/chat')).toBe(false)
    expect(needsFullPageLoad('/portal/sign')).toBe(false)
  })
})

describe('emoji-safe topic trimming', () => {
  it('never splits a surrogate pair (would crash encodeURIComponent)', () => {
    const topic = 'a'.repeat(99) + '📄' + 'b'
    expect(() => chatPathForTopic(topic)).not.toThrow()
    expect(() => buildPortalChatLink({ accountId: 'A', topic })).not.toThrow()
    expect(decodeURIComponent(chatPathForTopic(topic).split('topic=')[1])).toBe('a'.repeat(99) + '📄')
  })
})

describe('chatLinkAfterLogin', () => {
  const U = '6bc4fd3f-7ac1-4019-8186-d50caa75b18c'
  it('rebuilds the chat link from a bounced login query', () => {
    expect(chatLinkAfterLogin(`?chatlink=1&account=${U}&topic=Tax%20Return%202026`))
      .toBe(`/portal/chat/open?chatlink=1&account=${U}&topic=Tax%20Return%202026`)
    expect(chatLinkAfterLogin('?chatlink=1&account=personal')).toBe('/portal/chat/open?chatlink=1&account=personal')
  })
  it('ignores a login without the marker (normal login → portal home)', () => {
    expect(chatLinkAfterLogin('')).toBeNull()
    expect(chatLinkAfterLogin(`?account=${U}`)).toBeNull()
    expect(chatLinkAfterLogin('?reason=suspended')).toBeNull()
  })
  it('rejects a malformed account value', () => {
    expect(chatLinkAfterLogin('?chatlink=1&account=https://evil.com')).toBeNull()
    expect(chatLinkAfterLogin('?chatlink=1&account=../../admin')).toBeNull()
  })
  it('always stays on /portal/chat/open', () => {
    const out = chatLinkAfterLogin('?chatlink=1&account=personal&topic=//evil.com')!
    expect(out.startsWith('/portal/chat/open?')).toBe(true)
  })
})

describe('chatLinkTargetEntity', () => {
  const soleA = company('A', true)
  const sharedB = company('B', false)
  it('returns the linked entity on a switch', () => {
    expect(chatLinkTargetEntity([soleA, sharedB], 'B', soleA)).toBe(sharedB)
  })
  it('returns the CURRENT entity when the link points at it (so cookies are rewritten)', () => {
    expect(chatLinkTargetEntity([soleA, sharedB], 'A', soleA)).toBe(soleA)
    expect(chatLinkTargetEntity([soleA, sharedB], 'personal', soleA)).toBe(soleA)
  })
  it('null for a foreign account or when nothing hosts personal', () => {
    expect(chatLinkTargetEntity([soleA], 'X', soleA)).toBeNull()
    expect(chatLinkTargetEntity([sharedB], 'personal', sharedB)).toBeNull()
    expect(chatLinkTargetEntity([soleA], null, soleA)).toBeNull()
  })
})
