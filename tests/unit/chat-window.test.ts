import { describe, it, expect } from 'vitest'
import { chatWindowHref, chatWindowTitle } from '@/lib/windows/chat-window'
import { isWindowableUrl } from '@/lib/windows/window-model'

describe('chatWindowHref', () => {
  it('a person opens their personal thread', () => {
    expect(chatWindowHref({ contactId: 'c1' })).toBe('/portal-chats?contact=c1')
  })
  it('a company opens its thread', () => {
    expect(chatWindowHref({ accountId: 'a1' })).toBe('/portal-chats?account=a1')
  })
  it('a company wins when both are given (the page reads the company first)', () => {
    expect(chatWindowHref({ contactId: 'c1', accountId: 'a1' })).toBe('/portal-chats?account=a1')
  })
  it('with neither, it is the plain Portal Chats page', () => {
    expect(chatWindowHref({})).toBe('/portal-chats')
    expect(chatWindowHref({ contactId: null, accountId: null })).toBe('/portal-chats')
  })
  it('encodes an id so it can never break out of the address', () => {
    expect(chatWindowHref({ contactId: 'a&b=c' })).toBe('/portal-chats?contact=a%26b%3Dc')
  })
  it('every address it makes is one a floating window may show', () => {
    for (const h of [chatWindowHref({ contactId: 'c1' }), chatWindowHref({ accountId: 'a1' }), chatWindowHref({})]) expect(isWindowableUrl(h)).toBe(true)
  })
})

describe('chatWindowTitle', () => {
  it('names the person or company', () => expect(chatWindowTitle('Ada Rossi')).toBe('Chat — Ada Rossi'))
  it('trims, and falls back to a plain title', () => {
    expect(chatWindowTitle('  Ada  ')).toBe('Chat — Ada')
    expect(chatWindowTitle('   ')).toBe('Chat')
    expect(chatWindowTitle(null)).toBe('Chat')
    expect(chatWindowTitle(undefined)).toBe('Chat')
  })
})
